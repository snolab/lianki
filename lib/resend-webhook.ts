/**
 * Resend's webhook: bounces and complaints for the mail Lianki sends
 * (docs/payments.md, "Invite by email"; docs/secrets-and-auth.md, "Resend
 * webhook"). Pushed by Resend to POST /api/email/resend-webhook; nothing polls.
 *
 * - Signed with Svix: HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}`,
 *   keyed by the base64 after `whsec_` in RESEND_WEBHOOK_SECRET; `svix-signature`
 *   is a space-separated list of `v1,<base64>`. Verified with WebCrypto's
 *   `verify` (constant time). A timestamp more than 5 minutes off is refused,
 *   and a delivery id already handled by this isolate is answered without
 *   touching D1 again — the handling is idempotent anyway, so a replay inside
 *   the window changes nothing.
 * - No secret → 503 (logged once per isolate); a bad signature → 401.
 * - `email.bounced` (hard bounces only: Resend's `bounce.type` "Permanent", or
 *   none given) and `email.complained` put the recipient's hash in
 *   `invite_email_suppression` (reason bounce / complaint), so no invite mail
 *   goes there again. A complaint about an invite mail — named by the
 *   `invite_log` tag every invite carries, or by Resend's email id — also
 *   stamps that log row's `reportedAt`, which counts toward the inviter's
 *   report block. Every other event: 204, ignored.
 * - The send log (lib/mail-log, docs/mail-templates.md "Send log"): the mail an
 *   event names — by its `mail_log` tag, else Resend's email id — moves to
 *   delivered (`email.delivered`), bounced (a hard bounce) or complained.
 *   Statuses only move forward. A delivery for no logged mail: 204.
 * - No body and no address is ever logged.
 */
import type { D1Like } from "@/lib/d1/types";
import { applyEventStatus, findForEvent } from "@/lib/mail-log/store";
import { MAIL_LOG_TAG } from "@/lib/mail-log/vars";
import { INVITE_LOG_TAG } from "@/lib/referrals/email-invite-config";
import { recipientHash } from "@/lib/referrals/recipient-hash";

export type ResendWebhookDeps = {
  /** RESEND_WEBHOOK_SECRET (`whsec_…`). */
  secret: () => string | undefined;
  db: () => D1Like;
  now?: () => number;
};

/** How far a delivery's timestamp may be from our clock. */
export const TOLERANCE_MS = 5 * 60_000;
/** Larger bodies are not Resend events. */
const MAX_BODY = 256 * 1024;

const enc = new TextEncoder();
const logEvent = (event: string, extra: Record<string, unknown> = {}) =>
  console.error(JSON.stringify({ event, ...extra }));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// ── Signature ─────────────────────────────────────────────────────────────────

const keys = new Map<string, Promise<CryptoKey | null>>();

const fromB64 = (s: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

/** The HMAC key in a `whsec_<base64>` secret, or null when it is not one. */
export function signingKey(secret: string | undefined): Promise<CryptoKey | null> {
  const s = secret?.trim() ?? "";
  let k = keys.get(s);
  if (!k) {
    const raw = fromB64(s.startsWith("whsec_") ? s.slice(6) : s);
    k =
      raw && raw.length >= 16
        ? crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["verify"])
        : Promise.resolve(null);
    keys.set(s, k);
  }
  return k;
}

export type SvixHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

export type Verdict = "ok" | "bad" | "stale";

/** Check one delivery's Svix signature against the key. */
export async function verifySvix(
  key: CryptoKey,
  h: SvixHeaders,
  body: string,
  now: number,
): Promise<Verdict> {
  if (!h.id || !h.timestamp || !h.signature) return "bad";
  if (h.id.length > 256 || h.signature.length > 4096) return "bad";
  if (!/^\d{1,12}$/.test(h.timestamp)) return "bad";
  if (Math.abs(now - Number(h.timestamp) * 1000) > TOLERANCE_MS) return "stale";
  const data = enc.encode(`${h.id}.${h.timestamp}.${body}`);
  for (const part of h.signature.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0 || part.slice(0, comma) !== "v1") continue;
    const sig = fromB64(part.slice(comma + 1));
    if (!sig || sig.length !== 32) continue;
    if (await crypto.subtle.verify("HMAC", key, sig, data)) return "ok";
  }
  return "bad";
}

// ── Replays (per isolate, cheap) ──────────────────────────────────────────────

const seen = new Map<string, number>();
let warnedMissing = false;

function alreadySeen(id: string, now: number): boolean {
  const at = seen.get(id);
  return at !== undefined && now - at <= TOLERANCE_MS;
}

const SEEN_MAX = 1000;

function remember(id: string, now: number) {
  if (seen.size >= SEEN_MAX) {
    for (const [k, at] of seen) if (now - at > TOLERANCE_MS) seen.delete(k);
    // Still full: drop the oldest (a Map iterates in insertion order).
    for (const k of seen.keys()) {
      if (seen.size < SEEN_MAX) break;
      seen.delete(k);
    }
  }
  seen.set(id, now);
}

/** Tests only: forget every remembered delivery and cached key. */
export function resetResendWebhookState() {
  seen.clear();
  keys.clear();
  warnedMissing = false;
}

// ── Events ────────────────────────────────────────────────────────────────────

type ResendEvent = {
  type?: unknown;
  data?: {
    email_id?: unknown;
    to?: unknown;
    tags?: unknown;
    bounce?: { type?: unknown } | null;
  } | null;
};

const LOG_ID = /^[0-9a-f-]{36}$/;

/** A log id tag in an event's tags: Resend sends an object; an array of {name, value} is read too. */
function logTag(tags: unknown, name: string): string | null {
  let v: unknown;
  if (Array.isArray(tags)) v = tags.find((t) => (t as { name?: unknown })?.name === name)?.value;
  else if (tags && typeof tags === "object") v = (tags as Record<string, unknown>)[name];
  return typeof v === "string" && LOG_ID.test(v) ? v : null;
}

/** The invite log id in an event's tags. */
export const inviteLogTag = (tags: unknown) => logTag(tags, INVITE_LOG_TAG);

/** The send log id in an event's tags (lib/mail-log/send.ts adds it to every mail). */
export const mailLogTag = (tags: unknown) => logTag(tags, MAIL_LOG_TAG);

type LogRow = { id: string; recipientHash: string };

/** The invite mail an event is about: by its tag, else by Resend's email id. */
async function linkedInvite(db: D1Like, data: NonNullable<ResendEvent["data"]>) {
  const tag = inviteLogTag(data.tags);
  if (tag)
    return db
      .prepare("SELECT id, recipientHash FROM invite_email_log WHERE id = ?1")
      .bind(tag)
      .first<LogRow>();
  const emailId = data.email_id;
  if (typeof emailId === "string" && emailId && emailId.length <= 128)
    return db
      .prepare("SELECT id, recipientHash FROM invite_email_log WHERE providerId = ?1 LIMIT 1")
      .bind(emailId)
      .first<LogRow>();
  return null;
}

const recipients = (to: unknown): string[] =>
  (Array.isArray(to) ? to : typeof to === "string" ? [to] : [])
    .filter((a): a is string => typeof a === "string" && a.length <= 320 && a.includes("@"))
    .slice(0, 50);

/**
 * Apply one verified event. Idempotent: a repeat writes nothing new. Returns
 * what was done, for the reply; never an address.
 */
export async function applyResendEvent(
  db: D1Like,
  event: ResendEvent,
  now: number,
): Promise<{ status: "ignored" } | { status: "done"; reason: string; linked: boolean }> {
  const type = event?.type;
  const data = event?.data;
  if (
    (type !== "email.bounced" && type !== "email.complained" && type !== "email.delivered") ||
    !data
  )
    return { status: "ignored" };
  // The send log's row (lib/mail-log): by its tag, else by Resend's email id.
  const emailId =
    typeof data.email_id === "string" && data.email_id && data.email_id.length <= 128
      ? data.email_id
      : null;
  const mailId = await findForEvent(db, mailLogTag(data.tags), emailId);
  if (type === "email.delivered") {
    if (!mailId) return { status: "ignored" };
    await applyEventStatus(db, { id: mailId }, "delivered", now);
    return { status: "done", reason: "delivered", linked: true };
  }
  if (type === "email.bounced") {
    // Only a hard bounce suppresses; a mailbox that was full may take mail later.
    const kind = data.bounce?.type;
    if (kind !== undefined && kind !== null && kind !== "Permanent") return { status: "ignored" };
  }
  const reason = type === "email.bounced" ? "bounce" : "complaint";
  if (mailId)
    await applyEventStatus(
      db,
      { id: mailId },
      reason === "bounce" ? "bounced" : "complained",
      now,
      reason === "bounce" ? "hard-bounce" : "complaint",
    );
  const log = await linkedInvite(db, data);
  const hashes = new Set<string>();
  if (log) hashes.add(log.recipientHash);
  for (const to of recipients(data.to)) hashes.add(await recipientHash(to));
  for (const hash of hashes)
    // A complaint is stronger than an unsubscribe or a bounce; abuse stays.
    await db
      .prepare(
        `INSERT INTO invite_email_suppression (recipientHash, reason, createdAt) VALUES (?1, ?2, ?3)
         ON CONFLICT(recipientHash) DO UPDATE SET reason = ?2
         WHERE ?2 = 'complaint' AND reason IN ('unsubscribe', 'bounce')`,
      )
      .bind(hash, reason, now)
      .run();
  if (log && reason === "complaint")
    // Counts toward the inviter's report block (EMAIL_INVITE.blockAfterReports).
    await db
      .prepare("UPDATE invite_email_log SET reportedAt = ?2 WHERE id = ?1 AND reportedAt IS NULL")
      .bind(log.id, now)
      .run();
  return { status: "done", reason, linked: !!log };
}

/** POST /api/email/resend-webhook. */
export async function handleResendWebhook(req: Request, d: ResendWebhookDeps): Promise<Response> {
  const now = (d.now ?? Date.now)();
  const key = await signingKey(d.secret());
  if (!key) {
    if (!warnedMissing) logEvent("resend-webhook.no-secret");
    warnedMissing = true;
    return json({ error: "not-configured" }, 503);
  }
  // The signature covers the exact bytes: read the raw text before parsing.
  const body = await req.text().catch(() => "");
  if (body.length > MAX_BODY) return json({ error: "too-large" }, 413);
  const h: SvixHeaders = {
    id: req.headers.get("svix-id"),
    timestamp: req.headers.get("svix-timestamp"),
    signature: req.headers.get("svix-signature"),
  };
  const verdict = await verifySvix(key, h, body, now);
  if (verdict !== "ok") {
    logEvent("resend-webhook.refused", { why: verdict });
    return json({ error: "bad-signature" }, 401);
  }
  if (alreadySeen(h.id!, now)) return json({ status: "duplicate" });
  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    return json({ error: "invalid" }, 400);
  }
  const res = await applyResendEvent(d.db(), event, now);
  remember(h.id!, now);
  if (res.status === "ignored") return new Response(null, { status: 204 });
  logEvent(`resend-webhook.${res.reason}`, { linked: res.linked });
  return json(res);
}

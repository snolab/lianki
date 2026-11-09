/**
 * One-click unsubscribe for an `optional` mail kind (./kinds.ts;
 * docs/mail-templates.md, "Unsubscribe"). No sign-in: the token
 * (./unsubscribe-token.ts) names the account and the kind.
 *
 * POST /api/mail/unsubscribe
 * - RFC 8058 one-click: `?t=<token>`, form body `List-Unsubscribe=One-Click`
 *   (sent by the mail client) → that kind off;
 * - the unsubscribe page: same-origin JSON `{token, action}`, action
 *   `unsubscribe` (off) or `undo` (back on).
 * GET (a person, or a client that only GETs) changes nothing: 303 to the page.
 *
 * The switch is the account's synced pref (lib/prefs/schema.ts `mail.*`),
 * written with a fresh clock, so /my/preferences shows it on every device;
 * the send path reads it (lib/mail-log/send.ts).
 */
import type { D1Like } from "@/lib/d1/types";
import { UserPrefsD1Repo } from "@/lib/repos/userPrefsD1";
import { sameOriginJson } from "@/lib/security/same-origin";
import { clientIp, hit, ipKey, type ThrottleDb } from "@/lib/security/throttle";
import { MAIL_KINDS, type MailKind } from "./kinds";
import { mailLocaleOf } from "./locales";
import { unsubscribeLinks, verifyUnsubscribe } from "./unsubscribe-token";

/** Unsubscribe requests per IP per window (one person clicks a few times; a scanner more). */
export const UNSUBSCRIBE_PER_IP = { max: 30, windowMs: 10 * 60 * 1000 } as const;

export type UnsubscribeDeps = {
  db: () => (D1Like & ThrottleDb) | null;
  secret: () => string | undefined;
  origin: () => string;
  now?: () => number;
  /** The classification table; tests pass their own. */
  kinds?: Record<string, MailKind>;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Switch `kind` off (or back on) for `userId`. False when the kind has no one-click switch. */
export async function setKindOn(
  db: D1Like,
  userId: string,
  kind: string,
  on: boolean,
  now: number,
  kinds: Record<string, MailKind> = MAIL_KINDS,
): Promise<boolean> {
  const k = kinds[kind];
  if (!k || k.optOut !== "one-click" || !k.pref) return false;
  const res = await new UserPrefsD1Repo(db, userId, () => now).write([
    { key: k.pref, value: on, hlc: { timestamp: now, counter: 0, deviceId: "mail-unsubscribe" } },
  ]);
  return !res.rejected.length;
}

export async function unsubscribePost(req: Request, d: UnsubscribeDeps): Promise<Response> {
  const now = (d.now ?? Date.now)();
  const db = d.db();
  if (!db) return json({ error: "unavailable" }, 503);
  const ip = await hit(
    db,
    ipKey("mail-unsubscribe", clientIp(req.headers)),
    UNSUBSCRIBE_PER_IP,
    now,
  );
  if (!ip.allowed) return json({ error: "rate-limited" }, 429);

  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  let token: unknown;
  let on = false;
  if (type === "application/json") {
    if (!sameOriginJson(req)) return json({ error: "forbidden" }, 403);
    const body = (await req.json().catch(() => null)) as {
      token?: unknown;
      action?: unknown;
    } | null;
    token = body?.token;
    if (body?.action === "undo") on = true;
    else if (body?.action !== "unsubscribe") return json({ error: "invalid" }, 400);
  } else if (type === "application/x-www-form-urlencoded" || type === "multipart/form-data") {
    const form = await req.formData().catch(() => null);
    if (form?.get("List-Unsubscribe") !== "One-Click") return json({ error: "invalid" }, 400);
    token = new URL(req.url).searchParams.get("t");
  } else {
    return json({ error: "invalid" }, 400);
  }
  const who = await verifyUnsubscribe(d.secret(), token);
  if (!who || !(await setKindOn(db, who.userId, who.kind, on, now, d.kinds)))
    return json({ error: "invalid" }, 400);
  console.log(
    JSON.stringify({ event: on ? "mail.resubscribed" : "mail.unsubscribed", kind: who.kind }),
  );
  return json({ status: "done", kind: who.kind, on });
}

/** GET on the one-click URL: the page, nothing changed. */
export function unsubscribeGet(req: Request, origin: string): Response {
  const u = new URL(req.url);
  const { pageUrl } = unsubscribeLinks(
    origin,
    mailLocaleOf(u.searchParams.get("lang")) ?? "en",
    u.searchParams.get("t") ?? "",
  );
  return new Response(null, { status: 303, headers: { location: pageUrl } });
}

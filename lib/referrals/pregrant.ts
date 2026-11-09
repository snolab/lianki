/**
 * Pre-grants: Pro days an admin gives an address before it has an account
 * (owner, 2026-11-09 13:42 JST). Table `pending_membership`
 * (db/migrations/0063_pending_membership.sql); docs/payments.md, "Pre-grants".
 *
 * - The panel on /dev/users pastes a list (one address per line, or CSV
 *   `email,days,note`), previews it here — invalid, duplicate, already
 *   pending, already has an account — and applies it. The server re-runs the
 *   preview on apply; the client's view of the rows is never trusted.
 * - An address that already has an account gets no pending row: the admin
 *   either grants it at once (same grantPro path, reason 'pregrant-direct') or
 *   skips it.
 * - **Claim**: when an account signs in (better-auth `session.create` hook in
 *   auth-impl.ts) and its email is VERIFIED, every open row for its canonical
 *   address is claimed and granted via `grantPro` (membership_grant, reason
 *   'pregrant', refId 'pregrant:<id>' — UNIQUE, so once only). An unverified
 *   address never claims: anyone can type an address at sign-up.
 * - Expired or revoked rows never apply. A row is taken by one conditional
 *   UPDATE before the grant, so a revoke racing a claim lands on one side.
 *
 * Every create, revoke, direct grant and claim writes a security_audit row
 * (ids and a masked address only).
 */
import { canonicalEmail } from "@/lib/canonical-email";
import type { D1Like } from "@/lib/d1/types";
import { audit, type AuditDb } from "@/lib/security/audit-log";
import { sha256Hex } from "@/lib/security/throttle";
import { maskEmail } from "./rules";
import { grantPro, type D1WithBatch } from "./store";

export const PREGRANT = {
  /** Lines one apply may hold. */
  maxLines: 500,
  maxDays: 3660,
  maxNote: 200,
} as const;

export type PregrantDb = D1WithBatch & AuditDb;

/** The matching key: never the address itself. Prefixed, so it matches no other table's hash. */
export const pregrantHash = (email: string) => sha256Hex(`pregrant:${canonicalEmail(email)}`);

/** One address: something@domain.tld, no spaces, one "@". Lowercased and trimmed. */
export function validEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>".]{2,}$/.test(e)) return null;
  return e;
}

export type ParsedLine = {
  /** 1-based line number in the pasted text. */
  line: number;
  raw: string;
  email: string | null;
  days: number | null;
  note: string | null;
  error?: "email" | "days";
};

/**
 * One entry per non-blank line: `email`, or `email,days`, or `email,days,note`
 * (the note may itself hold commas). Days and note fall back to the defaults.
 * A `#` comment line and an `email,days,note` header are skipped.
 */
export function parsePregrantList(
  text: string,
  defaults: { days: number; note?: string | null },
): ParsedLine[] {
  const out: ParsedLine[] = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const raw = rawLine.trim();
    if (!raw || raw.startsWith("#") || /^e-?mail\s*(,|$)/i.test(raw)) return;
    const [first, second, ...rest] = raw.split(/[,\t]/);
    const email = validEmail(first ?? "");
    const daysText = second?.trim() ?? "";
    const days = daysText ? Number(daysText) : defaults.days;
    const noteText = rest.join(",").trim();
    const note = (noteText || defaults.note?.trim() || null)?.slice(0, PREGRANT.maxNote) ?? null;
    const okDays = Number.isInteger(days) && days >= 1 && days <= PREGRANT.maxDays;
    out.push({
      line: i + 1,
      raw,
      email,
      days: okDays ? days : null,
      note,
      ...(!email ? { error: "email" as const } : !okDays ? { error: "days" as const } : {}),
    });
  });
  return out;
}

export type PreviewRow = ParsedLine & {
  status: "ok" | "invalid" | "duplicate" | "pending" | "account";
  /** For "account": the existing account (the exact address first, else the oldest alias). */
  account?: { id: string; email: string };
};

type Account = { id: string; email: string; createdAt: string };

async function accountsFor(d1: D1Like, email: string): Promise<Account[]> {
  const { results } = await d1
    .prepare(
      "SELECT id, email, createdAt FROM user WHERE email_canonical = ?1 OR lower(email) = ?2 ORDER BY createdAt",
    )
    .bind(canonicalEmail(email), email)
    .all<Account>();
  return results;
}

/** Classify every line: what applying would do with it. Writes nothing. */
export async function previewPregrants(
  d1: D1Like,
  text: string,
  defaults: { days: number; note?: string | null },
): Promise<PreviewRow[]> {
  const seen = new Set<string>();
  const rows: PreviewRow[] = [];
  for (const p of parsePregrantList(text, defaults)) {
    if (p.error || !p.email) {
      rows.push({ ...p, status: "invalid" });
      continue;
    }
    const canonical = canonicalEmail(p.email);
    if (seen.has(canonical)) {
      rows.push({ ...p, status: "duplicate" });
      continue;
    }
    seen.add(canonical);
    const accounts = await accountsFor(d1, p.email);
    if (accounts.length) {
      const a = accounts.find((x) => x.email.toLowerCase() === p.email) ?? accounts[0];
      rows.push({ ...p, status: "account", account: { id: a.id, email: a.email } });
      continue;
    }
    const open = await d1
      .prepare(
        "SELECT id FROM pending_membership WHERE email_hash = ? AND claimed_at IS NULL AND revoked_at IS NULL",
      )
      .bind(await pregrantHash(p.email))
      .first();
    rows.push({ ...p, status: open ? "pending" : "ok" });
  }
  return rows;
}

export type ApplyInput = {
  text: string;
  days: number;
  note?: string | null;
  /** When an unclaimed grant lapses (ISO); null: never. Must be in the future. */
  grantExpiresAt?: string | null;
  /** Addresses with an account to grant at once; every other such address is skipped. */
  direct?: string[];
  /** One per click of Apply: a retried request grants each direct address once. */
  key: string;
};

export type ApplyResult = {
  created: number;
  granted: number;
  skipped: number;
  rows: (PreviewRow & { result: "created" | "granted" | "skipped" })[];
};

export type InputError = "days" | "expiry" | "key" | "too many";

/** Shared checks for the route: null when fine. */
export function checkInput(input: Partial<ApplyInput>, now: Date): InputError | null {
  const days = Number(input.days);
  if (!Number.isInteger(days) || days < 1 || days > PREGRANT.maxDays) return "days";
  if (input.grantExpiresAt != null) {
    const t = Date.parse(String(input.grantExpiresAt));
    if (!Number.isFinite(t) || t <= now.getTime()) return "expiry";
  }
  if (input.key !== undefined && !/^[\w-]{8,64}$/.test(String(input.key))) return "key";
  if (String(input.text ?? "").split(/\r?\n/).length > PREGRANT.maxLines) return "too many";
  return null;
}

const isUnique = (e: unknown) => /UNIQUE|PRIMARY KEY/i.test(String(e));

/** Create the pending rows and the chosen direct grants. Idempotent per `key`. */
export async function applyPregrants(
  d1: PregrantDb,
  by: { id: string },
  input: ApplyInput,
  now = new Date(),
): Promise<ApplyResult> {
  const at = now.toISOString();
  const expires = input.grantExpiresAt ? new Date(input.grantExpiresAt).toISOString() : null;
  const direct = new Set((input.direct ?? []).map((e) => e.trim().toLowerCase()));
  const preview = await previewPregrants(d1, input.text, { days: input.days, note: input.note });
  const result: ApplyResult = { created: 0, granted: 0, skipped: 0, rows: [] };
  for (const r of preview) {
    let outcome: "created" | "granted" | "skipped" = "skipped";
    if (r.status === "ok" && r.email && r.days) {
      const id = crypto.randomUUID();
      try {
        await d1
          .prepare(
            "INSERT INTO pending_membership (id, email_hash, email, days, grant_expires_at, granted_by, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(id, await pregrantHash(r.email), r.email, r.days, expires, by.id, r.note, at)
          .run();
        outcome = "created";
        await audit(d1, {
          kind: "pregrant.create",
          actor: by.id,
          subject: id,
          detail: `${maskEmail(r.email)} ${r.days}d`,
        });
      } catch (e) {
        // Another apply made the open row for this person first.
        if (!isUnique(e)) throw e;
      }
    } else if (r.status === "account" && r.account && r.days && direct.has(r.email ?? "")) {
      const refId = `pregrant-direct:${input.key}:${r.account.id}`;
      if (await grantPro(d1, r.account.id, r.days, "pregrant-direct", refId, now)) {
        outcome = "granted";
        await audit(d1, {
          kind: "pregrant.direct",
          actor: by.id,
          subject: r.account.id,
          detail: `${r.days}d`,
        });
      }
    }
    result[outcome]++;
    result.rows.push({ ...r, result: outcome });
  }
  return result;
}

export type PendingRow = {
  id: string;
  email: string;
  days: number;
  grantExpiresAt: string | null;
  note: string | null;
  createdAt: string;
};

/** Open grants (not claimed, not revoked), newest first; expired ones included, so they can be revoked. */
export async function listPending(d1: D1Like): Promise<PendingRow[]> {
  const { results } = await d1
    .prepare(
      `SELECT id, email, days, grant_expires_at AS grantExpiresAt, note, created_at AS createdAt
         FROM pending_membership WHERE claimed_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1000`,
    )
    .all<PendingRow>();
  return results;
}

/** Revoke an open grant. False when it was already claimed, revoked, or never existed. */
export async function revokePregrant(
  d1: PregrantDb,
  by: { id: string },
  id: string,
  now = new Date(),
): Promise<boolean> {
  const row = await d1
    .prepare(
      "UPDATE pending_membership SET revoked_at = ? WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL RETURNING id",
    )
    .bind(now.toISOString(), id)
    .first();
  if (!row) return false;
  await audit(d1, { kind: "pregrant.revoke", actor: by.id, subject: id });
  return true;
}

/**
 * The claim, run on sign-in: grant every open, unexpired row for this
 * account's canonical address — only when the address is verified. Safe to
 * call on every sign-in: a claimed row is never taken again, and the grant's
 * UNIQUE (reason, refId) holds even if two sign-ins race. Returns the days given.
 */
export async function claimPregrants(d1: PregrantDb, userId: string, now = new Date()) {
  const user = await d1
    .prepare("SELECT id, email, emailVerified FROM user WHERE id = ?")
    .bind(userId)
    .first<{ id: string; email: string; emailVerified: number | boolean | null }>();
  if (!user?.email || !user.emailVerified) return 0;
  const at = now.toISOString();
  const { results } = await d1
    .prepare(
      `SELECT id, days FROM pending_membership
        WHERE email_hash = ? AND claimed_at IS NULL AND revoked_at IS NULL
          AND (grant_expires_at IS NULL OR grant_expires_at > ?)`,
    )
    .bind(await pregrantHash(user.email), at)
    .all<{ id: string; days: number }>();
  let given = 0;
  for (const r of results) {
    // Take the row first, with the same conditions: a revoke or expiry that
    // landed since the read wins, and a second sign-in finds nothing to take.
    const took = await d1
      .prepare(
        `UPDATE pending_membership SET claimed_at = ?1, claimed_user_id = ?2
          WHERE id = ?3 AND claimed_at IS NULL AND revoked_at IS NULL
            AND (grant_expires_at IS NULL OR grant_expires_at > ?1) RETURNING id`,
      )
      .bind(at, user.id, r.id)
      .first();
    if (!took) continue;
    try {
      if (await grantPro(d1, user.id, r.days, "pregrant", `pregrant:${r.id}`, now)) given += r.days;
    } catch (e) {
      // The grant failed outright: give the row back so the next sign-in retries.
      await d1
        .prepare(
          "UPDATE pending_membership SET claimed_at = NULL, claimed_user_id = NULL WHERE id = ?",
        )
        .bind(r.id)
        .run()
        .catch(() => {});
      throw e;
    }
    await audit(d1, {
      kind: "pregrant.claim",
      actor: user.id,
      subject: r.id,
      detail: `${r.days}d`,
    });
  }
  return given;
}

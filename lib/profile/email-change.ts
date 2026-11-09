/**
 * Changing the sign-in address (docs/secrets-and-auth.md, "Changing the email"):
 * a link goes to the NEW address, a notice to the OLD one, and nothing changes
 * until the link is confirmed. Then the user row and every email-keyed table move
 * in ONE D1 batch (one transaction), so an account is never split between two
 * addresses. All of this is ours rather than better-auth's /change-email: that
 * one writes the user row alone with no hook inside its transaction, and applies
 * on a GET, which a mail scanner opening the link would trigger.
 *
 * Sessions stay valid, as with better-auth's flow: a session points at the user id.
 *
 * Whether an address is taken is never told to the person asking: the answer and
 * the mails sent are the same shape, and only the mailbox's holder reads the truth.
 * No log line holds an address or a token.
 */
import { canonicalEmail } from "@/lib/canonical-email";
import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import type { SendEmailInput } from "@/lib/email";
import { maskEmail } from "@/lib/referrals/rules";
import { audit, type AuditDb } from "@/lib/security/audit-log";
import { sameOriginJson } from "@/lib/security/same-origin";
import {
  accountKey,
  clientIp,
  hit,
  ipKey,
  sha256Hex,
  type ThrottleDb,
} from "@/lib/security/throttle";
import { readGrants, type PermissionReadDb } from "@/lib/account-permission";
import { PROFILE } from "./config";
import { changeMail, changeMailLocale } from "./email-mail";

/**
 * Every table keyed by the user's address (columns named `email`). Each moves
 * with the user row. unit/email-change.test.ts fails when a migration adds a table
 * with an `email` column that is on neither this list nor the test's "not a key" one.
 */
export const EMAIL_KEYED_TABLES = [
  "fsrs_notes",
  "roadmap_goals",
  "api_tokens",
  "watch_stats",
  "word_lists",
  "word_cards",
  "word_reviews",
  "word_list_entries",
  "import_jobs",
  "swipe_log",
  "dev_access_token",
  "cli_login",
  "study_day",
] as const;

export type EmailDb = D1Like & ThrottleDb & AuditDb & { batch(s: D1StmtLike[]): Promise<unknown> };

export type EmailDeps = {
  /** The session's user and when the session began. */
  who: () => Promise<{ id: string; email: string; sessionCreatedMs: number } | null>;
  db: () => EmailDb;
  send: (mail: SendEmailInput) => Promise<unknown>;
  mailOn: () => boolean;
  /** Where the link points: configured, never from the request's headers. */
  origin: () => string;
  now?: () => number;
};

type RequestRow = { tokenHash: string; oldEmail: string; newEmail: string; expiresMs: number };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const logFailure = (event: string) => console.error(JSON.stringify({ event }));

/** An address as stored (lowercased), or null. Deliberately loose: the link proves the rest. */
export function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/**
 * Everyone holding a permission (admin or dev, account_permission), read from
 * D1 each time and not from the isolate's snapshot: that one fails closed to
 * "nobody", which here would let a holder's address move. A failed read
 * throws, so nothing changes.
 */
const activeOwners = async (db: EmailDb) => {
  const grants = await readGrants(db as unknown as PermissionReadDb);
  return [...new Set(grants.map((g) => g.email))];
};

/** A grant goes by this exact address (lib/permissions.ts): moving it would drop the grant. */
const isOwnerAddress = (owners: string[], email: string) => owners.includes(email.toLowerCase());

/** Stricter for a target: an alias of an owner's address is refused too. */
const isOwnerAlias = (owners: string[], email: string) =>
  owners.some((o) => canonicalEmail(o) === canonicalEmail(email));

/** ?1 old address, ?2 new address. Holds inside the batch, so a grant made just now still counts. */
const NO_OWNER_INVOLVED = `NOT EXISTS (SELECT 1 FROM account_permission
  WHERE email IN (lower(?1), lower(?2)) AND revoked_at IS NULL)`;

/** Does another account hold this address, in its exact or its canonical form? */
async function takenByAnother(db: EmailDb, userId: string, email: string) {
  const row = await db
    .prepare(
      "SELECT 1 AS hit FROM user WHERE (lower(email) = ?1 OR email_canonical = ?2) AND id != ?3 LIMIT 1",
    )
    .bind(email, canonicalEmail(email), userId)
    .first();
  return !!row;
}

function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** POST /api/profile/email — {email}: start a change. */
export async function requestEmailChange(req: Request, d: EmailDeps): Promise<Response> {
  if (!sameOriginJson(req)) return json({ error: "forbidden" }, 403);
  const who = await d.who();
  if (!who) return json({ error: "unauthorized" }, 401);
  if (!d.mailOn()) return json({ error: "mail-off" }, 503);
  const db = d.db();
  const owners = await activeOwners(db);
  // A grant is the address in account_permission: moving it would lock its holder out of /dev.
  if (isOwnerAddress(owners, who.email)) return json({ error: "owner" }, 403);
  const body = (await req.json().catch(() => null)) as { email?: unknown } | null;
  const email = cleanEmail(body?.email);
  if (!email) return json({ error: "invalid" }, 400);
  if (email === who.email.toLowerCase()) return json({ error: "same" }, 400);
  const now = (d.now ?? Date.now)();
  // A stolen old cookie must not be enough, as better-auth's fresh sessions for passkeys.
  if (now - who.sessionCreatedMs >= PROFILE.emailFreshMs)
    return json({ error: "sign-in-again" }, 403);
  const mine = await hit(db, `profile-email:${who.id}`, PROFILE.emailLimit, now);
  if (!mine.allowed)
    return json({ error: "rate-limited" }, 429, {
      "retry-after": String(Math.ceil(mine.retryAfterMs / 1000)),
    });
  const sent = () => json({ status: "sent" });
  // Nobody's mailbox gets flooded. The answer stays the same, so it tells nothing.
  const target = await hit(
    db,
    await accountKey("profile-email", email),
    PROFILE.emailTargetLimit,
    now,
  );
  if (!target.allowed) return sent();

  const locale = await changeMailLocale(db, who.id, req);
  const taken = isOwnerAlias(owners, email) || (await takenByAnother(db, who.id, email));
  try {
    if (taken) {
      await d.send({ to: email, ...(await changeMail(db, "email-taken", locale, {}, who.id)) });
    } else {
      const token = newToken();
      await db
        .prepare(
          `INSERT INTO email_change_request (userId, tokenHash, oldEmail, newEmail, expiresMs)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(userId) DO UPDATE SET
             tokenHash = ?2, oldEmail = ?3, newEmail = ?4, expiresMs = ?5`,
        )
        .bind(who.id, await sha256Hex(token), who.email, email, now + PROFILE.emailLinkMs)
        .run();
      // After the #: a fragment reaches no server log and no Referer.
      const url = `${d.origin()}/my/profile/email-confirm#${who.id}.${token}`;
      await d.send({
        to: email,
        ...(await changeMail(db, "email-confirm", locale, { url }, who.id)),
      });
    }
    await d.send({
      to: who.email,
      ...(await changeMail(db, "email-requested", locale, { address: maskEmail(email) }, who.id)),
    });
  } catch {
    logFailure("email-change.mail-failed");
    return json({ error: "mail-failed" }, 502);
  }
  return sent();
}

/** POST /api/profile/email/confirm — {token}: the page the mailed link opens. */
export async function confirmEmailChange(req: Request, d: EmailDeps): Promise<Response> {
  if (!sameOriginJson(req)) return json({ error: "forbidden" }, 403);
  const now = (d.now ?? Date.now)();
  const db = d.db();
  const ip = await hit(
    db,
    ipKey("profile-email-confirm", clientIp(req.headers)),
    PROFILE.emailConfirmLimit,
    now,
  );
  if (!ip.allowed) return json({ error: "rate-limited" }, 429);

  // Unknown, used, replaced, expired or wrong all read the same.
  const invalid = () => json({ error: "invalid" }, 400);
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const m =
    typeof body?.token === "string" && /^([A-Za-z0-9_-]{1,64})\.([0-9a-f]{64})$/.exec(body.token);
  if (!m) return invalid();
  const userId = m[1]!;
  const row = await db
    .prepare(
      "SELECT tokenHash, oldEmail, newEmail, expiresMs FROM email_change_request WHERE userId = ?1",
    )
    .bind(userId)
    .first<RequestRow>();
  if (!row || row.tokenHash !== (await sha256Hex(m[2]!)) || row.expiresMs <= now) return invalid();
  const user = await db
    .prepare("SELECT email FROM user WHERE id = ?1")
    .bind(userId)
    .first<{ email: string }>();
  if (user?.email !== row.oldEmail) return invalid();

  const unavailable = () => json({ error: "unavailable" }, 409);
  const owners = await activeOwners(db);
  if (
    isOwnerAddress(owners, row.oldEmail) ||
    isOwnerAlias(owners, row.newEmail) ||
    (await takenByAnother(db, userId, row.newEmail))
  )
    return unavailable();

  const old = [row.oldEmail, row.oldEmail.toLowerCase()];
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE user SET email = ?1, email_canonical = ?2, emailVerified = 1, updatedAt = ?3
           WHERE id = ?4 AND email = ?5 AND ${NO_OWNER_INVOLVED.replaceAll("?1", "?5").replaceAll("?2", "?1")}`,
        )
        .bind(
          row.newEmail,
          canonicalEmail(row.newEmail),
          new Date(now).toISOString(),
          userId,
          row.oldEmail,
        ),
      ...EMAIL_KEYED_TABLES.map((t) =>
        db
          .prepare(
            // Only if the user row above really moved: a lost race moves no one's data.
            `UPDATE ${t} SET email = ?1 WHERE email IN (?2, ?3)
             AND EXISTS (SELECT 1 FROM user WHERE id = ?4 AND email = ?1)`,
          )
          .bind(row.newEmail, old[0], old[1], userId),
      ),
      db
        .prepare(
          // Likewise: a change that didn't happen keeps its link.
          `DELETE FROM email_change_request WHERE userId = ?1
           AND EXISTS (SELECT 1 FROM user WHERE id = ?1 AND email = ?2)`,
        )
        .bind(userId, row.newEmail),
    ]);
  } catch {
    // UNIQUE: the address was taken just now, or stray rows hold it. All rolled back.
    logFailure("email-change.conflict");
    return unavailable();
  }
  const moved = await db
    .prepare("SELECT email FROM user WHERE id = ?1")
    .bind(userId)
    .first<{ email: string }>();
  // The batch can succeed having moved nothing: a guard above held, or a race was lost.
  if (moved?.email !== row.newEmail) return unavailable();
  await audit(db, { kind: "email.change", actor: userId }, now);
  try {
    await d.send({
      to: row.oldEmail,
      ...(await changeMail(
        db,
        "email-changed",
        await changeMailLocale(db, userId, req),
        { address: maskEmail(row.newEmail) },
        userId,
      )),
    });
  } catch {
    logFailure("email-change.notice-failed");
  }
  return json({ status: "changed" });
}

/**
 * Gmail ignores dots in the local part, so `a.b@gmail.com` and `ab@gmail.com`
 * are one mailbox. Sign-in looks a user up by the exact (lowercased) address,
 * which made a second, empty account for anyone who once typed it the other way
 * (owner, 2026-11-27).
 *
 * This wraps the better-auth database adapter: a `findOne` on `user` by `email`
 * that finds nothing tries the same address with the dots ignored, only for
 * gmail.com / googlemail.com, and only when exactly one account matches. The
 * `+tag` is kept (a different tag is not this rule), the exact match always
 * wins, and the stored and shown address is never rewritten.
 *
 * Candidates come from `user.email_canonical` (lib/canonical-email.ts, indexed),
 * then are narrowed in code to the dots-only rule.
 */
import type { kyselyAdapter } from "@better-auth/kysely-adapter";
import type { BetterAuthOptions } from "better-auth";
import { DOTLESS_DOMAINS, canonicalEmail } from "@/lib/canonical-email";
import type { D1Like } from "@/lib/d1/types";

type DBAdapter = ReturnType<ReturnType<typeof kyselyAdapter>>;
type Where = NonNullable<Parameters<DBAdapter["findOne"]>[0]["where"]>[number];

/** `a.b+x@googlemail.com` → `ab+x@gmail.com`; null when the address is not Gmail. */
export function gmailDotKey(email: string): string | null {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0 || e.indexOf("@") !== at) return null;
  const domain = DOTLESS_DOMAINS[e.slice(at + 1)];
  if (!domain) return null;
  return `${e.slice(0, at).replaceAll(".", "")}@${domain}`;
}

/**
 * The accounts whose address has this dots-only key. It must not truncate
 * before narrowing to the key: a limit applied to every `email_canonical` match
 * (which also joins `+tag` variants) could hide a second dots-only match.
 */
export type CanonicalCandidates = (
  canonical: string,
  dotKey: string,
) => Promise<{ id: string; email: string }[]>;

/**
 * The D1 lookup: narrowed to the dots-only key in SQL (the local part with its
 * dots removed; `email_canonical` already pins the gmail/googlemail domain), so
 * `LIMIT 2` is enough to tell one match from several.
 */
export function d1DotCandidates(db: D1Like): CanonicalCandidates {
  return async (canonical, dotKey) => {
    const local = dotKey.slice(0, dotKey.lastIndexOf("@"));
    const { results } = await db
      .prepare(
        `SELECT id, email FROM user
          WHERE email_canonical = ?
            AND replace(substr(lower(email), 1, instr(lower(email), '@') - 1), '.', '') = ?
          LIMIT 2`,
      )
      .bind(canonical, local)
      .all<{ id: string; email: string }>();
    return results;
  };
}

/** The one email lookup this rule applies to: `user` where `email` = a string, nothing else. */
function emailLookup(model: string, where: Where[] | undefined): string | null {
  if (model !== "user" || !where || where.length !== 1) return null;
  const [w] = where;
  if (w.field !== "email" || (w.operator && w.operator !== "eq")) return null;
  return typeof w.value === "string" ? w.value : null;
}

type Finder = { findOne: DBAdapter["findOne"] };
// The transaction callback hands over the adapter for that transaction, which
// must fall back too (better-auth reads it through getCurrentAdapter).
type MaybeTransactional = Finder & {
  // oxlint-disable-next-line typescript/no-explicit-any
  transaction?: (cb: (trx: any) => Promise<any>) => Promise<any>;
};

export function withGmailDotFallback<A extends MaybeTransactional>(
  adapter: A,
  candidates: CanonicalCandidates,
): A {
  const findOne = async <T>(args: Parameters<DBAdapter["findOne"]>[0]): Promise<T | null> => {
    const found = await adapter.findOne<T>(args);
    if (found) return found;
    const email = emailLookup(args.model, args.where);
    const key = email ? gmailDotKey(email) : null;
    if (!email || !key) return found;
    const rows = await candidates(canonicalEmail(email), key).catch((e) => {
      console.error("[gmail-dot-signin] lookup:", e);
      return [];
    });
    const same = rows.filter((r) => gmailDotKey(r.email) === key);
    if (same.length !== 1) return found;
    return adapter.findOne<T>({
      ...args,
      where: [{ field: "id", operator: "eq", value: same[0].id }],
    });
  };
  const wrapped: MaybeTransactional = { ...adapter, findOne };
  const tx = adapter.transaction;
  if (tx)
    wrapped.transaction = (cb) =>
      tx.call(adapter, (trx: Finder) => cb(withGmailDotFallback(trx, candidates)));
  return wrapped as A;
}

/** Wrap an adapter factory (`kyselyAdapter(...)`) so every adapter it builds has the fallback. */
export function gmailDotFallbackAdapter(
  factory: (options: BetterAuthOptions) => DBAdapter,
  candidates: CanonicalCandidates,
): (options: BetterAuthOptions) => DBAdapter {
  return (options) => withGmailDotFallback(factory(options), candidates);
}

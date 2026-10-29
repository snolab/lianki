import type { D1Like } from "@/lib/d1/types";

/** One account as /dev/users shows it: who, membership, activity, data held. */
export type DevUserRow = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  trialEndsAt: string | null;
  proEndsAt: string | null;
  /** Latest session touch: the last time they used the site signed in. */
  lastSeen: string | null;
  sessions: number;
  passkeys: number;
  words: number;
  wordReviews: number;
  /** Word reviews in the last 7 days. */
  reviews7d: number;
  lastReview: string | null;
  /** Page-level ("Lianki") cards, live ones. */
  pages: number;
  reads: number;
  /** Approximate bytes of their rows' text (cards, logs, word lists, reading). */
  bytes: number;
};

type Agg = Record<string, number | string | null> & { k: string };

/**
 * Every account with its usage, for the owner's /dev/users. One grouped query
 * per table, joined here: a correlated subquery per user would re-scan the
 * tables once per account.
 */
export async function listDevUsers(db: D1Like, now = new Date()): Promise<DevUserRow[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const q = async (sql: string, ...bind: unknown[]) =>
    new Map(
      (
        await db
          .prepare(sql)
          .bind(...bind)
          .all<Agg>()
      ).results.map((r) => [r.k, r] as const),
    );
  const [users, sessions, passkeys, words, reviews, pages, reads, entries] = await Promise.all([
    db
      .prepare(
        "SELECT id, email, name, createdAt, trialEndsAt, proEndsAt FROM user ORDER BY createdAt DESC",
      )
      .all<Pick<DevUserRow, "id" | "email" | "name" | "createdAt" | "trialEndsAt" | "proEndsAt">>(),
    q("SELECT userId AS k, COUNT(*) AS n, MAX(updatedAt) AS last FROM session GROUP BY userId"),
    q("SELECT userId AS k, COUNT(*) AS n FROM passkey GROUP BY userId"),
    q(
      `SELECT email AS k, COUNT(*) AS n,
         SUM(length(term) + length(back) + ifnull(length(reading), 0) + length(card)) AS b
       FROM word_cards GROUP BY email`,
    ),
    q(
      `SELECT email AS k, COUNT(*) AS n, SUM(reviewed_at >= ?) AS recent,
         MAX(reviewed_at) AS last, SUM(length(term) + length(reviewed_at) + 24) AS b
       FROM word_reviews GROUP BY email`,
      since,
    ),
    q(
      `SELECT email AS k, SUM(deleted_at IS NULL) AS n,
         SUM(length(url) + length(card) + length(log) + ifnull(length(notes), 0)) AS b
       FROM fsrs_notes GROUP BY email`,
    ),
    q(
      `SELECT user_id AS k, COUNT(*) AS n,
         SUM(length(title) + length(lines) + ifnull(length(content), 0)) AS b
       FROM read_materials GROUP BY user_id`,
    ),
    q(
      `SELECT email AS k,
         SUM(length(term) + length(back) + ifnull(length(reading), 0) + ifnull(length(ex), 0)) AS b
       FROM word_list_entries GROUP BY email`,
    ),
  ]);
  const num = (v: unknown) => Number(v ?? 0) || 0;
  return users.results
    .map((u) => {
      const s = sessions.get(u.id);
      const w = words.get(u.email);
      const r = reviews.get(u.email);
      const p = pages.get(u.email);
      // read_materials.user_id has held both the id and the email over time.
      const rd = reads.get(u.id) ?? reads.get(u.email);
      return {
        ...u,
        lastSeen: (s?.last as string | null) ?? null,
        sessions: num(s?.n),
        passkeys: num(passkeys.get(u.id)?.n),
        words: num(w?.n),
        wordReviews: num(r?.n),
        reviews7d: num(r?.recent),
        lastReview: (r?.last as string | null) ?? null,
        pages: num(p?.n),
        reads: num(rd?.n),
        bytes: num(w?.b) + num(r?.b) + num(p?.b) + num(rd?.b) + num(entries.get(u.email)?.b),
      };
    })
    .sort((a, b) => (b.lastSeen ?? b.createdAt).localeCompare(a.lastSeen ?? a.createdAt));
}

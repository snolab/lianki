/**
 * The study ledger's server half (docs/lian.md): the daily anchor the cron
 * writes, a user's own proof, and the public list of anchors.
 *
 * - A day's leaves are its study_day rows (lib/study-days.ts), one per user:
 *   H(salt ‖ userId ‖ day ‖ {reviews}), sorted by hash (so the order says
 *   nothing about who). Users with no salt yet get one here.
 * - A day is anchored once it has ended in every time zone: study_day cuts
 *   days in each user's home zone, and the last zone (UTC−12) ends a date 36 h
 *   after it began in UTC. Before that, rows for it may still arrive.
 * - Anchors are written in day order with no gaps — a day nobody studied is
 *   anchored with no leaves — and each one in a single D1 batch with its
 *   leaves. `INSERT` (not upsert) on the day's primary key, plus the
 *   append-only triggers (0043), mean a re-run never rewrites a day.
 */
import {
  CHAIN_VERSION,
  GENESIS,
  type ProofStep,
  type StudySummary,
  addDays,
  canonical,
  chainHash,
  isDay,
  merkleProof,
  merkleRoot,
  studyDayLeaf,
  studyDayPreimage,
  toHex,
  type StudyDayPreimage,
} from "@lianki/lian";
import type { D1Like, D1StmtLike } from "@/lib/d1/types";

export type LianDb = D1Like & { batch(stmts: D1StmtLike[]): Promise<unknown> };

const HOUR = 3_600_000;
/** A local date has ended everywhere this long after it began in UTC (UTC−12). */
const LAST_ZONE_CLOSE_MS = 36 * HOUR;
/** Days one cron run anchors at most (catch-up after an outage). */
export const MAX_DAYS_PER_RUN = 30;
/** D1 binds at most 100 parameters per statement. */
const ROWS_PER_INSERT = 20;

/** The last day that has ended in every time zone at `now`. */
export function closedThrough(now: Date): string {
  return new Date(now.getTime() - LAST_ZONE_CLOSE_MS).toISOString().slice(0, 10);
}

export function newSalt(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export type AnchorRow = {
  day: string;
  version: number;
  merkleRoot: string;
  prevHash: string;
  chainHash: string;
  leafCount: number;
  createdAt: string;
};

type AnchorDbRow = {
  day: string;
  version: number;
  merkle_root: string;
  prev_hash: string;
  chain_hash: string;
  leaf_count: number;
  created_at: string;
};

const toAnchor = (r: AnchorDbRow): AnchorRow => ({
  day: r.day,
  version: Number(r.version),
  merkleRoot: r.merkle_root,
  prevHash: r.prev_hash,
  chainHash: r.chain_hash,
  leafCount: Number(r.leaf_count),
  createdAt: r.created_at,
});

/** Give every user who studied on `day` a salt, if they have none yet. */
async function ensureSalts(d1: LianDb, day: string, now: Date): Promise<void> {
  const { results } = await d1
    .prepare(
      `SELECT DISTINCT u.id AS id FROM study_day s
         JOIN user u ON lower(u.email) = s.email
         LEFT JOIN lian_salt l ON l.user_id = u.id
       WHERE s.day = ? AND l.user_id IS NULL`,
    )
    .bind(day)
    .all<{ id: string }>();
  const stmts: D1StmtLike[] = [];
  for (let i = 0; i < results.length; i += 33) {
    const chunk = results.slice(i, i + 33);
    stmts.push(
      d1
        .prepare(
          `INSERT OR IGNORE INTO lian_salt (user_id, salt, created_at) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`,
        )
        .bind(...chunk.flatMap((r) => [r.id, newSalt(), now.toISOString()])),
    );
  }
  if (stmts.length) await d1.batch(stmts);
}

/** The day's leaves, sorted into tree order. */
export async function dayLeaves(
  d1: D1Like,
  day: string,
): Promise<{ userId: string; leafHash: string; summary: StudySummary }[]> {
  const { results } = await d1
    .prepare(
      `SELECT u.id AS user_id, l.salt AS salt, SUM(s.reviews) AS reviews FROM study_day s
         JOIN user u ON lower(u.email) = s.email
         JOIN lian_salt l ON l.user_id = u.id
       WHERE s.day = ? GROUP BY u.id, l.salt`,
    )
    .bind(day)
    .all<{ user_id: string; salt: string; reviews: number }>();
  const leaves = await Promise.all(
    results.map(async (r) => {
      const summary = { reviews: Number(r.reviews) };
      const leafHash = await studyDayLeaf(studyDayPreimage(r.salt, r.user_id, day, summary));
      return { userId: r.user_id, leafHash, summary };
    }),
  );
  return leaves.sort((a, b) => (a.leafHash < b.leafHash ? -1 : a.leafHash > b.leafHash ? 1 : 0));
}

/** Anchor `day` on top of `prev` (the day before's chain hash): one batch. */
export async function anchorDay(
  d1: LianDb,
  day: string,
  prev: string,
  now: Date,
): Promise<AnchorRow> {
  await ensureSalts(d1, day, now);
  const leaves = await dayLeaves(d1, day);
  const root = await merkleRoot(leaves.map((l) => l.leafHash));
  const chain = await chainHash(day, root, prev, CHAIN_VERSION);
  const row: AnchorRow = {
    day,
    version: CHAIN_VERSION,
    merkleRoot: root,
    prevHash: prev,
    chainHash: chain,
    leafCount: leaves.length,
    createdAt: now.toISOString(),
  };
  const stmts: D1StmtLike[] = [
    d1
      .prepare(
        `INSERT INTO lian_anchor (day, version, merkle_root, prev_hash, chain_hash, leaf_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(day, row.version, root, prev, chain, row.leafCount, row.createdAt),
  ];
  for (let i = 0; i < leaves.length; i += ROWS_PER_INSERT) {
    const chunk = leaves.slice(i, i + ROWS_PER_INSERT);
    stmts.push(
      d1
        .prepare(
          `INSERT INTO lian_leaf (day, idx, user_id, leaf_hash, summary) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
        )
        .bind(...chunk.flatMap((l, j) => [day, i + j, l.userId, l.leafHash, canonical(l.summary)])),
    );
  }
  await d1.batch(stmts);
  return row;
}

/** The newest anchor, or null before the first. */
export async function headAnchor(d1: D1Like): Promise<AnchorRow | null> {
  const r = await d1
    .prepare("SELECT * FROM lian_anchor ORDER BY day DESC LIMIT 1")
    .first<AnchorDbRow>();
  return r ? toAnchor(r) : null;
}

/**
 * The cron's job: anchor every day not yet anchored that has closed in
 * every zone, oldest first, at most MAX_DAYS_PER_RUN. Re-running changes
 * nothing. The chain begins at the first study day there is.
 */
export async function anchorDue(
  d1: LianDb,
  now = new Date(),
  max = MAX_DAYS_PER_RUN,
): Promise<{ anchored: AnchorRow[]; through: string }> {
  const through = closedThrough(now);
  const head = await headAnchor(d1);
  let day: string | null = head ? addDays(head.day, 1) : null;
  if (!day) {
    const first = await d1
      .prepare("SELECT MIN(day) AS day FROM study_day")
      .first<{ day: string | null }>();
    day = first?.day && isDay(first.day) ? first.day : null;
  }
  let prev = head?.chainHash ?? GENESIS;
  const anchored: AnchorRow[] = [];
  while (day && day <= through && anchored.length < max) {
    const a = await anchorDay(d1, day, prev, now);
    anchored.push(a);
    prev = a.chainHash;
    day = addDays(day, 1);
  }
  return { anchored, through };
}

/** Anchors for the public list: day, root, chain hash, leaf count — no user data. */
export async function listAnchors(
  d1: D1Like,
  { limit = 400, before }: { limit?: number; before?: string } = {},
): Promise<AnchorRow[]> {
  const n = Math.max(1, Math.min(1000, Math.floor(limit) || 400));
  const { results } = await (
    before && isDay(before)
      ? d1
          .prepare("SELECT * FROM lian_anchor WHERE day < ? ORDER BY day DESC LIMIT ?")
          .bind(before, n)
      : d1.prepare("SELECT * FROM lian_anchor ORDER BY day DESC LIMIT ?").bind(n)
  ).all<AnchorDbRow>();
  return results.map(toAnchor);
}

export type LianProof = {
  day: string;
  /** Everything the leaf hashes: recompute it with studyDayLeaf(preimage). */
  preimage: StudyDayPreimage;
  leafHash: string;
  index: number;
  leafCount: number;
  proof: ProofStep[];
  merkleRoot: string;
  prevHash: string;
  chainHash: string;
  version: number;
};

/**
 * `userId`'s own leaf on `day`: its preimage (with their salt), its Merkle
 * proof, and the day's anchor. Null when they have no leaf that day. Only
 * sibling hashes of others' leaves are included — never their ids or salts.
 */
export async function proofFor(d1: D1Like, userId: string, day: string): Promise<LianProof | null> {
  if (!userId || !isDay(day)) return null;
  const anchor = await d1
    .prepare("SELECT * FROM lian_anchor WHERE day = ?")
    .bind(day)
    .first<AnchorDbRow>();
  if (!anchor) return null;
  const mine = await d1
    .prepare("SELECT idx, leaf_hash, summary FROM lian_leaf WHERE day = ? AND user_id = ?")
    .bind(day, userId)
    .first<{ idx: number; leaf_hash: string; summary: string }>();
  const salt = await d1
    .prepare("SELECT salt FROM lian_salt WHERE user_id = ?")
    .bind(userId)
    .first<{ salt: string }>();
  if (!mine || !salt) return null;
  const { results } = await d1
    .prepare("SELECT leaf_hash FROM lian_leaf WHERE day = ? ORDER BY idx")
    .bind(day)
    .all<{ leaf_hash: string }>();
  const index = Number(mine.idx);
  const a = toAnchor(anchor);
  return {
    day,
    preimage: studyDayPreimage(salt.salt, userId, day, JSON.parse(mine.summary) as StudySummary),
    leafHash: mine.leaf_hash,
    index,
    leafCount: a.leafCount,
    proof: await merkleProof(
      results.map((r) => r.leaf_hash),
      index,
    ),
    merkleRoot: a.merkleRoot,
    prevHash: a.prevHash,
    chainHash: a.chainHash,
    version: a.version,
  };
}

/** The days `userId` has a leaf on, newest first. */
export async function myLeafDays(d1: D1Like, userId: string, limit = 400): Promise<string[]> {
  const { results } = await d1
    .prepare("SELECT day FROM lian_leaf WHERE user_id = ? ORDER BY day DESC LIMIT ?")
    .bind(userId, limit)
    .all<{ day: string }>();
  return results.map((r) => r.day);
}

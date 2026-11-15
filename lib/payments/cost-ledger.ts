/**
 * The cost ledger (docs/payments.md, "Cost ledger"): what each account's free
 * calls cost us, booked per account even though the user is charged nothing
 * (owner, 2026-11-11). /dev/costs shows it beside what the paid features
 * charged (credit_ai_charge), per day, feature and account. Users never see it.
 *
 * - `bookCost` writes one row and never throws: a failed write is logged
 *   (`cost.book.failed`, the feature only) and the user's call goes on.
 * - Amounts are the provider's cost in millionths of a USD — our price
 *   (lib/payments/prices.ts) over `MARGIN` — so free and paid line up.
 * - `day` is the UTC date of `at` (rows written before 2026-11-15 hold the JST
 *   date; docs/payments.md, "Cost ledger"). The admin views never group by it:
 *   they bucket `at` in the viewer's zone (an offset in minutes, `offMin`) and
 *   use `day` only as an index bound, widened by a day each side.
 * - Only the account id is kept: no text, no audio, no email.
 */
import type { D1Like } from "@/lib/d1/types";
import { CREDITS_PER_USD } from "./credits";
import { FEATURES, MARGIN, type Feature } from "./prices";
import { dayStartMs, localDay } from "@/lib/time-zone";
import { paidUsdMicro, recordSpend, type SpendDeps } from "./spend-alert";

/** Lianki's own speech server (the owner's Mac, docs/local-stt.md), booked as a cloud service. */
export const LOCAL_STT_FEATURE = "speech.stt.local";
export type CostFeature = Feature | typeof LOCAL_STT_FEATURE;

/** The longest one utterance can be (MAX_UTTERANCE_MS in packages/debug-chat/src/mic.ts): a report above it is clamped. */
export const LOCAL_STT_MAX_AUDIO_MS = 30_000;

export type CostEntry = {
  /** The account that used it; null or '' for a guest. */
  userId: string | null | undefined;
  feature: CostFeature;
  /** The provider's cost, USD. */
  usd: number;
  /** Audio seconds (speech to text) or characters (speech). */
  units?: number;
};

type Log = (o: Record<string, unknown>) => void;
const defaultLog: Log = (o) => console.log(JSON.stringify(o));

/** The UTC day of `at`, YYYY-MM-DD: what `cost_ledger.day` holds. */
export const costDay = (at: Date) => localDay(at, 0);

/** The provider's cost of a call priced at `ourUsd` (our price includes MARGIN). */
export const providerUsd = (ourUsd: number) => Math.max(0, ourUsd) / MARGIN;

/** What `audioMs` of audio costs on the speech server at `perMinUsd` (the cloud-equivalent rate). */
export const localSttUsd = (audioMs: number, perMinUsd: number) =>
  (Math.min(LOCAL_STT_MAX_AUDIO_MS, Math.max(0, audioMs)) / 60_000) * Math.max(0, perMinUsd);

/**
 * Book one call. Never throws; never blocks a user's call on its own failure.
 * A booked cost goes on to the spend alert's counters (lib/payments/spend-alert.ts);
 * `push` is the hub it posts to (default: the Worker's PUSH binding).
 */
export async function bookCost(
  d1: D1Like | null | undefined,
  e: CostEntry,
  now: Date = new Date(),
  log: Log = defaultLog,
  push?: SpendDeps["push"],
): Promise<boolean> {
  if (!d1) return false;
  const micro = Math.max(0, e.usd) * 1e6;
  if (!Number.isFinite(micro)) return false;
  try {
    await d1
      .prepare(
        "INSERT INTO cost_ledger (user_id, feature, usd_micro, units, day, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        e.userId ?? "",
        e.feature,
        micro,
        Number.isFinite(e.units) ? Math.max(0, e.units ?? 0) : 0,
        costDay(now),
        now.toISOString(),
      )
      .run();
  } catch (err) {
    log({
      event: "cost.book.failed",
      what: e.feature,
      error: String((err as Error)?.message ?? err),
    });
    return false;
  }
  await recordSpend(d1, e.userId, micro, { now, log, ...(push !== undefined ? { push } : {}) });
  return true;
}

// ---------------------------------------------------------------- the admin view

/** A YYYY-MM-DD day, or null. */
export const isDay = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export type CostRange = { from: string; to: string };

/** The default range: the last 30 days in the viewer's zone (`offMin`), today included. */
export function defaultRange(now = new Date(), offMin = 0): CostRange {
  return {
    from: localDay(now.getTime() - 29 * 86400_000, offMin),
    to: localDay(now, offMin),
  };
}

export type RangeBounds = {
  /** UTC ISO instants of the range in the viewer's zone: start inclusive, end exclusive. */
  startIso: string;
  endIso: string;
  /** `cost_ledger.day` bounds for the index: a day wider each side (UTC and older JST rows). */
  fromDay: string;
  toDay: string;
};

/** The instants and index bounds of `range` (local days at `offMin`, inclusive). */
export function rangeBounds(range: CostRange, offMin = 0): RangeBounds {
  const start = dayStartMs(range.from, offMin);
  const end = dayStartMs(range.to, offMin) + 86400_000;
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(end).toISOString(),
    fromDay: localDay(start - 86400_000),
    toDay: localDay(end + 86400_000),
  };
}

/** SQL: the day of a stored ISO time at `offMin` minutes (an integer, checked by the caller). */
export const sqlDay = (col: string, offMin = 0) =>
  `date(${col}, '${offMin >= 0 ? "+" : ""}${Math.trunc(offMin)} minutes')`;
/** SQL: the hour (YYYY-MM-DDTHH) of a stored ISO time at `offMin` minutes. */
export const sqlHour = (col: string, offMin = 0) =>
  `strftime('%Y-%m-%dT%H', ${col}, '${offMin >= 0 ? "+" : ""}${Math.trunc(offMin)} minutes')`;
/** SQL: a cost_ledger row inside RangeBounds (?fromDay ?toDay ?startIso ?endIso, in that order). */
const FREE_IN = "day BETWEEN ? AND ? AND at >= ? AND at < ?";
const freeArgs = (b: RangeBounds) => [b.fromDay, b.toDay, b.startIso, b.endIso];

export type CostTotals = {
  /** Free features: provider cost, millionths of a USD. */
  freeMicro: number;
  freeCalls: number;
  /** Paid features: provider cost, millionths of a USD (charged ÷ CREDITS_PER_USD ÷ MARGIN). */
  paidMicro: number;
  /** Paid features: what users were charged, in credits (fractions kept). */
  paidCredits: number;
  paidCalls: number;
};
const zero = (): CostTotals => ({
  freeMicro: 0,
  freeCalls: 0,
  paidMicro: 0,
  paidCredits: 0,
  paidCalls: 0,
});

export type CostSummary = {
  range: CostRange;
  totals: CostTotals;
  byDay: ({ day: string } & CostTotals)[];
  byFeature: ({ feature: string } & CostTotals)[];
};

/** A paid charge's feature from its key: `<feature>:<userId>:…`; a Learning Partner reply has none. */
export function paidFeature(prefix: string | null | undefined): string {
  return prefix && (FEATURES as readonly string[]).includes(prefix) ? prefix : "partner.reply";
}

const PREFIX = "CASE WHEN instr(key, ':') > 0 THEN substr(key, 1, instr(key, ':') - 1) ELSE '' END";

/**
 * Totals by day and by feature, free and paid side by side, over `range`
 * (days in the viewer's zone, `offMin` minutes east of UTC; inclusive).
 */
export async function costSummary(d1: D1Like, range: CostRange, offMin = 0): Promise<CostSummary> {
  const b = rangeBounds(range, offMin);
  const paidIn = "status = 'settled' AND settledAt >= ? AND settledAt < ?";
  const [freeDays, paidDays, freeFeat, paidFeat] = await Promise.all([
    d1
      .prepare(
        `SELECT ${sqlDay("at", offMin)} AS day, SUM(usd_micro) AS micro, COUNT(*) AS n FROM cost_ledger WHERE ${FREE_IN} GROUP BY 1`,
      )
      .bind(...freeArgs(b))
      .all<{ day: string; micro: number; n: number }>(),
    d1
      .prepare(
        `SELECT ${sqlDay("settledAt", offMin)} AS day, SUM(costMicro) AS cm, COUNT(*) AS n FROM credit_ai_charge WHERE ${paidIn} GROUP BY 1`,
      )
      .bind(b.startIso, b.endIso)
      .all<{ day: string; cm: number; n: number }>(),
    d1
      .prepare(
        `SELECT feature, SUM(usd_micro) AS micro, COUNT(*) AS n FROM cost_ledger WHERE ${FREE_IN} GROUP BY feature`,
      )
      .bind(...freeArgs(b))
      .all<{ feature: string; micro: number; n: number }>(),
    d1
      .prepare(
        `SELECT ${PREFIX} AS prefix, SUM(costMicro) AS cm, COUNT(*) AS n FROM credit_ai_charge WHERE ${paidIn} GROUP BY prefix`,
      )
      .bind(b.startIso, b.endIso)
      .all<{ prefix: string; cm: number; n: number }>(),
  ]);
  const totals = zero();
  const days = new Map<string, CostTotals>();
  const feats = new Map<string, CostTotals>();
  const at = <K>(m: Map<K, CostTotals>, k: K) => {
    let v = m.get(k);
    if (!v) m.set(k, (v = zero()));
    return v;
  };
  const addFree = (t: CostTotals, micro: number, n: number) => {
    t.freeMicro += micro;
    t.freeCalls += n;
  };
  const addPaid = (t: CostTotals, cm: number, n: number) => {
    t.paidMicro += paidUsdMicro(cm);
    t.paidCredits += cm / 1e6;
    t.paidCalls += n;
  };
  for (const r of freeDays.results) {
    addFree(at(days, r.day), r.micro ?? 0, r.n);
    addFree(totals, r.micro ?? 0, r.n);
  }
  for (const r of paidDays.results) {
    addPaid(at(days, r.day), r.cm ?? 0, r.n);
    addPaid(totals, r.cm ?? 0, r.n);
  }
  for (const r of freeFeat.results) addFree(at(feats, r.feature), r.micro ?? 0, r.n);
  for (const r of paidFeat.results) addPaid(at(feats, paidFeature(r.prefix)), r.cm ?? 0, r.n);
  const cost = (t: CostTotals) => t.freeMicro + t.paidMicro;
  return {
    range,
    totals,
    byDay: [...days].map(([day, t]) => ({ day, ...t })).sort((a, b) => b.day.localeCompare(a.day)),
    byFeature: [...feats]
      .map(([feature, t]) => ({ feature, ...t }))
      .sort((a, b) => cost(b) - cost(a) || a.feature.localeCompare(b.feature)),
  };
}

export type CostUser = { userId: string; name: string | null } & CostTotals;

/**
 * Every account with a cost in `range`, the dearest first (free + paid provider
 * cost): top spenders are the first rows. `offset`/`limit` feed the list's
 * continuous scroll. A guest's free calls are one row with userId ''.
 */
export async function costUsers(
  d1: D1Like,
  range: CostRange,
  offset: number,
  limit: number,
  offMin = 0,
): Promise<{ rows: CostUser[]; total: number }> {
  const b = rangeBounds(range, offMin);
  const cte = `WITH f AS (
      SELECT user_id AS uid, SUM(usd_micro) AS fm, COUNT(*) AS fn FROM cost_ledger
      WHERE day BETWEEN ?6 AND ?7 AND at >= ?1 AND at < ?2 GROUP BY user_id),
    p AS (
      SELECT userId AS uid, SUM(costMicro) AS cm, COUNT(*) AS pn FROM credit_ai_charge
      WHERE status = 'settled' AND settledAt >= ?1 AND settledAt < ?2 GROUP BY userId),
    u AS (SELECT uid FROM f UNION SELECT uid FROM p)`;
  const rows = await d1
    .prepare(
      `${cte}
      SELECT u.uid AS uid, us.name AS name, COALESCE(f.fm, 0) AS fm, COALESCE(f.fn, 0) AS fn,
             COALESCE(p.cm, 0) AS cm, COALESCE(p.pn, 0) AS pn
      FROM u LEFT JOIN f ON f.uid = u.uid LEFT JOIN p ON p.uid = u.uid LEFT JOIN user us ON us.id = u.uid
      ORDER BY (COALESCE(f.fm, 0) + COALESCE(p.cm, 0) / ?3) DESC, u.uid
      LIMIT ?4 OFFSET ?5`,
    )
    .bind(b.startIso, b.endIso, CREDITS_PER_USD * MARGIN, limit, offset, b.fromDay, b.toDay)
    .all<{ uid: string; name: string | null; fm: number; fn: number; cm: number; pn: number }>();
  const count = await d1
    .prepare(`${cte} SELECT COUNT(*) AS n FROM u`)
    .bind(b.startIso, b.endIso, null, null, null, b.fromDay, b.toDay)
    .first<{ n: number }>();
  return {
    total: count?.n ?? 0,
    rows: rows.results.map((r) => ({
      userId: r.uid,
      name: r.name ?? null,
      freeMicro: r.fm,
      freeCalls: r.fn,
      paidMicro: paidUsdMicro(r.cm),
      paidCredits: r.cm / 1e6,
      paidCalls: r.pn,
    })),
  };
}

// ------------------------------------------------- Lianki's own speech server

/** Reports per account per window (`LOCAL_STT_WINDOW_MS`): more than anyone can speak. */
export const LOCAL_STT_MAX_REPORTS = 1200;
export const LOCAL_STT_WINDOW_MS = 10 * 60_000;

export type LocalSttDeps = {
  user: { id: string } | null;
  db: D1Like | null;
  /** The cloud-equivalent rate, USD per audio minute (config `stt.local.costPerMinUsd`). */
  perMinUsd: () => Promise<number>;
  limit: (key: string) => { allowed: boolean };
  defer?: (p: Promise<unknown>) => boolean;
  now?: () => Date;
  log?: Log;
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/debug/stt/local `{audioMs}`: one utterance the page's mic had
 * transcribed by Lianki's speech server (the owner's Mac, docs/local-stt.md),
 * which never touches lianki.com itself. Booked to the signed-in account as if
 * a cloud service had served it — `audioMs` (clamped to one utterance) at
 * `stt.local.costPerMinUsd`. Charges nothing; answers 204 even when the
 * booking fails (logged), so the mic never waits on it.
 */
export async function handleLocalSttCost(req: Request, d: LocalSttDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
  const userId = d.user?.id;
  if (!userId) return json({ error: "login-required" }, 401);
  const body = (await req.json().catch(() => null)) as { audioMs?: unknown } | null;
  const audioMs = Number(body?.audioMs);
  if (!Number.isFinite(audioMs) || audioMs <= 0) return json({ error: "bad-audio-ms" }, 400);
  if (!d.limit(`stt-local:${userId}`).allowed) return json({ error: "rate-limited" }, 429);
  const db = d.db;
  if (db) {
    const ms = Math.min(LOCAL_STT_MAX_AUDIO_MS, audioMs);
    // bookCost never throws; an unreadable rate books the units at 0 USD.
    const p = d
      .perMinUsd()
      .catch(() => 0)
      .then((rate) =>
        bookCost(
          db,
          { userId, feature: LOCAL_STT_FEATURE, usd: localSttUsd(ms, rate), units: ms / 1000 },
          d.now?.() ?? new Date(),
          d.log ?? defaultLog,
        ),
      );
    let deferred = false;
    try {
      deferred = d.defer?.(p) ?? false;
    } catch {}
    if (!deferred) await p;
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

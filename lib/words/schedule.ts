/**
 * Scheduling for word lists — pure, no I/O, shared by the API and the tests.
 *
 * Word lists run on their own rhythm, apart from page cards: lower target
 * retention (more new words, fewer reviews), minute-level learning steps so a
 * fresh word comes back within the same session, and a per-list daily cap on
 * new words. Each list stores its own WordListParams.
 */
import {
  type Card,
  createEmptyCard,
  fsrs,
  generatorParameters,
  type FSRS,
  type Grade,
  State,
  TypeConvert,
} from "ts-fsrs";

export type Rating = 1 | 2 | 3 | 4;

export type WordListParams = {
  /** FSRS target retention. Words default lower than page cards (0.9). */
  retention: number;
  /** Learning steps for new words, e.g. ["1m", "5m"]. */
  learningSteps: string[];
  /** Relearning steps after a lapse. */
  relearningSteps: string[];
  maxIntervalDays: number;
  newPerDay: number;
};

export const DEFAULT_WORD_PARAMS: WordListParams = {
  retention: 0.85,
  learningSteps: ["1m", "5m"],
  relearningSteps: ["2m"],
  maxIntervalDays: 365,
  newPerDay: 50,
};

const STEP = /^\d{1,4}[mhd]$/;
const steps = (v: unknown, fallback: string[]) =>
  Array.isArray(v) && v.length <= 6 && v.every((s) => typeof s === "string" && STEP.test(s))
    ? (v as string[])
    : fallback;
const num = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** Coerce stored or client-sent params into a safe WordListParams. */
export function normalizeParams(raw: unknown): WordListParams {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_WORD_PARAMS;
  return {
    retention: num(p.retention, 0.7, 0.97, d.retention),
    learningSteps: steps(p.learningSteps, d.learningSteps),
    relearningSteps: steps(p.relearningSteps, d.relearningSteps),
    maxIntervalDays: Math.round(num(p.maxIntervalDays, 1, 36500, d.maxIntervalDays)),
    newPerDay: Math.round(num(p.newPerDay, 0, 1000, d.newPerDay)),
  };
}

const schedulers = new Map<string, FSRS>();
function schedulerFor(params: WordListParams, fuzz = true): FSRS {
  const key = JSON.stringify(params) + fuzz;
  let s = schedulers.get(key);
  if (!s) {
    s = fsrs(
      generatorParameters({
        request_retention: params.retention,
        maximum_interval: params.maxIntervalDays,
        learning_steps: params.learningSteps as never,
        relearning_steps: params.relearningSteps as never,
        enable_short_term: true,
        enable_fuzz: fuzz,
      }),
    );
    schedulers.set(key, s);
  }
  return s;
}

/** Parse a stored card (JSON with ISO dates) back into a ts-fsrs Card. */
export function parseCard(json: string | null | undefined): Card | null {
  if (!json) return null;
  try {
    return TypeConvert.card(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Apply one rating. A null card is a new word being seen for the first time. */
export function reviewWord(
  card: Card | null,
  rating: Rating,
  now: Date,
  params: WordListParams,
  fuzz = true,
): { card: Card; prevState: State } {
  const before: Card = card ?? createEmptyCard<Card>(now);
  const next = schedulerFor(params, fuzz).next(before, now, rating as Grade);
  return { card: next.card, prevState: before.state };
}

/** Local calendar day for the daily new-word count. The client sends its own. */
export function dayKey(day: unknown, now = new Date()): string {
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? day
    : now.toISOString().slice(0, 10);
}

/** How many new words may still be introduced today. */
export function newRemaining(
  list: { new_day: string | null; new_today: number },
  params: WordListParams,
  day: string,
): number {
  const used = list.new_day === day ? list.new_today : 0;
  return Math.max(0, params.newPerDay - used);
}

/** Interval units, each a template with `{n}`: "{n}s" in English, "{n}秒" in Chinese. */
export type IntervalUnits = Record<"s" | "m" | "h" | "d" | "mo" | "y", string>;

/**
 * Short interval label: 30s, 10m, 5h, 3d, 4mo, 1y. `units` localizes the
 * suffixes (the words page passes its locale's); the number is the same.
 */
export function formatInterval(ms: number, units?: IntervalUnits): string {
  const label = (n: number, u: keyof IntervalUnits) =>
    units ? units[u].replace("{n}", String(n)) : `${n}${u}`;
  const s = Math.max(0, ms) / 1000;
  // Compare rounded values, so 59.6s reads "1m", not "60s".
  if (Math.round(s) < 60) return label(Math.round(s), "s");
  if (Math.round(s / 60) < 60) return label(Math.round(s / 60), "m");
  if (Math.round(s / 3600) < 24) return label(Math.round(s / 3600), "h");
  const d = s / 86400;
  if (d < 30) return label(Math.round(d), "d");
  if (d < 365) return label(Math.round(d / 30), "mo");
  return label(Math.round((d / 365) * 10) / 10, "y");
}

/** When a rating would schedule this card next, as an interval label. */
export function previewInterval(
  cardJson: string | null | undefined,
  rating: Rating,
  params: WordListParams,
  now = new Date(),
  units?: IntervalUnits,
): string {
  // No fuzz: the preview must not jitter between renders. The real schedule
  // adds a few percent either way.
  const { card } = reviewWord(parseCard(cardJson), rating, now, params, false);
  return formatInterval(card.due.getTime() - now.getTime(), units);
}

/** How far back an offline review may be dated. */
export const MAX_OFFLINE_AGE_MS = 30 * 86400_000;

/**
 * The time a review is scheduled at: when it was made (a review graded
 * offline and synced later), if that is a plausible past time within
 * MAX_OFFLINE_AGE_MS; otherwise the server's now. A minute of clock skew into
 * the future is tolerated as "now".
 */
export function reviewTime(reviewedAt: string | null | undefined, now: Date): Date {
  if (!reviewedAt) return now;
  const t = Date.parse(reviewedAt);
  if (!Number.isFinite(t)) return now;
  if (t > now.getTime()) return now;
  if (now.getTime() - t > MAX_OFFLINE_AGE_MS) return now;
  return new Date(t);
}

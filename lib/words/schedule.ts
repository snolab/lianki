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
function schedulerFor(params: WordListParams): FSRS {
  const key = JSON.stringify(params);
  let s = schedulers.get(key);
  if (!s) {
    s = fsrs(
      generatorParameters({
        request_retention: params.retention,
        maximum_interval: params.maxIntervalDays,
        learning_steps: params.learningSteps as never,
        relearning_steps: params.relearningSteps as never,
        enable_short_term: true,
        enable_fuzz: true,
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
): { card: Card; prevState: State } {
  const before: Card = card ?? createEmptyCard<Card>(now);
  const next = schedulerFor(params).next(before, now, rating as Grade);
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

/** Short interval label: 30s, 10m, 5h, 3d, 4mo, 1y. */
export function formatInterval(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  const d = s / 86400;
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${Math.round((d / 365) * 10) / 10}y`.replace(".0y", "y");
}

/** When a rating would schedule this card next, as an interval label. */
export function previewInterval(
  cardJson: string | null | undefined,
  rating: Rating,
  params: WordListParams,
  now = new Date(),
): string {
  const { card } = reviewWord(parseCard(cardJson), rating, now, params);
  return formatInterval(card.due.getTime() - now.getTime());
}

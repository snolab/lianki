/**
 * When does the next level open? An estimate for the /dev/new-order
 * simulator (docs/new-word-scheduler.md, "When N4 opens"). Information only:
 * it changes nothing. Pure, no I/O.
 *
 * In order, the next list opens when the one before passes: its progress
 * (lib/words/progress.ts, the picker's ring: the mean word score, with
 * score = min(1, ln(1+stability)/ln(1+365)), unseen words 0) reaches the
 * pass mark, 60% by default. Mastered = 100%.
 *
 * The projection: every seen card is reviewed when due and answered Good, so
 * its stability follows ts-fsrs with the list's own parameters. New words
 * come at the list's recent pace (new words a day over the last 14 days),
 * also answered Good. No lapses, so it is optimistic: real dates come later.
 */
import { type Card, createEmptyCard } from "ts-fsrs";
import { wordScore } from "./progress";
import { reviewWord, type WordListParams } from "./schedule";

const DAY = 86400_000;

/** A card's stability over the next `horizon` days, as (day, stability) steps, answered Good when due. */
export function stabilitySteps(
  card: Card,
  params: WordListParams,
  now: Date,
  horizon: number,
): [number, number][] {
  const steps: [number, number][] = [[0, card.stability || 0]];
  let c = card;
  for (let i = 0; i < 60; i++) {
    const due = Math.max(now.getTime(), new Date(c.due).getTime());
    const day = (due - now.getTime()) / DAY;
    if (day > horizon) break;
    c = reviewWord(c, 3, new Date(due), params, false).card;
    steps.push([Math.ceil(day), c.stability]);
  }
  return steps;
}

export type EtaInput = {
  size: number;
  /** Seen cards (stored ts-fsrs Cards). */
  cards: Card[];
  params: WordListParams;
  /** New words a day for this list, recently. */
  pace: number;
  now: Date;
  /** Days to look ahead. */
  horizon?: number;
};

export type Curve = { seen: number[]; score: number[] };

/** Seen and Σ score per day, day 0 = today, to the horizon. */
export function projectCurve(x: EtaInput): Curve {
  const H = x.horizon ?? 730;
  const cap = Math.min(365, x.params.maxIntervalDays);
  const diff = new Float64Array(H + 2);
  const addSteps = (steps: [number, number][], from: number, weight: number) => {
    let prev = 0;
    for (const [d, s] of steps) {
      const day = from + d;
      if (day > H) break;
      const sc = wordScore({ stability: s }, cap);
      diff[day] += (sc - prev) * weight;
      prev = sc;
    }
  };
  for (const c of x.cards) addSteps(stabilitySteps(c, x.params, x.now, H), 0, 1);
  // One template for a new word introduced on day 0, shifted for each day.
  const fresh = reviewWord(createEmptyCard<Card>(x.now), 3, x.now, x.params, false).card;
  const template = stabilitySteps(fresh, x.params, x.now, H);
  const seen: number[] = [];
  const score: number[] = [];
  let introduced = 0;
  let run = 0;
  const left = Math.max(0, x.size - x.cards.length);
  for (let d = 0; d <= H; d++) {
    const target = Math.min(left, Math.floor(x.pace * (d + 1)));
    if (target > introduced) {
      addSteps(template, d, target - introduced);
      introduced = target;
    }
    run += diff[d];
    seen.push(x.cards.length + introduced);
    score.push(run);
  }
  return { seen, score };
}

/** Days until the list's progress reaches `passAt` (0 = already), or null beyond the horizon. */
export function daysToPass(curve: Curve, size: number, passAt: number): number | null {
  if (!(size > 0)) return 0;
  for (let d = 0; d < curve.score.length; d++) if (curve.score[d] / size >= passAt - 1e-9) return d;
  return null;
}

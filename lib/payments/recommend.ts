/**
 * "Recommended to finish" (docs/payments.md, "Not enough credits"): next to
 * the minimum a paid action needs to start (its first hold), the balance it
 * most likely needs to run to the end, so it does not stop midway.
 *
 * - **From history.** A high percentile (`RECOMMEND_PERCENTILE`, P95; the
 *   owner also named P99) of what this feature's settled calls really cost
 *   (`credit_ai_charge.costMicro`, every user, numbers only), times the
 *   number of calls this action will make (`units`: chunks of a file; 1 for a
 *   single call).
 * - **Too little history** (fewer than `MIN_SAMPLES` settled calls): the
 *   action's own most per call (its hold) × `units` — the hold is a ceiling,
 *   so this never under-recommends.
 * - Never below `need` (what starting takes). Whole credits, rounded up.
 *   Nothing is baked in: every number comes from the action or the ledger.
 */
import type { D1WithBatch } from "./credits-store";
import { reserveCredits } from "./ai-credits";
import type { Feature } from "./prices";

/** The percentile of past real costs recommended (0.95 = P95). */
export const RECOMMEND_PERCENTILE = 0.95;
/** Below this many settled calls, history is not trusted: the hold × units instead. */
export const MIN_SAMPLES = 20;
/** The most recent settled calls looked at. */
export const HISTORY_LIMIT = 500;

const MICRO = 1_000_000;

/** The nearest-rank percentile of `xs` (p in 0..1); 0 for none. */
export function percentile(xs: readonly number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1]!;
}

/** This feature's recent settled per-call costs, in millionths of a credit. */
export async function pastCosts(d1: D1WithBatch, feature: Feature): Promise<number[]> {
  try {
    const { results } = await d1
      .prepare(
        "SELECT costMicro FROM credit_ai_charge WHERE status = 'settled' AND key LIKE ? AND costMicro > 0 ORDER BY settledAt DESC LIMIT ?",
      )
      .bind(`${feature}:%`, HISTORY_LIMIT)
      .all<{ costMicro: number }>();
    return (results ?? []).map((r) => Number(r.costMicro));
  } catch {
    return [];
  }
}

export type Recommendation = {
  /** Whole credits recommended to finish the whole action. */
  recommended: number;
  /** "history" (the percentile) or "hold" (too little history). */
  basis: "history" | "hold";
  samples: number;
};

/**
 * The recommended balance for an action of `units` calls of `feature`, each
 * held at most `unitHoldUsd`; never below `need` credits.
 */
export async function recommendFor(
  d1: D1WithBatch | null,
  call: { feature: Feature; units: number; unitHoldUsd: number; need: number },
  opts: { percentile?: number; minSamples?: number } = {},
): Promise<Recommendation> {
  const units = Math.max(1, Math.ceil(call.units));
  const costs = d1 ? await pastCosts(d1, call.feature) : [];
  const min = opts.minSamples ?? MIN_SAMPLES;
  if (costs.length >= min) {
    const per = percentile(costs, opts.percentile ?? RECOMMEND_PERCENTILE) / MICRO;
    return {
      recommended: Math.max(call.need, Math.ceil(per * units)),
      basis: "history",
      samples: costs.length,
    };
  }
  return {
    recommended: Math.max(call.need, reserveCredits(call.unitHoldUsd) * units),
    basis: "hold",
    samples: costs.length,
  };
}

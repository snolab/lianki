/**
 * Time budgets that follow the machine's load, for the QA suites.
 *
 * A wait in a browser suite is a budget for something to happen, not a claim
 * about how fast it happens: under load (two gate runs at once, docs/shipping.md,
 * "Two heavy runs at a time") the same page takes longer, and a fixed 15 s ran
 * out on a page that was fine. So a budget is the idle figure times the load
 * factor at the moment it is asked for. What a check asserts never changes;
 * only how long it may take to become true.
 *
 *   import { budget } from "./load-budget.mjs";
 *   await locator.waitFor({ timeout: budget(15_000) });
 *
 * The factor: 1 while the 1-minute load average is at most half the cores, then
 * growing with it, up to 4. LIANKI_QA_SLOWDOWN (a number ≥ 1) fixes it instead,
 * e.g. on a slow CI runner. Not for intervals the test itself must keep short
 * (two taps that make a double tap): scaling those would change what is tested.
 */
import { availableParallelism, loadavg } from "node:os";

export const MAX_FACTOR = 4;

/** The slowdown to budget for now: 1 on an idle machine, at most MAX_FACTOR. */
export function loadFactor(env = process.env, load = loadavg()[0], cores = availableParallelism()) {
  const fixed = Number(env.LIANKI_QA_SLOWDOWN);
  if (Number.isFinite(fixed) && fixed >= 1) return Math.min(fixed, MAX_FACTOR);
  const perCore = load / Math.max(1, cores);
  return Math.min(MAX_FACTOR, Math.max(1, 0.5 + perCore * 1.5));
}

/** `ms` on an idle machine, scaled to the load now. */
export function budget(ms, factor = loadFactor()) {
  return Math.round(ms * factor);
}

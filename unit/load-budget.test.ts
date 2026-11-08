// Load budgets for the QA suites (scripts/qa/load-budget.mjs): a busy machine
// gets longer waits, never different checks.
import { describe, expect, test } from "bun:test";
import { MAX_FACTOR, budget, loadFactor } from "../scripts/qa/load-budget.mjs";

describe("loadFactor", () => {
  test("1 on an idle or half-busy machine", () => {
    expect(loadFactor({}, 0, 18)).toBe(1);
    expect(loadFactor({}, 9, 18)).toBe(1.25);
    expect(loadFactor({}, 6, 18)).toBe(1);
  });

  test("grows with the load per core, up to the cap", () => {
    expect(loadFactor({}, 18, 18)).toBe(2);
    expect(loadFactor({}, 36, 18)).toBe(3.5);
    expect(loadFactor({}, 1000, 18)).toBe(MAX_FACTOR);
  });

  test("LIANKI_QA_SLOWDOWN fixes it; nonsense is ignored", () => {
    expect(loadFactor({ LIANKI_QA_SLOWDOWN: "2.5" }, 0, 18)).toBe(2.5);
    expect(loadFactor({ LIANKI_QA_SLOWDOWN: "99" }, 0, 18)).toBe(MAX_FACTOR);
    expect(loadFactor({ LIANKI_QA_SLOWDOWN: "0.5" }, 0, 18)).toBe(1);
    expect(loadFactor({ LIANKI_QA_SLOWDOWN: "x" }, 0, 18)).toBe(1);
  });

  test("no cores reported is one core, not a division by zero", () => {
    expect(loadFactor({}, 1, 0)).toBe(2);
  });
});

test("budget scales the idle figure and never shortens it", () => {
  expect(budget(15_000, 1)).toBe(15_000);
  expect(budget(15_000, 2)).toBe(30_000);
  expect(budget(15_000)).toBeGreaterThanOrEqual(15_000);
});

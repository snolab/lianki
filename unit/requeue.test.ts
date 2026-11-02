import { describe, expect, it } from "bun:test";
import {
  afterGrade,
  emptyRequeue,
  isRetired,
  takeDue,
  undoPick,
  withdraw,
  type Requeue,
} from "@/lib/words/requeue";

const WIN = 20 * 60_000;
const MIN = 60_000;

describe("requeue: a miss comes back, its slip retires", () => {
  it("a miss queues one copy; a pass queues none", () => {
    const q = afterGrade(emptyRequeue<string>(), 3, "w3", 1 * MIN, 0, WIN);
    expect([...q.requeued]).toEqual([3]);
    expect(q.later).toEqual([{ item: "w3", due: MIN, from: 3 }]);
    expect(afterGrade(emptyRequeue<string>(), 3, "w3", 3 * 86_400_000, 0, WIN).later).toEqual([]);
  });

  it("the slip reads back (retired) only once its copy is due", () => {
    const q = afterGrade(emptyRequeue<string>(), 3, "w3", MIN, 0, WIN);
    expect(isRetired(q, 3, MIN, MIN - 1)).toBe(false); // counting down: still editable
    expect(isRetired(q, 3, MIN, MIN)).toBe(true);
    expect(isRetired(q, 4, MIN, MIN)).toBe(false); // not requeued: "now", not "back"
    expect(isRetired(q, 3, undefined, MIN)).toBe(false);
  });

  it("re-grading before due replaces the copy: never two copies, none on a pass", () => {
    let q = afterGrade(emptyRequeue<string>(), 3, "again", MIN, 0, WIN);
    q = afterGrade(q, 3, "hard", 5 * MIN, 10, WIN);
    expect(q.later).toEqual([{ item: "hard", due: 5 * MIN, from: 3 }]);
    q = afterGrade(q, 3, "good", 2 * 86_400_000, 20, WIN);
    expect(q.later).toEqual([]);
    expect(q.requeued.has(3)).toBe(false);
  });

  it("undo before due withdraws the copy: no ghost card comes back", () => {
    let q = afterGrade(emptyRequeue<string>(), 3, "w3", MIN, 0, WIN);
    q = afterGrade(q, 5, "w5", MIN, 0, WIN);
    q = withdraw(q, 3);
    expect(q.later.map((w) => w.from)).toEqual([5]);
    expect(q.requeued.has(3)).toBe(false);
    expect(takeDue(q, MIN, 10).ready).toEqual(["w5"]);
    expect(withdraw(q, 9)).toBe(q);
  });

  it("inserting due copies shifts the slips (and waiting copies) below the insertion point", () => {
    let q: Requeue<string> = emptyRequeue();
    q = afterGrade(q, 2, "a", MIN, 0, WIN);
    q = afterGrade(q, 8, "b", 5 * MIN, 0, WIN);
    const { ready, next, shift } = takeDue(q, MIN, 5);
    expect(ready).toEqual(["a"]);
    expect(shift(2)).toBe(2);
    expect(shift(8)).toBe(9);
    expect([...next.requeued].sort()).toEqual([2, 9]);
    expect(next.later).toEqual([{ item: "b", due: 5 * MIN, from: 9 }]);
    // Withdrawing the moved slip finds its copy by the new index.
    expect(withdraw(next, 9).later).toEqual([]);
    const none = takeDue(next, MIN, 0);
    expect(none.ready).toEqual([]);
    expect(none.next).toBe(next);
  });
});

describe("undoPick: undo never reaches a retired slip", () => {
  const graded = new Set([1, 4, 6]);
  const g = (i: number) => graded.has(i);
  it("the focused grade first, else the latest in the log", () => {
    expect(undoPick([1, 4, 6], 4, false, g, () => false)).toBe(4);
    expect(undoPick([1, 4, 6], 2, false, g, () => false)).toBe(6);
    expect(undoPick([1, 4, 6], 2, true, g, () => false)).toBe(-1);
    expect(undoPick([], 2, false, g, () => false)).toBe(-1);
  });
  it("walks past retired slips; a focused retired slip is not undone", () => {
    const back = (i: number) => i === 6 || i === 4;
    expect(undoPick([1, 4, 6], 2, false, g, back)).toBe(1);
    expect(undoPick([1, 4, 6], 6, false, g, back)).toBe(1);
    expect(undoPick([1, 4, 6], 6, true, g, back)).toBe(-1);
    expect(undoPick([4, 6], 6, false, g, back)).toBe(-1);
  });
});

import { describe, expect, test } from "bun:test";
import type { PendingOp } from "@/lib/words/idb";
import {
  afterSend,
  backoff,
  pendingReviewed,
  reviewedKey,
  sendOrder,
  undoTarget,
} from "@/lib/words/pending";

const op = (
  id: number,
  term: string,
  kind: "review" | "undo" = "review",
  listId = "L",
): PendingOp => ({
  id,
  listId,
  op: kind,
  term,
  body: {},
  at: "2026-10-28T00:00:00Z",
});

describe("offline op queue", () => {
  test("words with an unsent review are hidden; an unsent undo un-hides", () => {
    const s = pendingReviewed([op(1, "a"), op(2, "b"), op(3, "b", "undo")]);
    expect(s.has(reviewedKey("L", "a"))).toBe(true);
    expect(s.has(reviewedKey("L", "b"))).toBe(false);
  });

  test("undo drops an unsent review, else needs an undo op", () => {
    const ops = [op(1, "a"), op(2, "b", "review", "M"), op(3, "a")];
    expect(undoTarget(ops, "L", "a")).toBe(3);
    expect(undoTarget(ops, "M", "b")).toBe(2);
    expect(undoTarget(ops, "L", "zzz")).toBeNull();
    expect(undoTarget([op(4, "a", "undo")], "L", "a")).toBeNull();
  });

  test("ops go out in the order they were made", () => {
    expect(sendOrder([op(3, "c"), op(1, "a"), op(2, "b")]).map((o) => o.term)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("network errors retry, refusals drop, with capped backoff", () => {
    expect(afterSend("network")).toBe("retry");
    expect(afterSend(200)).toBe("done");
    expect(afterSend(503)).toBe("retry");
    expect(afterSend(401)).toBe("retry");
    expect(afterSend(409)).toBe("drop");
    expect(afterSend(400)).toBe("drop");
    expect(backoff(0)).toBe(2000);
    expect(backoff(3)).toBe(16000);
    expect(backoff(20)).toBe(60_000);
  });
});

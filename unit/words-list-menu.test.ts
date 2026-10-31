/**
 * The /words list row's ⋯ menu: rename (through the offline queue) and
 * delete with Undo. Destructive paths are tested here, never on real lists.
 */
import { describe, expect, test } from "bun:test";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1 } from "@/lib/d1/testDb";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import { createDeferredDelete, type FlushReason } from "@/lib/words/deferred-delete";
import type { PendingOp } from "@/lib/words/idb";
import { pendingReviewed, reviewedKey, undoTarget, withPendingRenames } from "@/lib/words/pending";
import { flatten, withoutNode } from "@/lib/words/tree";

const rename = (id: number, listId: string, name: string): PendingOp => ({
  id,
  listId,
  op: "rename",
  body: { name },
  term: "",
  at: "2026-10-31T00:00:00Z",
});
const review = (id: number, listId: string, term: string): PendingOp => ({
  id,
  listId,
  op: "review",
  body: {},
  term,
  at: "2026-10-31T00:00:00Z",
});

describe("rename", () => {
  test("the repo renames one list of this user only", async () => {
    const d1 = createTestD1(testSchema());
    const mine = new WordsD1Repo(d1, "a@example.com");
    const theirs = new WordsD1Repo(d1, "b@example.com");
    const a = await mine.createList({ name: "French 1", lang: "fr", source: "fr-freq-1" });
    const b = await theirs.createList({ name: "French 1", lang: "fr", source: "fr-freq-1" });
    await mine.renameList(a, "Français");
    await mine.renameList(b, "hijacked");
    expect((await mine.getList(a))?.name).toBe("Français");
    expect((await theirs.getList(b))?.name).toBe("French 1");
  });

  test("a queued rename wins over the server's older name; the latest one wins", () => {
    const lists = [
      { id: "a", name: "old a" },
      { id: "b", name: "b" },
    ];
    const ops = [rename(3, "a", "newest"), rename(1, "a", "first"), review(2, "b", "x")];
    expect(withPendingRenames(lists, ops)).toEqual([
      { id: "a", name: "newest" },
      { id: "b", name: "b" },
    ]);
    // Nothing queued: the same array back.
    expect(withPendingRenames(lists, [review(1, "a", "x")])).toBe(lists);
  });

  test("a rename in the queue does not touch grades or undo", () => {
    const ops = [review(1, "L", "être"), rename(2, "L", "x")];
    expect(pendingReviewed(ops).has(reviewedKey("L", "être"))).toBe(true);
    expect(undoTarget(ops, "L", "être")).toBe(1);
    expect(undoTarget([rename(5, "L", "x")], "L", "")).toBeNull();
  });
});

describe("delete with Undo", () => {
  const harness = () => {
    const timers: (() => void)[] = [];
    const committed: [string, FlushReason][] = [];
    const shown: (string | null)[] = [];
    const d = createDeferredDelete<string>({
      commit: (id, why) => void committed.push([id, why]),
      onChange: (c) => void shown.push(c),
      setTimer: (fn) => timers.push(fn) - 1,
      clearTimer: (t) => void (timers[t as number] = () => {}),
    });
    return { d, timers, committed, shown };
  };

  test("nothing reaches the server until the toast runs out", () => {
    const { d, timers, committed } = harness();
    d.remove("a");
    expect(d.current()).toBe("a");
    expect(committed).toEqual([]);
    timers[0]();
    expect(committed).toEqual([["a", "timeout"]]);
    expect(d.current()).toBeNull();
  });

  test("Undo restores and never deletes, even when the timer fires late", () => {
    const { d, timers, committed, shown } = harness();
    d.remove("a");
    expect(d.undo()).toBe("a");
    timers[0]();
    d.flush("leave");
    expect(committed).toEqual([]);
    expect(shown).toEqual(["a", null]);
    expect(d.undo()).toBeNull();
  });

  test("a second delete sends the first at once; leaving the page sends the second", () => {
    const { d, committed } = harness();
    d.remove("a");
    d.remove("b");
    expect(committed).toEqual([["a", "next"]]);
    expect(d.current()).toBe("b");
    d.flush("leave");
    expect(committed).toEqual([
      ["a", "next"],
      ["b", "leave"],
    ]);
  });

  test("with the real timers: deletes after the delay, Undo clears the timer", async () => {
    const committed: string[] = [];
    const d = createDeferredDelete<string>({
      commit: (id) => void committed.push(id),
      onChange: () => {},
      delayMs: 5,
    });
    d.remove("kept");
    d.undo();
    d.remove("gone");
    await new Promise((r) => setTimeout(r, 30));
    expect(committed).toEqual(["gone"]);
  });

  test("a hidden group's lists move up a level, as the server will do", async () => {
    const nodes = [
      { id: "top", parentId: null },
      { id: "g", parentId: "top" },
      { id: "x", parentId: "g" },
      { id: "y", parentId: null },
    ];
    expect(withoutNode(nodes, "g")).toEqual([
      { id: "top", parentId: null },
      { id: "x", parentId: "top" },
      { id: "y", parentId: null },
    ]);
    expect(withoutNode(nodes, null)).toBe(nodes);
    expect(withoutNode(nodes, "missing")).toBe(nodes);

    // Same shape as the repo's own delete.
    const repo = new WordsD1Repo(createTestD1(testSchema()), "g@example.com");
    const top = await repo.createList({ name: "top", lang: "mul", source: "group:words" });
    const g = await repo.createList({ name: "g", lang: "mul", source: "group:words" });
    const x = await repo.createList({ name: "x", lang: "fr", source: "fr-freq-1" });
    await repo.reorder([{ id: top }, { id: g, parentId: top }, { id: x, parentId: g }]);
    const hidden = flatten(withoutNode(await repo.lists(), g)).map((l) => [l.name, l.depth]);
    await repo.deleteList(g);
    expect(flatten(await repo.lists()).map((l) => [l.name, l.depth])).toEqual(hidden);
  });
});

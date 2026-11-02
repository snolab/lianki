/**
 * Reviews before new words on /words (owner, 2026-11-03): every due card
 * comes before the next new word, the one most likely forgotten first.
 */
import { describe, expect, test } from "bun:test";
import { createEmptyCard, type Card } from "ts-fsrs";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1 } from "@/lib/d1/testDb";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import {
  dueFetchLimit,
  MAX_DUE_FETCH,
  nextBatch,
  orderDue,
  retrievability,
} from "@/lib/words/review-first";
import { DEFAULT_WORD_PARAMS, reviewWord } from "@/lib/words/schedule";

const NOW = new Date("2026-11-03T00:00:00Z");
const DAY = 86400_000;

/** A review card with this stability (days), last reviewed `ago` days before NOW. */
function card(term: string, stability: number, ago: number, dueAgo = ago - stability) {
  const c: Card = {
    ...createEmptyCard(NOW),
    state: 2,
    stability,
    difficulty: 5,
    reps: 3,
    last_review: new Date(NOW.getTime() - ago * DAY),
    due: new Date(NOW.getTime() - dueAgo * DAY),
  };
  return { term, card: JSON.stringify(c), due: c.due.toISOString() };
}

describe("orderDue", () => {
  test("highest forgetting probability first, across lists", () => {
    // Overdue by the same 2 days: the weak card (S=1) is far more likely forgotten.
    const strong = card("strong", 30, 32);
    const weak = card("weak", 1, 3);
    const mid = card("mid", 5, 7);
    expect(orderDue([strong, mid, weak], NOW).map((c) => c.term)).toEqual([
      "weak",
      "mid",
      "strong",
    ]);
    expect(retrievability(weak.card, NOW)).toBeLessThan(retrievability(strong.card, NOW));
  });

  test("equal retrievability: most overdue first; equal both: input order", () => {
    const a = card("a", 3, 6, 1);
    const b = card("b", 3, 6, 4);
    const c = card("c", 3, 6, 4);
    expect(orderDue([a, b, c], NOW).map((x) => x.term)).toEqual(["b", "c", "a"]);
  });

  test("an unreadable card counts as forgotten and goes first", () => {
    const ok = card("ok", 2, 3);
    const bad = { term: "bad", card: "{not json", due: NOW.toISOString() };
    expect(orderDue([ok, bad], NOW)[0].term).toBe("bad");
    expect(retrievability(null, NOW)).toBe(0);
  });

  test("a real FSRS card: the longer overdue, the lower retrievability", () => {
    const { card: c } = reviewWord(
      null,
      3,
      new Date(NOW.getTime() - 20 * DAY),
      DEFAULT_WORD_PARAMS,
      false,
    );
    const json = JSON.stringify(c);
    expect(retrievability(json, new Date(NOW.getTime() - 10 * DAY))).toBeGreaterThan(
      retrievability(json, NOW),
    );
  });
});

describe("nextBatch: no new word while a due word waits", () => {
  test("due words waiting: new words are not even asked for", async () => {
    let asked = 0;
    const b = await nextBatch({ due: ["r1", "r2"], fresh: async () => (asked++, ["n1"]) });
    expect(b).toEqual({ kind: "due", items: ["r1", "r2"] });
    expect(asked).toBe(0);
  });
  test("no due word left: new words", async () => {
    const b = await nextBatch({ due: [], fresh: async () => ["n1", "n2"] });
    expect(b).toEqual({ kind: "new", items: ["n1", "n2"] });
  });
});

describe("dueFetchLimit", () => {
  test("asks for the queued due words plus a page, capped", () => {
    expect(dueFetchLimit(0, 200)).toBe(200);
    expect(dueFetchLimit(400, 200)).toBe(600);
    expect(dueFetchLimit(5000, 200)).toBe(MAX_DUE_FETCH);
  });
});

describe("a backlog larger than one fetch is all reviewed before new words", () => {
  test("the session route pages through 700 due words with the queue as the skip set", async () => {
    const d1 = createTestD1(testSchema());
    const repo = new WordsD1Repo(d1, "backlog@example.com");
    const id = await repo.createList({ name: "N5", lang: "ja", source: "ja-jlpt-n5" });
    const t0 = new Date(NOW.getTime() - 30 * DAY);
    const terms = Array.from({ length: 700 }, (_, i) => `w${i}`);
    for (let i = 0; i < terms.length; i += 200)
      await repo.review(
        id,
        terms
          .slice(i, i + 200)
          .map((term, k) => ({ term, back: term, rating: 3, newIndex: i + k })),
        "2026-10-04",
        t0,
      );
    // The first load: the server's default page, `more` set, so no new words yet.
    const first = await repo.sessionMany([id], "2026-11-03", NOW, 400);
    expect(first.more).toBe(true);
    const queued = new Set(first.lists[id].due.map((c) => c.term));
    // The endless scroll asks again with the queue as the skip set, until nothing is left.
    for (let round = 0; round < 5; round++) {
      const s = await repo.sessionMany([id], "2026-11-03", NOW, dueFetchLimit(queued.size, 200));
      const fresh = s.lists[id].due.filter((c) => !queued.has(c.term));
      const b = await nextBatch({ due: fresh, fresh: async () => ["new"] });
      if (b.kind === "new") break;
      for (const c of b.items) queued.add(c.term);
    }
    expect(queued.size).toBe(700);
  });
});

describe("fetched due words ride the requeue's `later` (from -1)", () => {
  test("they join at the insertion point and no slip's withdraw takes them back", async () => {
    const { emptyRequeue, takeDue, withdraw } = await import("@/lib/words/requeue");
    let q = emptyRequeue<string>();
    q = { ...q, later: [{ item: "due1", due: 0, from: -1 }] };
    q = withdraw({ ...q, requeued: new Set([0]) }, 0);
    expect(q.later.map((w) => w.item)).toEqual(["due1"]);
    const { ready, next } = takeDue(q, 1, 5);
    expect(ready).toEqual(["due1"]);
    expect(next.later).toEqual([]);
  });
});

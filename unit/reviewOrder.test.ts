import { describe, expect, test, beforeEach } from "vitest";
import { createEmptyCard } from "ts-fsrs";
import {
  DEFAULT_REVIEW_ORDER,
  asReviewOrder,
  isReviewOrder,
  reviewOrderMongo,
  reviewOrderSql,
} from "@lianki/core";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { PreferencesD1Repo } from "@/lib/repos/d1Repos";
import type { FSRSNote } from "@/app/fsrs";

const SCHEMA = testSchema();
const USER = "orderer@example.com";

describe("review order helpers", () => {
  test("defaults to the historical behaviour", () => {
    expect(DEFAULT_REVIEW_ORDER).toBe("oldest");
  });

  test("coerces junk to the default rather than throwing", () => {
    for (const junk of [undefined, null, "", "OLDEST", 1, {}, "reverse"])
      expect(asReviewOrder(junk)).toBe("oldest");
    expect(asReviewOrder("newest")).toBe("newest");
  });

  test("isReviewOrder is exact", () => {
    expect(isReviewOrder("oldest")).toBe(true);
    expect(isReviewOrder("newest")).toBe(true);
    expect(isReviewOrder("Newest")).toBe(false);
  });

  test("emits only safe SQL literals — this value is interpolated", () => {
    expect(reviewOrderSql("oldest")).toBe("ASC");
    expect(reviewOrderSql("newest")).toBe("DESC");
  });

  test("mongo directions match", () => {
    expect(reviewOrderMongo("oldest")).toBe(1);
    expect(reviewOrderMongo("newest")).toBe(-1);
  });
});

describe("listDue ordering", () => {
  let d1: TestD1Database;
  let repo: FsrsNotesD1Repo;

  const at = (isoDaysAgo: number): FSRSNote["card"] => {
    const card = createEmptyCard();
    card.due = new Date(Date.now() - isoDaysAgo * 86_400_000);
    return card;
  };

  beforeEach(async () => {
    d1 = createTestD1(SCHEMA);
    repo = new FsrsNotesD1Repo(d1 as unknown as D1Like, USER);
    // Due 30 days ago, 5 days ago, 1 hour ago, and one NOT due (tomorrow).
    await repo.upsert({ url: "https://x/old", card: at(30), log: [] });
    await repo.upsert({ url: "https://x/mid", card: at(5), log: [] });
    await repo.upsert({ url: "https://x/fresh", card: at(1 / 24), log: [] });
    await repo.upsert({ url: "https://x/future", card: at(-1), log: [] });
  });

  test("oldest: most overdue first", async () => {
    expect((await repo.listDue(new Date(), 10, "oldest")).map((n) => n.url)).toEqual([
      "https://x/old",
      "https://x/mid",
      "https://x/fresh",
    ]);
  });

  test("newest: least overdue first", async () => {
    expect((await repo.listDue(new Date(), 10, "newest")).map((n) => n.url)).toEqual([
      "https://x/fresh",
      "https://x/mid",
      "https://x/old",
    ]);
  });

  test("neither order ever serves a card that is not due yet", async () => {
    for (const order of ["oldest", "newest"] as const)
      expect((await repo.listDue(new Date(), 10, order)).map((n) => n.url)).not.toContain(
        "https://x/future",
      );
  });

  test("the LIMIT applies AFTER ordering, not before", async () => {
    // The bug this guards: reversing in JS after `LIMIT n` returns the n-th
    // oldest, not the newest-due, because the limit already discarded that end.
    expect((await repo.listDue(new Date(), 1, "newest")).map((n) => n.url)).toEqual([
      "https://x/fresh",
    ]);
    expect((await repo.listDue(new Date(), 1, "oldest")).map((n) => n.url)).toEqual([
      "https://x/old",
    ]);
  });

  test("defaults to oldest when no order is passed", async () => {
    expect((await repo.listDue(new Date(), 1)).map((n) => n.url)).toEqual(["https://x/old"]);
  });
});

describe("PreferencesD1Repo review order", () => {
  let d1: TestD1Database;
  let prefs: PreferencesD1Repo;
  beforeEach(() => {
    d1 = createTestD1(SCHEMA);
    prefs = new PreferencesD1Repo(d1 as unknown as D1Like, "user-1");
  });

  test("an account that never set one reads as the default", async () => {
    expect(await prefs.reviewOrder()).toBe("oldest");
    expect(await prefs.get()).toBeNull();
  });

  test("round-trips a chosen order", async () => {
    await prefs.set([], "newest");
    expect(await prefs.reviewOrder()).toBe("newest");
    expect((await prefs.get())?.reviewOrder).toBe("newest");
  });

  test("saving patterns without an order does NOT reset it", async () => {
    // The filter-patterns form posts no order; defaulting there would silently
    // undo a choice made on the other control.
    await prefs.set([], "newest");
    await prefs.set([
      { id: "1", type: "domain", pattern: "x.com", isRegex: false, enabled: true, createdAt: "" },
    ]);
    expect(await prefs.reviewOrder()).toBe("newest");
    expect((await prefs.get())?.mobileExcludePatterns).toHaveLength(1);
  });
});

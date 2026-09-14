import { describe, test, expect, beforeEach } from "bun:test";
import { createEmptyCard } from "ts-fsrs";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { D1FsrsCollection } from "@/app/fsrsNotesD1Collection";
import type { D1Like } from "@/lib/d1/types";
import type { FSRSNote } from "@/app/fsrs";

/**
 * Ordering, asserted end-to-end through the collection the FSRS handler uses.
 *
 * This is the gap that let a real inversion ship: D1FsrsCollection.candidates()
 * took listDue's DEFAULT order, so when DEFAULT_REVIEW_ORDER flipped to
 * "newest" the rows arrived DESC while find/findOne still reversed them as if
 * ASC — every next-card route served the opposite end, for BOTH settings.
 * Nothing caught it: the unit suites test the repo and the preference in
 * isolation, and qa-api.mjs asserts only status codes on /due and /next-url.
 *
 * These tests pin the OBSERVABLE order, so a change to any layer beneath them
 * has to keep the answer right rather than merely keep its own contract.
 */
const SCHEMA = testSchema();
const USER = "orderer@example.com";
const daysAgo = (d: number) => ({ ...createEmptyCard(), due: new Date(Date.now() - d * 864e5) });

let d1: TestD1Database;
let col: D1FsrsCollection;

beforeEach(async () => {
  d1 = createTestD1(SCHEMA);
  const repo = new FsrsNotesD1Repo(d1 as unknown as D1Like, USER);
  // Due 30 days ago, 5 days ago, 1 hour ago, and one NOT due (tomorrow).
  await repo.upsert({ url: "https://x/old", card: daysAgo(30), log: [] } as unknown as FSRSNote);
  await repo.upsert({ url: "https://x/mid", card: daysAgo(5), log: [] } as unknown as FSRSNote);
  await repo.upsert({
    url: "https://x/fresh",
    card: daysAgo(1 / 24),
    log: [],
  } as unknown as FSRSNote);
  await repo.upsert({ url: "https://x/future", card: daysAgo(-1), log: [] } as unknown as FSRSNote);
  col = new D1FsrsCollection(d1 as unknown as D1Like, USER);
});

const due = () => ({ "card.due": { $lte: new Date() } }) as never;

describe("D1FsrsCollection next-card order", () => {
  test("sort -1 serves the most recently due, sort 1 the most overdue", async () => {
    expect((await col.findOne(due(), { sort: { "card.due": -1 } }))?.url).toBe("https://x/fresh");
    expect((await col.findOne(due(), { sort: { "card.due": 1 } }))?.url).toBe("https://x/old");
  });

  test("find() returns the full run in the requested direction", async () => {
    const urls = async (dir: 1 | -1) =>
      (await col.find(due(), { sort: { "card.due": dir } }).toArray()).map((n) => n.url);
    expect(await urls(1)).toEqual(["https://x/old", "https://x/mid", "https://x/fresh"]);
    expect(await urls(-1)).toEqual(["https://x/fresh", "https://x/mid", "https://x/old"]);
  });

  test("the limit applies AFTER ordering, not before", async () => {
    // The inversion was invisible without a limit: reversing the wrong input
    // still yields the wrong END, and only a limit makes that observable.
    const first = async (dir: 1 | -1) =>
      (await col.find(due(), { sort: { "card.due": dir }, limit: 1 }).toArray()).map((n) => n.url);
    expect(await first(-1)).toEqual(["https://x/fresh"]);
    expect(await first(1)).toEqual(["https://x/old"]);
  });

  test("neither direction ever serves a card that is not due yet", async () => {
    for (const dir of [1, -1] as const) {
      const urls = (await col.find(due(), { sort: { "card.due": dir } }).toArray()).map(
        (n) => n.url,
      );
      expect(urls).not.toContain("https://x/future");
    }
  });
});

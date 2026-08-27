/**
 * app/lib/notesAdmin — the data-management query/mutation layer.
 *
 * Every case runs against BOTH backends from one table. That is the whole point
 * of the file: `notesAdmin` carries two hand-written implementations of one
 * contract (SQL for D1, a Mongo filter for MongoDB), and the way they rot is by
 * drifting apart. Asserting them side by side is what keeps them honest — and
 * it is exactly the drift `D1FsrsCollection` warns about, since an unrecognised
 * Mongo filter there returns every row instead of erroring.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Collection } from "mongodb";
import { createEmptyCard } from "ts-fsrs";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import type { FSRSNote } from "@/app/fsrs";
import type { HLC } from "@/app/fsrs-helpers";

// Module mocks are registered once, by the shared holder — see the comment in
// unit/support/testMocks.ts for why they cannot live in each file.
import { useBackend, useD1, useGoalsCollection, useNotesCollection } from "./support/testMocks";

let testCollection: Collection;
let goalsCollection: Collection;
let testD1: TestD1Database;
let backend: "mongodb" | "d1" = "mongodb";

// Dynamic, and after the mock.module calls above: bun does not hoist module
// mocks the way vitest does, so a static import here would bind the real
// modules before the mocks were ever registered.
const { bulkDeleteNotes, bulkUpsertNotes, escapeLike, parseQueryOptions, queryNotes, storeStats } =
  await import("@/app/lib/notesAdmin");

const SCHEMA = readFileSync(join(process.cwd(), "db/migrations/0001_init.sql"), "utf8");
const EMAIL = "test@example.com";
const BACKENDS = ["mongodb", "d1"] as const;

let mongod: MongoMemoryServer;
let mongoClient: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  mongoClient = new MongoClient(mongod.getUri());
  await mongoClient.connect();
  testCollection = mongoClient.db("lianki-test").collection(`FSRSNotes@${EMAIL}`);
  goalsCollection = mongoClient.db("lianki-test").collection(`RoadmapGoals@${EMAIL}`);
}, 60_000);

afterAll(async () => {
  // Hand the shared mocks back in a neutral state: leaving dbBackend() on "d1"
  // is precisely what sent mongo-crud's writes to the wrong backend in CI.
  useBackend("mongodb");
  await mongoClient?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await testCollection.deleteMany({});
  await goalsCollection.deleteMany({});
  testD1 = createTestD1(SCHEMA);
  // Re-point the shared mocks at this file's fixtures — the D1 handle is new
  // on every test, so this is a re-assignment, not just a guard against
  // another file having claimed them.
  useNotesCollection(testCollection);
  useGoalsCollection(goalsCollection);
  useD1(testD1);
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function note(
  url: string,
  opts: {
    title?: string;
    state?: number;
    due?: Date;
    reps?: number;
    lapses?: number;
    hlc?: HLC;
  } = {},
): FSRSNote {
  const card = createEmptyCard();
  card.state = (opts.state ?? 0) as typeof card.state;
  card.due = opts.due ?? new Date("2030-01-01T00:00:00.000Z");
  card.reps = opts.reps ?? 0;
  card.lapses = opts.lapses ?? 0;
  return { url, title: opts.title ?? url, card, log: [], hlc: opts.hlc };
}

const hlc = (timestamp: number, counter = 0, deviceId = "device-a"): HLC => ({
  timestamp,
  counter,
  deviceId,
});

/** Seed straight into the active backend, bypassing the code under test. */
async function seed(notes: FSRSNote[]) {
  if (backend === "d1") {
    const { FsrsNotesD1Repo } = await import("@/lib/repos/fsrsNotesD1");
    const repo = new FsrsNotesD1Repo(testD1 as never, EMAIL);
    for (const n of notes) await repo.upsert(n);
  } else {
    await testCollection.insertMany(notes.map((n) => ({ ...n })) as never);
  }
}

// ── The shared contract ──────────────────────────────────────────────────────

// Spread: bun's describe.each takes a mutable array, and BACKENDS is `as const`.
describe.each([...BACKENDS])("notesAdmin (%s)", (which) => {
  beforeEach(() => {
    backend = which;
    useBackend(which);
  });

  describe("queryNotes", () => {
    test("returns every note, due ascending, with the total", async () => {
      await seed([
        note("https://a.test/", { due: new Date("2030-03-01") }),
        note("https://b.test/", { due: new Date("2030-01-01") }),
        note("https://c.test/", { due: new Date("2030-02-01") }),
      ]);

      const { rows, total } = await queryNotes(EMAIL, {});
      expect(total).toBe(3);
      expect(rows.map((r) => r.url)).toEqual([
        "https://b.test/",
        "https://c.test/",
        "https://a.test/",
      ]);
    });

    test("q matches title or url, case-insensitively", async () => {
      await seed([
        note("https://example.test/genki", { title: "Genki Lesson 3" }),
        note("https://other.test/x", { title: "Unrelated" }),
      ]);

      expect((await queryNotes(EMAIL, { q: "genki" })).rows.map((r) => r.url)).toEqual([
        "https://example.test/genki",
      ]);
      expect((await queryNotes(EMAIL, { q: "GENKI" })).total).toBe(1);
      expect((await queryNotes(EMAIL, { q: "unrelated" })).total).toBe(1);
      expect((await queryNotes(EMAIL, { q: "nothing-matches" })).total).toBe(0);
    });

    test("q treats wildcards as literal text, not as a pattern", async () => {
      // A bare `%` reaching SQL LIKE (or `.` reaching a Mongo regex) would match
      // everything — the classic way a search box silently stops filtering.
      await seed([note("https://a.test/"), note("https://b.test/")]);
      expect((await queryNotes(EMAIL, { q: "%" })).total).toBe(0);
      expect((await queryNotes(EMAIL, { q: "_" })).total).toBe(0);
      expect((await queryNotes(EMAIL, { q: ".*" })).total).toBe(0);
    });

    test("state filters on the FSRS card state", async () => {
      await seed([
        note("https://new.test/", { state: 0 }),
        note("https://review.test/", { state: 2 }),
        note("https://review2.test/", { state: 2 }),
      ]);

      expect((await queryNotes(EMAIL, { state: 2 })).total).toBe(2);
      expect((await queryNotes(EMAIL, { state: 0 })).rows.map((r) => r.url)).toEqual([
        "https://new.test/",
      ]);
    });

    test("due:'due' keeps only cards at or past their due date", async () => {
      await seed([
        note("https://past.test/", { due: new Date(Date.now() - 86_400_000) }),
        note("https://future.test/", { due: new Date(Date.now() + 86_400_000) }),
      ]);

      const { rows } = await queryNotes(EMAIL, { due: "due" });
      expect(rows.map((r) => r.url)).toEqual(["https://past.test/"]);
    });

    test("sort + order cover every allowed column", async () => {
      await seed([
        note("https://a.test/", { title: "Alpha", reps: 1, lapses: 5, state: 2 }),
        note("https://b.test/", { title: "Beta", reps: 9, lapses: 0, state: 0 }),
      ]);

      for (const [sort, ascFirst] of [
        ["title", "https://a.test/"],
        ["url", "https://a.test/"],
        ["reps", "https://a.test/"],
        ["lapses", "https://b.test/"],
        ["state", "https://b.test/"],
      ] as const) {
        const asc = await queryNotes(EMAIL, { sort, order: "asc" });
        const desc = await queryNotes(EMAIL, { sort, order: "desc" });
        expect(asc.rows[0].url, `${sort} asc`).toBe(ascFirst);
        expect(desc.rows[0].url, `${sort} desc`).not.toBe(ascFirst);
      }
    });

    test("page + size window the results without changing the total", async () => {
      await seed(
        Array.from({ length: 7 }, (_, i) =>
          note(`https://n${i}.test/`, { due: new Date(2030, 0, i + 1) }),
        ),
      );

      const first = await queryNotes(EMAIL, { page: 0, size: 3 });
      const second = await queryNotes(EMAIL, { page: 1, size: 3 });
      const last = await queryNotes(EMAIL, { page: 2, size: 3 });

      expect(first.total).toBe(7);
      expect(first.rows).toHaveLength(3);
      expect(second.rows).toHaveLength(3);
      expect(last.rows).toHaveLength(1);
      expect(new Set([...first.rows, ...second.rows, ...last.rows].map((r) => r.url)).size).toBe(7);
    });

    test("filters compose, and the total reflects the filter not the collection", async () => {
      await seed([
        note("https://keep.test/genki", { title: "Genki", state: 2 }),
        note("https://skip.test/genki", { title: "Genki", state: 0 }),
        note("https://skip.test/other", { title: "Other", state: 2 }),
      ]);

      const { rows, total } = await queryNotes(EMAIL, { q: "genki", state: 2 });
      expect(total).toBe(1);
      expect(rows[0].url).toBe("https://keep.test/genki");
    });
  });

  describe("bulkDeleteNotes", () => {
    test("deletes exactly the named urls and reports the count", async () => {
      await seed([note("https://a.test/"), note("https://b.test/"), note("https://c.test/")]);

      const { deleted } = await bulkDeleteNotes(EMAIL, {
        urls: ["https://a.test/", "https://c.test/"],
      });
      expect(deleted).toBe(2);
      expect((await queryNotes(EMAIL, {})).rows.map((r) => r.url)).toEqual(["https://b.test/"]);
    });

    test("counts only urls that existed", async () => {
      await seed([note("https://a.test/")]);
      const { deleted } = await bulkDeleteNotes(EMAIL, {
        urls: ["https://a.test/", "https://never-existed.test/"],
      });
      expect(deleted).toBe(1);
    });

    test("an empty url list is a no-op", async () => {
      await seed([note("https://a.test/")]);
      expect(await bulkDeleteNotes(EMAIL, { urls: [] })).toEqual({ deleted: 0 });
      expect((await queryNotes(EMAIL, {})).total).toBe(1);
    });

    test("all:true empties the store", async () => {
      await seed([note("https://a.test/"), note("https://b.test/")]);
      expect(await bulkDeleteNotes(EMAIL, { all: true })).toEqual({ deleted: 2 });
      expect((await queryNotes(EMAIL, {})).total).toBe(0);
    });

    test("deletes past the 50-url chunk boundary", async () => {
      const urls = Array.from({ length: 120 }, (_, i) => `https://n${i}.test/`);
      await seed(urls.map((u) => note(u)));
      expect(await bulkDeleteNotes(EMAIL, { urls })).toEqual({ deleted: 120 });
      expect((await queryNotes(EMAIL, {})).total).toBe(0);
    });
  });

  describe("bulkUpsertNotes — the Local → Cloud HLC matrix", () => {
    test("a url the cloud has never seen is inserted", async () => {
      const result = await bulkUpsertNotes(EMAIL, [note("https://new.test/", { hlc: hlc(1000) })]);
      expect(result).toMatchObject({ upserted: 1, conflicts: 0, skipped: 0 });
      expect((await queryNotes(EMAIL, {})).total).toBe(1);
    });

    test("a strictly newer client clock wins", async () => {
      await seed([note("https://a.test/", { title: "server", hlc: hlc(1000) })]);
      const result = await bulkUpsertNotes(EMAIL, [
        note("https://a.test/", { title: "client", hlc: hlc(2000) }),
      ]);

      expect(result).toMatchObject({ upserted: 1, conflicts: 0 });
      expect((await queryNotes(EMAIL, {})).rows[0].title).toBe("client");
    });

    test("an older client clock loses and is reported as a conflict", async () => {
      await seed([note("https://a.test/", { title: "server", hlc: hlc(5000) })]);
      const result = await bulkUpsertNotes(EMAIL, [
        note("https://a.test/", { title: "client", hlc: hlc(1000) }),
      ]);

      expect(result).toMatchObject({ upserted: 0, conflicts: 1 });
      expect((await queryNotes(EMAIL, {})).rows[0].title).toBe("server");
    });

    test("an equal clock loses, so replaying a push is a no-op", async () => {
      await seed([note("https://a.test/", { title: "server", hlc: hlc(1000) })]);
      const result = await bulkUpsertNotes(EMAIL, [
        note("https://a.test/", { title: "client", hlc: hlc(1000) }),
      ]);

      expect(result).toMatchObject({ upserted: 0, conflicts: 1 });
      expect((await queryNotes(EMAIL, {})).rows[0].title).toBe("server");
    });

    test("the counter breaks ties within one millisecond", async () => {
      await seed([note("https://a.test/", { title: "server", hlc: hlc(1000, 1) })]);
      expect(
        await bulkUpsertNotes(EMAIL, [note("https://a.test/", { hlc: hlc(1000, 0) })]),
      ).toMatchObject({ conflicts: 1 });
      expect(
        await bulkUpsertNotes(EMAIL, [
          note("https://a.test/", { title: "client", hlc: hlc(1000, 2) }),
        ]),
      ).toMatchObject({ upserted: 1 });
      expect((await queryNotes(EMAIL, {})).rows[0].title).toBe("client");
    });

    test("a stored note with no clock at all yields to the client", async () => {
      await seed([note("https://a.test/", { title: "server" })]);
      const result = await bulkUpsertNotes(EMAIL, [
        note("https://a.test/", { title: "client", hlc: hlc(1) }),
      ]);
      expect(result).toMatchObject({ upserted: 1 });
      expect((await queryNotes(EMAIL, {})).rows[0].title).toBe("client");
    });

    test("the server stamps its own clock on what it accepts", async () => {
      await bulkUpsertNotes(EMAIL, [note("https://a.test/", { hlc: hlc(1000) })]);
      const { rows } = await queryNotes(EMAIL, {});
      expect(rows[0].hlc?.deviceId).toBe("server");
      expect(rows[0].hlc?.timestamp).toBeGreaterThanOrEqual(1000);
    });

    test("unusable payloads are skipped, not written", async () => {
      const result = await bulkUpsertNotes(EMAIL, [
        { url: "", card: createEmptyCard(), log: [] } as FSRSNote,
        { url: "https://no-card.test/", log: [] } as unknown as FSRSNote,
        note("https://ok.test/"),
      ]);
      expect(result).toMatchObject({ upserted: 1, skipped: 2 });
      expect((await queryNotes(EMAIL, {})).rows.map((r) => r.url)).toEqual(["https://ok.test/"]);
    });

    test("a mixed batch reports each outcome separately", async () => {
      await seed([note("https://old.test/", { hlc: hlc(9000) })]);
      const result = await bulkUpsertNotes(EMAIL, [
        note("https://fresh.test/", { hlc: hlc(1000) }),
        note("https://old.test/", { hlc: hlc(1000) }),
        { url: "", card: createEmptyCard(), log: [] } as FSRSNote,
      ]);
      expect(result).toEqual({ upserted: 1, conflicts: 1, skipped: 1 });
    });
  });

  describe("storeStats", () => {
    test("reports the backend, plus total and due counts", async () => {
      await seed([
        note("https://past.test/", { due: new Date(Date.now() - 86_400_000) }),
        note("https://future.test/", { due: new Date(Date.now() + 86_400_000) }),
      ]);

      const stats = await storeStats(EMAIL);
      expect(stats.backend).toBe(which === "d1" ? "d1" : "mongo");
      expect(stats.notes).toBe(2);
      expect(stats.due).toBe(1);
      expect(stats.goals).toBe(0);
    });
  });
});

// ── Backend-independent helpers ──────────────────────────────────────────────

describe("escapeLike", () => {
  test("neutralises LIKE wildcards and the escape character itself", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("back\\slash")).toBe("back\\\\slash");
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("parseQueryOptions", () => {
  test("reads the query string the data table sends", () => {
    const opts = parseQueryOptions(
      new URLSearchParams("q=genki&state=2&due=due&sort=reps&order=desc&page=3&size=25"),
    );
    expect(opts).toEqual({
      q: "genki",
      state: 2,
      due: "due",
      sort: "reps",
      order: "desc",
      page: 3,
      size: 25,
    });
  });

  test("falls back to safe defaults on missing or junk input", () => {
    expect(parseQueryOptions(new URLSearchParams())).toEqual({
      q: undefined,
      state: undefined,
      due: "all",
      sort: undefined,
      order: "asc",
      page: 0,
      size: 50,
    });

    const junk = parseQueryOptions(new URLSearchParams("state=abc&page=-x&size=nope&due=maybe"));
    expect(junk.state).toBeUndefined();
    expect(junk.due).toBe("all");
    expect(junk.page).toBe(0);
    expect(junk.size).toBe(50);
  });

  test("a blank search is treated as no search, not as an empty match", () => {
    expect(parseQueryOptions(new URLSearchParams("q=%20%20")).q).toBeUndefined();
  });
});

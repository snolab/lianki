import { describe, test, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createEmptyCard } from "ts-fsrs";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import type { D1Like } from "@/lib/d1/types";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { RoadmapGoalsD1Repo, PreferencesD1Repo, ApiTokensD1Repo } from "@/lib/repos/d1Repos";
import type { FSRSNote } from "@/app/fsrs";

const SCHEMA = readFileSync(join(process.cwd(), "db/migrations/0001_init.sql"), "utf8");
const USER = "user-123";

let d1: TestD1Database;
beforeEach(() => {
  d1 = createTestD1(SCHEMA);
});

function makeNote(url: string, overrides: Partial<FSRSNote> = {}): FSRSNote {
  return {
    url,
    title: "Test",
    card: createEmptyCard(),
    log: [],
    notes: "",
    ...overrides,
  };
}

/** A fresh empty card with an explicit due date. */
function cardDue(due: Date): FSRSNote["card"] {
  const card = createEmptyCard();
  card.due = due;
  return card;
}

// ── FsrsNotesD1Repo ──────────────────────────────────────────────────────────

describe("FsrsNotesD1Repo", () => {
  test("upsert then getByUrl round-trips and restores Date objects", async () => {
    const repo = new FsrsNotesD1Repo(d1 as unknown as D1Like, USER);
    const note = makeNote("https://example.com/a");
    await repo.upsert(note);

    const got = await repo.getByUrl("https://example.com/a");
    expect(got).not.toBeNull();
    expect(got!.url).toBe("https://example.com/a");
    expect(got!.card.due).toBeInstanceOf(Date);
    expect(got!.card.reps).toBe(0);
  });

  test("getByUrl returns null for missing url", async () => {
    const repo = new FsrsNotesD1Repo(d1 as unknown as D1Like, USER);
    expect(await repo.getByUrl("https://nope.com")).toBeNull();
  });

  test("upsert replaces existing note (idempotent by user+url)", async () => {
    const repo = new FsrsNotesD1Repo(d1 as unknown as D1Like, USER);
    await repo.upsert(makeNote("https://example.com/a", { title: "First" }));
    await repo.upsert(makeNote("https://example.com/a", { title: "Second" }));
    expect(await repo.countAll()).toBe(1);
    expect((await repo.getByUrl("https://example.com/a"))!.title).toBe("Second");
  });

  test("listDue returns only cards due before now, ordered, limited", async () => {
    const repo = new FsrsNotesD1Repo(d1 as unknown as D1Like, USER);
    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 86_400_000);
    await repo.upsert(makeNote("https://example.com/due1", { card: cardDue(past) }));
    await repo.upsert(makeNote("https://example.com/due2", { card: cardDue(past) }));
    await repo.upsert(makeNote("https://example.com/later", { card: cardDue(future) }));

    const due = await repo.listDue(new Date(), 10);
    expect(due).toHaveLength(2);
    const dueLimited = await repo.listDue(new Date(), 1);
    expect(dueLimited).toHaveLength(1);
  });

  test("countAll and countDue", async () => {
    const repo = new FsrsNotesD1Repo(d1 as unknown as D1Like, USER);
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 86_400_000);
    await repo.upsert(makeNote("https://example.com/a", { card: cardDue(past) }));
    await repo.upsert(makeNote("https://example.com/b", { card: cardDue(future) }));
    expect(await repo.countAll()).toBe(2);
    expect(await repo.countDue(new Date())).toBe(1);
  });

  test("delete removes the note", async () => {
    const repo = new FsrsNotesD1Repo(d1 as unknown as D1Like, USER);
    await repo.upsert(makeNote("https://example.com/a"));
    await repo.delete("https://example.com/a");
    expect(await repo.getByUrl("https://example.com/a")).toBeNull();
  });

  test("updateUrl renames the note", async () => {
    const repo = new FsrsNotesD1Repo(d1 as unknown as D1Like, USER);
    await repo.upsert(makeNote("https://example.com/old"));
    await repo.updateUrl("https://example.com/old", "https://example.com/new");
    expect(await repo.getByUrl("https://example.com/old")).toBeNull();
    expect(await repo.getByUrl("https://example.com/new")).not.toBeNull();
  });

  test("upsert returns a stable id; getById finds the note", async () => {
    const repo = new FsrsNotesD1Repo(d1 as unknown as D1Like, USER);
    const id = await repo.upsert(makeNote("https://example.com/a"));
    expect(typeof id).toBe("string");
    const byId = await repo.getById(id);
    expect(byId!.url).toBe("https://example.com/a");
    expect(byId!.id).toBe(id);
    // id is preserved across updates
    const id2 = await repo.upsert(makeNote("https://example.com/a", { title: "Updated" }));
    expect(id2).toBe(id);
  });

  test("upsert honours an explicit id (migration case)", async () => {
    const repo = new FsrsNotesD1Repo(d1 as unknown as D1Like, USER);
    const id = await repo.upsert(makeNote("https://example.com/a"), "mongo-objectid-123");
    expect(id).toBe("mongo-objectid-123");
    expect((await repo.getById("mongo-objectid-123"))!.url).toBe("https://example.com/a");
  });

  test("notes are isolated per user", async () => {
    const repoA = new FsrsNotesD1Repo(d1 as unknown as D1Like, "user-a");
    const repoB = new FsrsNotesD1Repo(d1 as unknown as D1Like, "user-b");
    await repoA.upsert(makeNote("https://example.com/a"));
    expect(await repoA.countAll()).toBe(1);
    expect(await repoB.countAll()).toBe(0);
  });
});

// ── RoadmapGoalsD1Repo ───────────────────────────────────────────────────────

describe("RoadmapGoalsD1Repo", () => {
  test("upsertByTopic inserts then getById returns it", async () => {
    const repo = new RoadmapGoalsD1Repo(d1 as unknown as D1Like, USER);
    const now = new Date();
    const id = await repo.upsertByTopic({
      topic: "Japanese",
      nodes: [{ id: "n1", title: "Hiragana", description: "", keywords: ["kana"], order: 0 }],
      createdAt: now,
      updatedAt: now,
    });
    const got = await repo.getById(id);
    expect(got!.topic).toBe("Japanese");
    expect(got!.nodes).toHaveLength(1);
    expect(got!.createdAt).toBeInstanceOf(Date);
  });

  test("upsertByTopic is idempotent by topic", async () => {
    const repo = new RoadmapGoalsD1Repo(d1 as unknown as D1Like, USER);
    const now = new Date();
    const id1 = await repo.upsertByTopic({
      topic: "Spanish",
      nodes: [],
      createdAt: now,
      updatedAt: now,
    });
    const id2 = await repo.upsertByTopic({
      topic: "Spanish",
      nodes: [],
      createdAt: now,
      updatedAt: now,
    });
    expect(id1).toBe(id2);
    expect(await repo.listAll()).toHaveLength(1);
  });

  test("delete removes the goal", async () => {
    const repo = new RoadmapGoalsD1Repo(d1 as unknown as D1Like, USER);
    const now = new Date();
    const id = await repo.upsertByTopic({
      topic: "French",
      nodes: [],
      createdAt: now,
      updatedAt: now,
    });
    await repo.delete(id);
    expect(await repo.getById(id)).toBeNull();
  });
});

// ── PreferencesD1Repo ────────────────────────────────────────────────────────

describe("PreferencesD1Repo", () => {
  test("get returns null when unset", async () => {
    const repo = new PreferencesD1Repo(d1 as unknown as D1Like, USER);
    expect(await repo.get()).toBeNull();
  });

  test("set then get round-trips patterns", async () => {
    const repo = new PreferencesD1Repo(d1 as unknown as D1Like, USER);
    await repo.set([
      {
        id: "p1",
        type: "domain",
        pattern: "youtube.com",
        isRegex: false,
        enabled: true,
        createdAt: "x",
      },
    ]);
    const got = await repo.get();
    expect(got!.mobileExcludePatterns).toHaveLength(1);
    expect(got!.mobileExcludePatterns[0].pattern).toBe("youtube.com");
  });

  test("set overwrites existing", async () => {
    const repo = new PreferencesD1Repo(d1 as unknown as D1Like, USER);
    await repo.set([
      { id: "p1", type: "domain", pattern: "a.com", isRegex: false, enabled: true, createdAt: "x" },
    ]);
    await repo.set([]);
    expect((await repo.get())!.mobileExcludePatterns).toHaveLength(0);
  });
});

// ── ApiTokensD1Repo ──────────────────────────────────────────────────────────

describe("ApiTokensD1Repo", () => {
  test("insert then emailByHash", async () => {
    const repo = new ApiTokensD1Repo(d1 as unknown as D1Like);
    await repo.insert({
      tokenHash: "hash1",
      email: "u@example.com",
      name: "cli",
      createdAt: new Date(),
    });
    expect(await repo.emailByHash("hash1")).toBe("u@example.com");
    expect(await repo.emailByHash("nope")).toBeNull();
  });

  test("listByEmail and delete", async () => {
    const repo = new ApiTokensD1Repo(d1 as unknown as D1Like);
    await repo.insert({
      tokenHash: "h1",
      email: "u@example.com",
      name: "a",
      createdAt: new Date(),
    });
    await repo.insert({
      tokenHash: "h2",
      email: "u@example.com",
      name: "b",
      createdAt: new Date(),
    });
    expect(await repo.listByEmail("u@example.com")).toHaveLength(2);
    await repo.delete("h1");
    expect(await repo.listByEmail("u@example.com")).toHaveLength(1);
  });
});

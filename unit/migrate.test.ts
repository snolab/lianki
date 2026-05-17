import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { sqlLiteral, buildInsert } from "@/lib/migrate/sqlGen";
import { generateMigrationSql } from "@/lib/migrate/runMigration";
import { createTestD1 } from "@/lib/d1/testDb";
import type { D1Like } from "@/lib/d1/types";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { RoadmapGoalsD1Repo, PreferencesD1Repo, ApiTokensD1Repo } from "@/lib/repos/d1Repos";

const SCHEMA = readFileSync(join(process.cwd(), "db/migrations/0001_init.sql"), "utf8");

// ── sqlGen unit tests ────────────────────────────────────────────────────────

describe("sqlLiteral", () => {
  test("renders primitives", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(undefined)).toBe("NULL");
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(true)).toBe("1");
    expect(sqlLiteral(false)).toBe("0");
    expect(sqlLiteral("hi")).toBe("'hi'");
  });

  test("escapes single quotes", () => {
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(sqlLiteral("a'b'c")).toBe("'a''b''c'");
  });

  test("renders Date as ISO string literal", () => {
    expect(sqlLiteral(new Date("2026-01-02T03:04:05Z"))).toBe("'2026-01-02T03:04:05.000Z'");
  });

  test("renders objects as JSON, with nested Dates as ISO", () => {
    const out = sqlLiteral({ a: 1, when: new Date("2026-01-01T00:00:00Z") });
    expect(out).toBe(`'{"a":1,"when":"2026-01-01T00:00:00.000Z"}'`);
  });

  test("non-finite numbers become NULL", () => {
    expect(sqlLiteral(NaN)).toBe("NULL");
    expect(sqlLiteral(Infinity)).toBe("NULL");
  });
});

describe("buildInsert", () => {
  test("builds an INSERT OR REPLACE with matching column order", () => {
    const stmt = buildInsert("preferences", {
      user_id: "u1",
      mobile_exclude_patterns: "[]",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    expect(stmt).toBe(
      "INSERT OR REPLACE INTO preferences (user_id, mobile_exclude_patterns, updated_at) " +
        "VALUES ('u1', '[]', '2026-01-01T00:00:00.000Z');",
    );
  });

  test("throws on empty row", () => {
    expect(() => buildInsert("t", {})).toThrow();
  });
});

// ── End-to-end: Mongo -> SQL -> D1 ───────────────────────────────────────────

describe("generateMigrationSql (Mongo -> D1 end to end)", () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
    const db = client.db("lianki-test");
    const now = new Date("2026-05-01T00:00:00Z");

    await db.collection("user").insertOne({
      id: "u1",
      email: "alice@example.com",
      name: "Alice",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
      trialEndsAt: new Date("2026-08-01T00:00:00Z"),
    });
    await db.collection("session").insertOne({
      id: "s1",
      userId: "u1",
      token: "tok-1",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      createdAt: now,
      updatedAt: now,
    });
    await db.collection("account").insertOne({
      id: "ac1",
      userId: "u1",
      accountId: "gh-123",
      providerId: "github",
      createdAt: now,
      updatedAt: now,
    });

    await db.collection("FSRSNotes@alice@example.com").insertOne({
      url: "https://example.com/page",
      title: "A page",
      card: { due: new Date("2026-05-10T00:00:00Z"), stability: 1, difficulty: 5, reps: 2 },
      log: [{ rating: 3, review: new Date("2026-05-01T00:00:00Z") }],
      notes: "note's text",
      hlc: { timestamp: 123, counter: 0, deviceId: "server" },
    });
    await db.collection("RoadmapGoals@alice@example.com").insertOne({
      topic: "Japanese",
      nodes: [{ id: "n1", title: "Kana", description: "", keywords: ["kana"], order: 0 }],
      createdAt: now,
      updatedAt: now,
    });
    await db.collection("preferences").insertOne({
      userId: "u1",
      mobileExcludePatterns: [
        {
          id: "p1",
          type: "domain",
          pattern: "x.com",
          isRegex: false,
          enabled: true,
          createdAt: "z",
        },
      ],
      updatedAt: now,
    });
    await db.collection("ApiTokens").insertOne({
      tokenHash: "abc123",
      email: "alice@example.com",
      name: "cli token",
      createdAt: now,
    });

    // orphan: no matching user
    await db.collection("FSRSNotes@ghost@nowhere.com").insertOne({
      url: "https://ghost.com",
      card: { due: now },
      log: [],
    });
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await mongod?.stop();
  });

  test("generates SQL that loads cleanly into D1 with correct data", async () => {
    const { sql, counts, warnings } = await generateMigrationSql(client.db("lianki-test"));

    expect(counts.user).toBe(1);
    expect(counts.session).toBe(1);
    expect(counts.account).toBe(1);
    // alice's note + the ghost note — both keyed by email, so neither is dropped
    expect(counts.fsrs_notes).toBe(2);
    expect(counts.roadmap_goals).toBe(1);
    expect(counts.preferences).toBe(1);
    expect(counts.api_tokens).toBe(1);
    expect(warnings).toHaveLength(0);

    // apply schema + generated data into a fresh in-memory D1
    const d1 = createTestD1(SCHEMA);
    d1.raw().exec(sql);
    const db = d1 as unknown as D1Like;

    // user row
    const user = await db.prepare("SELECT * FROM user WHERE id = ?").bind("u1").first();
    expect(user!.email).toBe("alice@example.com");
    expect(user!.emailVerified).toBe(1);
    expect(user!.trialEndsAt).toBe("2026-08-01T00:00:00.000Z");

    // fsrs note — keyed by email, dates restored on read
    const notes = new FsrsNotesD1Repo(db, "alice@example.com");
    expect(await notes.countAll()).toBe(1);
    const note = await notes.getByUrl("https://example.com/page");
    expect(note!.title).toBe("A page");
    expect(note!.notes).toBe("note's text");
    expect(note!.card.due).toBeInstanceOf(Date);
    expect(note!.card.reps).toBe(2);
    // the ghost collection migrated under its own email key
    expect(await new FsrsNotesD1Repo(db, "ghost@nowhere.com").countAll()).toBe(1);

    // roadmap goal
    const goals = await new RoadmapGoalsD1Repo(db, "alice@example.com").listAll();
    expect(goals).toHaveLength(1);
    expect(goals[0].topic).toBe("Japanese");
    expect(goals[0].nodes).toHaveLength(1);

    // preferences
    const prefs = await new PreferencesD1Repo(db, "u1").get();
    expect(prefs!.mobileExcludePatterns[0].pattern).toBe("x.com");

    // api token
    expect(await new ApiTokensD1Repo(db).emailByHash("abc123")).toBe("alice@example.com");
  }, 60_000);
});

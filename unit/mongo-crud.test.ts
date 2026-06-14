/**
 * MongoDB CRUD Matrix
 *
 * Tests the fsrsHandler API against an in-memory MongoDB instance.
 * Covers every CRUD verb on the MongoDB layer + HLC conflict detection.
 *
 * Sync edges tested:
 *   direct caller → MongoDB (CREATE, READ, UPDATE, DELETE, CONFLICT)
 */

import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Collection } from "mongodb";

// -- Mock Next.js cache (not available outside Next.js runtime) --
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: () => unknown) => fn),
}));

// -- Lazy reference so beforeAll can assign before any call --
let testCollection: Collection;
vi.mock("@/app/getFSRSNotesCollection", () => ({
  getFSRSNotesCollection: () => testCollection,
}));

// Import AFTER mocks are registered
import { fsrsHandler } from "@/app/fsrs";

// ── Infra ──────────────────────────────────────────────────────────────────────

let mongod: MongoMemoryServer;
let mongoClient: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  mongoClient = new MongoClient(mongod.getUri());
  await mongoClient.connect();
  testCollection = mongoClient.db("lianki-test").collection("FSRSNotes@test");
}, 30_000);

afterAll(async () => {
  await mongoClient?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await testCollection.deleteMany({});
});

// ── Helpers ────────────────────────────────────────────────────────────────────

const TEST_EMAIL = "test@example.com";
const TEST_URL = "https://example.com/test-page";
const TEST_URL_2 = "https://example.com/page-two";

function makeReq(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

async function createNote(url = TEST_URL, title = "Test Page") {
  const res = await fsrsHandler(makeReq("POST", "/api/fsrs/add", { url, title }), TEST_EMAIL);
  return res.json();
}

// ── CREATE ─────────────────────────────────────────────────────────────────────

describe("CREATE", () => {
  test("POST /api/fsrs/add inserts a note with empty FSRS card and HLC", async () => {
    const res = await fsrsHandler(
      makeReq("POST", "/api/fsrs/add", { url: TEST_URL, title: "Test Page" }),
      TEST_EMAIL,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.url).toBe(TEST_URL);
    expect(data.card).toBeDefined();
    expect(data.card.reps).toBe(0);
    expect(data.hlc).toBeDefined();
    expect(data.hlc.deviceId).toBe("server");

    const doc = await testCollection.findOne({ url: TEST_URL });
    expect(doc).not.toBeNull();
    expect(doc!.card.reps).toBe(0);
  });

  test("POST /api/fsrs/add returns review options in the same response", async () => {
    const data = await createNote();
    expect(Array.isArray(data.options)).toBe(true);
    expect(data.options).toHaveLength(4);
    const labels = data.options.map((o: { label: string }) => o.label);
    expect(labels).toEqual(["Again", "Hard", "Good", "Easy"]);
  });

  test("POST /api/fsrs/add is idempotent for the same URL", async () => {
    await createNote();
    await createNote();
    const count = await testCollection.countDocuments({ url: TEST_URL });
    expect(count).toBe(1);
  });

  test("POST /api/fsrs/batch-add creates multiple notes", async () => {
    const res = await fsrsHandler(
      makeReq("POST", "/api/fsrs/batch-add", {
        urls: [TEST_URL, TEST_URL_2],
      }),
      TEST_EMAIL,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(2);
    expect(data.failed).toBe(0);

    const count = await testCollection.countDocuments({});
    expect(count).toBe(2);
  });
});

// ── READ ───────────────────────────────────────────────────────────────────────

describe("READ", () => {
  test("GET /api/fsrs/options returns 4 FSRS options for existing note", async () => {
    await createNote();
    const res = await fsrsHandler(
      makeReq("GET", `/api/fsrs/options?url=${encodeURIComponent(TEST_URL)}`),
      TEST_EMAIL,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.options).toHaveLength(4);
    expect(data.options[0]).toHaveProperty("rating");
    expect(data.options[0]).toHaveProperty("due");
    expect(data.id).toBeDefined();
  });

  test("GET /api/fsrs/due returns cards due now", async () => {
    await createNote(TEST_URL);
    await createNote(TEST_URL_2);
    // Force both cards to be overdue
    await testCollection.updateMany({}, { $set: { "card.due": new Date(Date.now() - 60_000) } });

    const res = await fsrsHandler(makeReq("GET", "/api/fsrs/due"), TEST_EMAIL);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cards.length).toBeGreaterThanOrEqual(2);
    const urls = data.cards.map((c: { url: string }) => c.url);
    expect(urls).toContain(TEST_URL);
    expect(urls).toContain(TEST_URL_2);
  });

  test("GET /api/fsrs/due respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await createNote(`https://example.com/page-${i}`);
    }
    await testCollection.updateMany({}, { $set: { "card.due": new Date(Date.now() - 60_000) } });

    const res = await fsrsHandler(makeReq("GET", "/api/fsrs/due?limit=2"), TEST_EMAIL);
    const data = await res.json();
    expect(data.cards).toHaveLength(2);
  });

  test("GET /api/fsrs/next-url returns the next due card URL", async () => {
    await createNote(TEST_URL);
    await createNote(TEST_URL_2);
    await testCollection.updateOne(
      { url: TEST_URL_2 },
      { $set: { "card.due": new Date(Date.now() - 60_000) } },
    );

    const res = await fsrsHandler(makeReq("GET", "/api/fsrs/next-url"), TEST_EMAIL);
    const data = await res.json();
    expect(data.url).toBe(TEST_URL_2);
  });
});

// ── UPDATE ─────────────────────────────────────────────────────────────────────

describe("UPDATE", () => {
  test("POST /api/fsrs/review/good advances card reps and state", async () => {
    await createNote();
    const res = await fsrsHandler(
      makeReq("POST", `/api/fsrs/review/good?url=${encodeURIComponent(TEST_URL)}`),
      TEST_EMAIL,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.hlc).toBeDefined();

    const doc = await testCollection.findOne({ url: TEST_URL });
    expect(doc!.card.reps).toBe(1);
    expect(doc!.log).toHaveLength(1);
  });

  test("POST /api/fsrs/review supports all 4 ratings", async () => {
    for (const rating of ["again", "hard", "good", "easy"]) {
      await testCollection.deleteMany({});
      await createNote();
      const res = await fsrsHandler(
        makeReq("POST", `/api/fsrs/review/${rating}?url=${encodeURIComponent(TEST_URL)}`),
        TEST_EMAIL,
      );
      expect(res.status, `rating '${rating}' should succeed`).toBe(200);
    }
  });

  test("POST /api/fsrs/review with fresh HLC succeeds", async () => {
    await createNote();
    const freshHLC = { timestamp: Date.now() + 10_000, counter: 0, deviceId: "device-a" };
    const res = await fsrsHandler(
      makeReq("POST", `/api/fsrs/review/good?url=${encodeURIComponent(TEST_URL)}`, {
        hlc: freshHLC,
      }),
      TEST_EMAIL,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("POST /api/fsrs/review with STALE HLC returns 409 conflict", async () => {
    await createNote();
    // First review advances the server HLC
    await fsrsHandler(
      makeReq("POST", `/api/fsrs/review/good?url=${encodeURIComponent(TEST_URL)}`),
      TEST_EMAIL,
    );

    // Second review with a stale HLC (timestamp in the past)
    const staleHLC = { timestamp: 1000, counter: 0, deviceId: "device-old" };
    const res = await fsrsHandler(
      makeReq("POST", `/api/fsrs/review/good?url=${encodeURIComponent(TEST_URL)}`, {
        hlc: staleHLC,
      }),
      TEST_EMAIL,
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("conflict");
    expect(data.serverHLC).toBeDefined();
    expect(data.card).toBeDefined();
  });

  test("PATCH /api/fsrs/notes updates the notes field", async () => {
    await createNote();
    const res = await fsrsHandler(
      makeReq("PATCH", `/api/fsrs/notes?url=${encodeURIComponent(TEST_URL)}`, {
        notes: "My study notes",
      }),
      TEST_EMAIL,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const doc = await testCollection.findOne({ url: TEST_URL });
    expect(doc!.notes).toBe("My study notes");
  });

  test("PATCH /api/fsrs/update-url renames a note URL", async () => {
    const newUrl = "https://example.com/renamed-page";
    await createNote();
    const res = await fsrsHandler(
      makeReq("PATCH", "/api/fsrs/update-url", {
        oldUrl: TEST_URL,
        newUrl,
      }),
      TEST_EMAIL,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    expect(await testCollection.findOne({ url: TEST_URL })).toBeNull();
    expect(await testCollection.findOne({ url: newUrl })).not.toBeNull();
  });
});

// ── DELETE ─────────────────────────────────────────────────────────────────────

describe("DELETE", () => {
  test("GET /api/fsrs/delete removes the note", async () => {
    await createNote();
    const res = await fsrsHandler(
      makeReq("GET", `/api/fsrs/delete?url=${encodeURIComponent(TEST_URL)}`),
      TEST_EMAIL,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const doc = await testCollection.findOne({ url: TEST_URL });
    expect(doc).toBeNull();
  });

  test("GET /api/fsrs/delete returns next due card URL", async () => {
    await createNote(TEST_URL);
    await createNote(TEST_URL_2);
    await testCollection.updateOne(
      { url: TEST_URL_2 },
      { $set: { "card.due": new Date(Date.now() - 60_000) } },
    );

    const res = await fsrsHandler(
      makeReq("GET", `/api/fsrs/delete?url=${encodeURIComponent(TEST_URL)}`),
      TEST_EMAIL,
    );
    const data = await res.json();
    expect(data.nextUrl).toBe(TEST_URL_2);
  });
});

// ── CROSS-LAYER: Review log accumulates over multiple syncs ────────────────────

describe("Review log accumulation (cross-sync consistency)", () => {
  test("each review appends one entry to the log", async () => {
    await createNote();

    for (const rating of ["again", "hard", "good"]) {
      await fsrsHandler(
        makeReq("POST", `/api/fsrs/review/${rating}?url=${encodeURIComponent(TEST_URL)}`),
        TEST_EMAIL,
      );
    }

    const doc = await testCollection.findOne({ url: TEST_URL });
    expect(doc!.card.reps).toBe(3);
    expect(doc!.log).toHaveLength(3);
  });

  test("HLC advances monotonically across reviews", async () => {
    await createNote();

    const hlcs: number[] = [];
    for (const rating of ["good", "good", "good"]) {
      const res = await fsrsHandler(
        makeReq("POST", `/api/fsrs/review/${rating}?url=${encodeURIComponent(TEST_URL)}`),
        TEST_EMAIL,
      );
      const data = await res.json();
      hlcs.push(data.hlc.timestamp);
    }

    // Each HLC timestamp should be >= previous
    for (let i = 1; i < hlcs.length; i++) {
      expect(hlcs[i]).toBeGreaterThanOrEqual(hlcs[i - 1]!);
    }
  });
});

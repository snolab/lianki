/**
 * The bare-HTML review flow, pinned byte for byte.
 *
 * The owner still uses /api/fsrs/next → /api/fsrs/repeat → /api/fsrs/review/<n>
 * now and then (owner, 2026-11-01: "不要破坏原来的api或者html"). The in-site
 * /review page is built beside it and reuses the same API, so these routes'
 * responses must not move by one byte. Each one is rendered for a fixture card
 * at a fixed clock and compared with the file under unit/fixtures/legacy-review/.
 *
 * The fixtures were written from the code as it was before /review existed. A
 * deliberate change to the legacy flow regenerates them with
 * `LIANKI_UPDATE_LEGACY_FIXTURES=1 bun test unit/legacy-review-routes.test.ts`
 * — and needs the owner's say-so first.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, ObjectId, type Collection } from "mongodb";
import { createEmptyCard, type Card } from "ts-fsrs";
import { useBackend, useNotesCollection } from "./support/testMocks";

const { fsrsHandler } = await import("@/app/fsrs");

const FIXTURES = join(import.meta.dir, "fixtures", "legacy-review");
const UPDATE = process.env.LIANKI_UPDATE_LEGACY_FIXTURES === "1";
const NOW = new Date("2026-11-01T00:00:00.000Z");
const EMAIL = "legacy@example.com";
const ID = "65a1b2c3d4e5f60718293a4b";
const OTHER_ID = "65a1b2c3d4e5f60718293a4c";

let mongod: MongoMemoryServer;
let client: MongoClient;
let notes: Collection;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  notes = client.db("lianki-test").collection("FSRSNotes@legacy");
}, 30_000);

afterAll(async () => {
  setSystemTime();
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  useNotesCollection(notes);
  useBackend("mongodb");
  setSystemTime(NOW);
  await notes.deleteMany({});
  const day = 864e5;
  await notes.insertMany([
    {
      _id: new ObjectId(ID),
      url: "https://example.com/fixture-page",
      title: "Fixture <page> & title",
      card: { ...(createEmptyCard(new Date(+NOW - 3 * day)) as Card), due: new Date(+NOW - day) },
      log: [],
      hlc: { timestamp: +NOW - day, counter: 0, deviceId: "server" },
    },
    {
      _id: new ObjectId(OTHER_ID),
      url: "https://example.org/later",
      title: "Not due yet",
      card: { ...(createEmptyCard(new Date(+NOW - day)) as Card), due: new Date(+NOW + 2 * day) },
      log: [],
      hlc: { timestamp: +NOW - day, counter: 0, deviceId: "server" },
    },
  ]);
});

const get = (path: string) => fsrsHandler(new Request(`http://localhost${path}`), EMAIL);

/** Status, content type and body, as one text, so a header change shows up too. */
async function render(res: Response) {
  return `${res.status} ${res.headers.get("content-type")}\n\n${await res.text()}`;
}

/** Fixtures are plain .txt (status line + body), so no formatter ever rewrites them. */
function matchFixture(name: string, actual: string) {
  const file = join(FIXTURES, `${name}.txt`);
  if (UPDATE || !existsSync(file)) {
    if (!UPDATE)
      throw new Error(`missing fixture ${name}: run with LIANKI_UPDATE_LEGACY_FIXTURES=1`);
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, actual);
  }
  expect(actual).toBe(readFileSync(file, "utf8"));
}

describe("legacy review flow, byte for byte", () => {
  test("GET /api/fsrs/next opens the due card and goes to the grading page", async () => {
    matchFixture("next.html", await render(await get("/api/fsrs/next")));
  });

  test("GET /api/fsrs/next with nothing due: the alert", async () => {
    await notes.deleteOne({ _id: new ObjectId(ID) });
    matchFixture("next-empty.html", await render(await get("/api/fsrs/next")));
  });

  test("GET /api/fsrs/repeat?id= renders the bare grading page", async () => {
    matchFixture("repeat.html", await render(await get(`/api/fsrs/repeat/?id=${ID}`)));
  });

  test("GET /api/fsrs/review/3?id= grades and names the next card", async () => {
    matchFixture("review-3.json", await render(await get(`/api/fsrs/review/3/?id=${ID}`)));
  });

  test("GET /api/fsrs/options?id= gives the four intervals", async () => {
    matchFixture("options.json", await render(await get(`/api/fsrs/options?id=${ID}`)));
  });

  test("GET /api/fsrs/delete?id= removes the card", async () => {
    matchFixture("delete.json", await render(await get(`/api/fsrs/delete?id=${ID}`)));
  });
});

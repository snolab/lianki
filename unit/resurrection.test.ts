import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, test, beforeEach, it } from "bun:test";
import { createEmptyCard } from "ts-fsrs";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { D1FsrsCollection } from "@/app/fsrsNotesD1Collection";
import type { FSRSNote } from "@/app/fsrs";
import { newServerHLC } from "@lianki/core";

/**
 * A deleted card must not come back when you open its page.
 *
 * Tombstones alone did not close this. `addNote` fires on dialog-open and
 * carries a fresh server HLC, which is strictly newer than any tombstone — so
 * the "newer write wins" rule, correct for a review, revived deleted cards on
 * mere page visits. Reported as a YouTube card that reappeared after every
 * delete.
 *
 * Three defences, one per layer, all tested here.
 */
const SCHEMA = testSchema();
const EMAIL = "user@example.com";
const URL_A = "https://www.youtube.com/watch?v=cPyFIvCvh8U";

let d1: TestD1Database;
let repo: FsrsNotesD1Repo;
let collection: D1FsrsCollection;
beforeEach(() => {
  d1 = createTestD1(SCHEMA);
  repo = new FsrsNotesD1Repo(d1 as unknown as D1Like, EMAIL);
  collection = new D1FsrsCollection(d1 as unknown as D1Like, EMAIL);
});

const note = (url = URL_A, over: Partial<FSRSNote> = {}): FSRSNote =>
  ({ url, title: "T", card: createEmptyCard(), log: [], ...over }) as FSRSNote;

describe("the add path never resurrects", () => {
  test("opening a deleted page leaves the tombstone alone", async () => {
    await repo.upsert(note());
    await repo.delete(URL_A);

    // Exactly what saveNote issues: $setOnInsert with a fresh server clock.
    await collection.findOneAndUpdate(
      { url: URL_A },
      {
        $setOnInsert: { card: createEmptyCard(), url: URL_A, hlc: newServerHLC() },
        $set: { title: "What Happens to Your Body When You Quit Sugar" },
      },
    );

    expect(await repo.getByUrl(URL_A)).toBeNull();
    expect(await repo.getTombstone(URL_A)).not.toBeNull();
  });

  test("repeated visits still do not revive it", async () => {
    await repo.upsert(note());
    await repo.delete(URL_A);
    for (let i = 0; i < 3; i++) {
      await collection.findOneAndUpdate(
        { url: URL_A },
        { $setOnInsert: { card: createEmptyCard(), url: URL_A, hlc: newServerHLC() } },
      );
    }
    expect(await repo.getByUrl(URL_A)).toBeNull();
  });

  test("a genuine review still revives it — the merge rule is intact", async () => {
    // Rule 1: delete on one device, review later on another. A review is a
    // deliberate act; opening a page is not.
    await repo.upsert(note());
    await repo.delete(URL_A);
    // Explicitly later: newServerHLC() in the same millisecond as the delete
    // ties, and a tie loses by design — only a strictly newer write revives.
    const later = { timestamp: Date.now() + 60_000, counter: 0, deviceId: "dev-b" };
    await repo.upsert(note(URL_A, { hlc: later, title: "reviewed" }));
    expect(await repo.getByUrl(URL_A)).not.toBeNull();
  });

  test("an add still creates a card that was never deleted", async () => {
    const fresh = "https://example.test/new";
    const doc = await collection.findOneAndUpdate(
      { url: fresh },
      { $setOnInsert: { card: createEmptyCard(), url: fresh, hlc: newServerHLC() } },
    );
    expect(doc).not.toBeNull();
    expect(await repo.getByUrl(fresh)).not.toBeNull();
  });

  test("resurrect:false is what blocks it, not a missing clock", async () => {
    // Belt and braces: prove the flag itself, since the HLC here IS newer.
    await repo.upsert(note());
    await repo.delete(URL_A);
    const newer = { timestamp: Date.now() + 60_000, counter: 0, deviceId: "dev-b" };
    await repo.upsert(note(URL_A, { hlc: newer }), undefined, { resurrect: false });
    expect(await repo.getByUrl(URL_A)).toBeNull();
  });
});

describe("restoring a deleted card", () => {
  test("an explicit restore revives it", async () => {
    await repo.upsert(note());
    await repo.delete(URL_A);
    await collection.findOneAndUpdate(
      { url: URL_A },
      { $setOnInsert: { card: createEmptyCard(), url: URL_A, hlc: newServerHLC() } },
      { restore: true },
    );
    expect(await repo.getByUrl(URL_A)).not.toBeNull();
    expect(await repo.getTombstone(URL_A)).toBeNull();
  });

  test("a restore wins even against a NEWER tombstone", async () => {
    // Someone pressing Restore is looking at the card and asking for it back;
    // no clock comparison should be able to tell them no. Clock skew between
    // devices would otherwise make the button silently do nothing.
    await repo.upsert(note());
    await repo.delete(URL_A);
    await (d1 as unknown as D1Like)
      .prepare("UPDATE fsrs_notes SET hlc = ? WHERE email = ? AND url = ?")
      .bind(
        JSON.stringify({ timestamp: Date.now() + 600_000, counter: 0, deviceId: "zzz" }),
        EMAIL,
        URL_A,
      )
      .run();
    await repo.upsert(
      note(URL_A, { hlc: { timestamp: 1, counter: 0, deviceId: "a" } }),
      undefined,
      {
        resurrect: true,
      },
    );
    expect(await repo.getByUrl(URL_A)).not.toBeNull();
  });

  test("restoring does not resurrect every other deleted card", async () => {
    await repo.upsert(note());
    await repo.upsert(note("https://other.test/1"));
    await repo.delete(URL_A);
    await repo.delete("https://other.test/1");
    await collection.findOneAndUpdate(
      { url: URL_A },
      { $setOnInsert: { card: createEmptyCard(), url: URL_A, hlc: newServerHLC() } },
      { restore: true },
    );
    expect(await repo.getByUrl("https://other.test/1")).toBeNull();
  });

  test("a plain add is still refused after a restore of a different url", async () => {
    await repo.upsert(note("https://other.test/1"));
    await repo.delete("https://other.test/1");
    await collection.findOneAndUpdate(
      { url: "https://other.test/1" },
      {
        $setOnInsert: { card: createEmptyCard(), url: "https://other.test/1", hlc: newServerHLC() },
      },
    );
    expect(await repo.getByUrl("https://other.test/1")).toBeNull();
  });
});

describe("the userscript side", () => {
  const BUILT = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");

  it("checks the flag deleteCard actually writes", () => {
    // It used to read `deletedAt`, which exists only on the card record, so it
    // answered "not deleted" for every tombstone — and nothing called it.
    expect(BUILT).toMatch(/isDeleted\(/);
    expect(BUILT).toMatch(/e\.del \|\| e\.deletedAt/);
  });

  it("consults it before adding, so a deleted page adds nothing", () => {
    expect(BUILT).toMatch(/isDeleted\(url\)/);
    expect(BUILT).toMatch(/You deleted this card/);
  });

  it("offers a way back instead of a dead end", () => {
    // The first build of the guard said "You deleted this card." and gave the
    // user no way to disagree.
    expect(BUILT).toMatch(/Restore it/);
    expect(BUILT).toMatch(/restoreCard\(/);
    expect(BUILT).toMatch(/restore: true/);
    expect(BUILT).toMatch(/KeyR/);
  });

  it("drops the tombstone record so the add path can repopulate it", () => {
    expect(BUILT).toMatch(/GM_deleteValue\(/);
  });

  it("sends the url with a delete, so a stale id cannot strand the row", () => {
    expect(BUILT).toMatch(/\/api\/fsrs\/delete\?id=/);
    expect(BUILT).toMatch(/&url=/);
  });
});

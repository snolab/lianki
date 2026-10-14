import { describe, test, expect, beforeEach } from "bun:test";
import { createEmptyCard } from "ts-fsrs";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import type { FSRSNote } from "@/app/fsrs";
import type { HLC } from "@lianki/core";

/**
 * Server-side tombstones.
 *
 * The cloud used to delete rows outright while the userscript kept tombstones
 * locally, and that asymmetry breaks deletion across devices: the server cannot
 * express "deleted", so any client still holding the card as live re-uploads it
 * on its next save and the server upserts it back. Seen in the wild with two
 * installs in one browser — one deleted, the other resurrected, indefinitely.
 *
 * An absence cannot win a merge; only a value can. docs/sync-merge-rules.md.
 */
const SCHEMA = testSchema();
const EMAIL = "user@example.com";
const URL_A = "https://www.youtube.com/watch?v=cPyFIvCvh8U";

let d1: TestD1Database;
let repo: FsrsNotesD1Repo;
beforeEach(() => {
  d1 = createTestD1(SCHEMA);
  repo = new FsrsNotesD1Repo(d1 as unknown as D1Like, EMAIL);
});

const hlc = (timestamp: number, deviceId = "dev-a"): HLC => ({ timestamp, counter: 0, deviceId });

function note(url = URL_A, over: Partial<FSRSNote> = {}): FSRSNote {
  return { url, title: "T", card: createEmptyCard(), log: [], notes: "", ...over } as FSRSNote;
}

/** Rows as actually stored, tombstones included — what every read must filter. */
async function rawCount() {
  const { results } = await (d1 as unknown as D1Like)
    .prepare("SELECT COUNT(*) AS c FROM fsrs_notes WHERE email = ?")
    .bind(EMAIL)
    .all<{ c: number }>();
  return results?.[0]?.c ?? 0;
}

describe("delete leaves a tombstone, not a hole", () => {
  test("the row survives but no read returns it", async () => {
    await repo.upsert(note());
    await repo.delete(URL_A);

    expect(await rawCount()).toBe(1); // the tombstone is still there
    expect(await repo.getByUrl(URL_A)).toBeNull();
    expect(await repo.listAll()).toHaveLength(0);
    expect(await repo.countAll()).toBe(0);
    expect(await repo.countDue(new Date())).toBe(0);
    expect(await repo.listDue(new Date(), 10)).toHaveLength(0);
    expect((await repo.query({})).total).toBe(0);
  });

  test("the card body is cleared — a tombstone is not a copy of the card", async () => {
    await repo.upsert(note(URL_A, { title: "Secret title", notes: "private" }));
    await repo.delete(URL_A);
    const [t] = await repo.listTombstones();
    expect(t.url).toBe(URL_A);
    expect(t.deletedAt).toBeTruthy();
    const { results } = await (d1 as unknown as D1Like)
      .prepare("SELECT title, notes FROM fsrs_notes WHERE email = ? AND url = ?")
      .bind(EMAIL, URL_A)
      .all<{ title: string | null; notes: string | null }>();
    expect(results?.[0]?.title).toBeNull();
    expect(results?.[0]?.notes).toBeNull();
  });

  test("getById does not reach a deleted card either", async () => {
    const id = await repo.upsert(note());
    await repo.delete(URL_A);
    expect(await repo.getById(id)).toBeNull();
  });
});

describe("a tombstone can win a merge", () => {
  test("a stale live copy does NOT resurrect the card", async () => {
    // The whole bug: another device still holds the card and saves it.
    await repo.upsert(note(URL_A, { hlc: hlc(1_000) }));
    await repo.delete(URL_A); // tombstone gets a fresh server HLC (now)
    await repo.upsert(note(URL_A, { hlc: hlc(1_001) })); // stale: older than the delete
    expect(await repo.getByUrl(URL_A)).toBeNull();
  });

  test("a write with no clock loses, because addNote fires on merely opening the dialog", async () => {
    await repo.upsert(note());
    await repo.delete(URL_A);
    await repo.upsert(note()); // no hlc at all
    expect(await repo.getByUrl(URL_A)).toBeNull();
  });

  test("a genuinely newer review DOES resurrect it — last write wins, both ways", async () => {
    // Rule 1 in the merge table: delete on one device, review later on
    // another, and the review is a real intent expressed afterwards.
    await repo.upsert(note());
    await repo.delete(URL_A);
    const later = hlc(Date.now() + 60_000, "dev-b");
    await repo.upsert(note(URL_A, { hlc: later, title: "reviewed later" }));
    const got = await repo.getByUrl(URL_A);
    expect(got).not.toBeNull();
    expect(got!.title).toBe("reviewed later");
  });

  test("resurrection clears the tombstone rather than leaving both", async () => {
    await repo.upsert(note());
    await repo.delete(URL_A);
    await repo.upsert(note(URL_A, { hlc: hlc(Date.now() + 60_000) }));
    expect(await repo.listTombstones()).toHaveLength(0);
  });
});

describe("bulk deletes are tombstones too", () => {
  test("deleteMany tombstones and reports what it changed", async () => {
    await repo.upsert(note("https://a.test/1"));
    await repo.upsert(note("https://a.test/2"));
    expect(await repo.deleteMany(["https://a.test/1", "https://a.test/2"])).toBe(2);
    expect(await repo.countAll()).toBe(0);
    expect(await repo.listTombstones()).toHaveLength(2);
  });

  test("deleting the same url twice is idempotent, not double-counted", async () => {
    await repo.upsert(note("https://a.test/1"));
    expect(await repo.deleteMany(["https://a.test/1"])).toBe(1);
    expect(await repo.deleteMany(["https://a.test/1"])).toBe(0);
  });

  test("deleteAll tombstones every live card", async () => {
    await repo.upsert(note("https://a.test/1"));
    await repo.upsert(note("https://a.test/2"));
    await repo.deleteAll();
    expect(await repo.countAll()).toBe(0);
    expect(await repo.listTombstones()).toHaveLength(2);
  });
});

describe("retention sweep", () => {
  test("keeps a tombstone inside the window and sweeps one past it", async () => {
    // 90 days must exceed any plausible offline period: it is the window in
    // which a returning device can still learn about a deletion cheaply.
    await repo.upsert(note("https://fresh.test/1"));
    await repo.upsert(note("https://old.test/1"));
    await repo.delete("https://fresh.test/1");
    await repo.delete("https://old.test/1");

    // Age the second tombstone past the window.
    await (d1 as unknown as D1Like)
      .prepare("UPDATE fsrs_notes SET deleted_at = ? WHERE email = ? AND url = ?")
      .bind(new Date(Date.now() - 100 * 86_400_000).toISOString(), EMAIL, "https://old.test/1")
      .run();

    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    expect(await repo.purgeTombstones(cutoff)).toBe(1);
    const left = await repo.listTombstones();
    expect(left.map((t) => t.url)).toEqual(["https://fresh.test/1"]);
  });

  test("a sweep that removes nothing reports zero, so no watermark advances falsely", async () => {
    // Never advance purgedBefore past a tombstone that was not actually swept:
    // a client trusting the watermark would delete cards the server still has.
    await repo.upsert(note());
    await repo.delete(URL_A);
    expect(await repo.purgeTombstones(new Date(Date.now() - 90 * 86_400_000))).toBe(0);
    expect(await repo.listTombstones()).toHaveLength(1);
  });

  test("a live card is never swept, however old", async () => {
    await repo.upsert(note());
    expect(await repo.purgeTombstones(new Date(Date.now() + 86_400_000))).toBe(0);
    expect(await repo.getByUrl(URL_A)).not.toBeNull();
  });
});

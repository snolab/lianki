import { describe, test, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createEmptyCard, type ReviewLog } from "ts-fsrs";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import type { D1Like } from "@/lib/d1/types";
import { D1FsrsCollection } from "@/app/fsrsNotesD1Collection";
import { newServerHLC } from "@/app/fsrs-helpers";

const SCHEMA = readFileSync(join(process.cwd(), "db/migrations/0001_init.sql"), "utf8");
const EMAIL = "user@example.com";

let col: D1FsrsCollection;
beforeEach(() => {
  const d1 = createTestD1(SCHEMA) as unknown as D1Like;
  col = new D1FsrsCollection(d1, EMAIL);
});

function cardDueAt(due: Date) {
  const c = createEmptyCard();
  c.due = due;
  return c;
}

/** Insert a note via the saveNote ($setOnInsert) path. */
async function seed(url: string, due: Date, title?: string) {
  return col.findOneAndUpdate(
    { url },
    {
      $setOnInsert: { card: cardDueAt(due), url, hlc: newServerHLC() },
      $set: title ? { title } : {},
    },
  );
}

describe("D1FsrsCollection", () => {
  test("findOneAndUpdate ($setOnInsert) inserts a note and is idempotent", async () => {
    const doc = await seed("https://a.com", new Date(), "A");
    expect(doc!.url).toBe("https://a.com");
    expect(doc!.title).toBe("A");
    expect(doc!._id).toBeTruthy();
    expect(doc!.card.reps).toBe(0);

    await seed("https://a.com", new Date());
    expect(await col.countDocuments({})).toBe(1);
  });

  test("findOne by url", async () => {
    await seed("https://a.com", new Date());
    const found = await col.findOne({ url: "https://a.com" });
    expect(found!.url).toBe("https://a.com");
    expect(await col.findOne({ url: "https://missing.com" })).toBeNull();
  });

  test("find filters by card.due $lte and orders ascending", async () => {
    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 86_400_000);
    await seed("https://due.com", past);
    await seed("https://later.com", future);

    const due = await col.find({ "card.due": { $lte: new Date() } }).toArray();
    expect(due.map((d) => d.url)).toEqual(["https://due.com"]);

    const all = await col.find({}).toArray();
    expect(all).toHaveLength(2);
  });

  test("find honours a url $not regex and a limit", async () => {
    const past = new Date(Date.now() - 1000);
    await seed("https://youtube.com/x", past);
    await seed("https://example.com/y", past);
    const filtered = await col
      .find({ "card.due": { $lte: new Date() }, url: { $not: /youtube\.com/ } })
      .toArray();
    expect(filtered.map((d) => d.url)).toEqual(["https://example.com/y"]);

    const limited = await col.find({ "card.due": { $lte: new Date() } }, { limit: 1 }).toArray();
    expect(limited).toHaveLength(1);
  });

  test("countDocuments — all and due", async () => {
    await seed("https://due.com", new Date(Date.now() - 1000));
    await seed("https://later.com", new Date(Date.now() + 86_400_000));
    expect(await col.countDocuments({})).toBe(2);
    expect(await col.countDocuments({ "card.due": { $lte: new Date() } })).toBe(1);
  });

  test("findOneAndUpdate review — $set card/hlc and $push a log entry", async () => {
    await seed("https://a.com", new Date());
    const newCard = cardDueAt(new Date(Date.now() + 3 * 86_400_000));
    const logItem = { rating: 3, review: new Date() } as unknown as ReviewLog;
    const updated = await col.findOneAndUpdate(
      { url: "https://a.com" },
      { $set: { card: newCard, hlc: newServerHLC() }, $push: { log: logItem } },
    );
    expect(updated!.log).toHaveLength(1);

    // a second review appends, not replaces
    const again = await col.findOneAndUpdate(
      { url: "https://a.com" },
      { $set: { card: newCard, hlc: newServerHLC() }, $push: { log: logItem } },
    );
    expect(again!.log).toHaveLength(2);
  });

  test("updateOne — notes, rename url, and speedMarkers upsert", async () => {
    await seed("https://a.com", new Date());

    expect(
      (await col.updateOne({ url: "https://a.com" }, { $set: { notes: "hi" } })).matchedCount,
    ).toBe(1);
    expect((await col.findOne({ url: "https://a.com" }))!.notes).toBe("hi");

    expect(
      (await col.updateOne({ url: "https://a.com" }, { $set: { url: "https://b.com" } }))
        .matchedCount,
    ).toBe(1);
    expect(await col.findOne({ url: "https://a.com" })).toBeNull();
    expect(await col.findOne({ url: "https://b.com" })).not.toBeNull();

    // speedMarkers upserts even when the note does not exist yet
    expect(
      (await col.updateOne({ url: "https://new.com" }, { $set: { speedMarkers: { 1: 2 } } }))
        .matchedCount,
    ).toBe(1);
    expect((await col.findOne({ url: "https://new.com" }))!.speedMarkers).toEqual({ 1: 2 });
  });

  test("deleteOne removes a note", async () => {
    await seed("https://a.com", new Date());
    expect((await col.deleteOne({ url: "https://a.com" })).deletedCount).toBe(1);
    expect(await col.findOne({ url: "https://a.com" })).toBeNull();
  });

  test("aggregate resolves a note by _id and by url", async () => {
    const doc = await seed("https://a.com", new Date());
    const byId = await col
      .aggregate([{ $set: { _id: { $toString: "$_id" } } }, { $match: { _id: doc!._id } }])
      .next();
    expect(byId!.url).toBe("https://a.com");

    const byUrl = await col
      .aggregate([{ $set: { _id: { $toString: "$_id" } } }, { $match: { url: "https://a.com" } }])
      .next();
    expect(byUrl!._id).toBe(doc!._id);
  });
});

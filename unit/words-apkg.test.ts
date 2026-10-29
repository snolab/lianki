import { describe, expect, test } from "bun:test";
import initSqlJs from "sql.js";
import JSZip from "jszip";
import { ApkgError, mainModel, parseApkg } from "@/lib/words/apkg";
import { buildApkg } from "../scripts/qa/apkg-fixture.mjs";

const init = () => initSqlJs();

describe("parseApkg", () => {
  for (const format of ["anki2", "anki21b"] as const)
    test(`reads decks, note types and notes (${format})`, async () => {
      const bytes = await buildApkg({
        deck: "Lang::Spanish",
        fields: ["Front", "Back"],
        notes: [["hola", "hello"], { guid: "g-2", fields: ["gato", "cat"] }],
        format,
      });
      const pkg = await parseApkg(bytes, init);
      expect(pkg.decks).toHaveLength(1);
      const deck = pkg.decks[0];
      expect(deck.name).toBe("Lang::Spanish");
      expect(deck.notes.map((n) => [n.guid, n.fields])).toEqual([
        ["qa-guid-0", ["hola", "hello"]],
        ["g-2", ["gato", "cat"]],
      ]);
      expect(pkg.models[mainModel(deck)].fields).toEqual(["Front", "Back"]);
    });

  test("not a zip", async () => {
    await expect(parseApkg(new Uint8Array([1, 2, 3]), init)).rejects.toBeInstanceOf(ApkgError);
  });

  test("a zip with no collection", async () => {
    const zip = new JSZip();
    zip.file("media", "{}");
    await expect(parseApkg(await zip.generateAsync({ type: "uint8array" }), init)).rejects.toThrow(
      "no collection",
    );
  });

  test("a collection that is not SQLite", async () => {
    const zip = new JSZip();
    zip.file("collection.anki2", "not a database");
    await expect(
      parseApkg(await zip.generateAsync({ type: "uint8array" }), init),
    ).rejects.toBeInstanceOf(ApkgError);
  });

  test("a collection missing its tables", async () => {
    const SQL = await init();
    const db = new SQL.Database();
    db.run("CREATE TABLE unrelated (x)");
    const zip = new JSZip();
    zip.file("collection.anki21", db.export());
    await expect(parseApkg(await zip.generateAsync({ type: "uint8array" }), init)).rejects.toThrow(
      "unreadable collection",
    );
  });

  test("a note with no cards is skipped; an unknown deck gets a name", async () => {
    const SQL = await init();
    const db = new SQL.Database();
    db.run("CREATE TABLE col (models TEXT, decks TEXT)");
    db.run("INSERT INTO col VALUES (?, '{}')", [
      JSON.stringify({
        9: {
          name: "M",
          flds: [
            { name: "B", ord: 1 },
            { name: "A", ord: 0 },
          ],
        },
      }),
    ]);
    db.run("CREATE TABLE notes (id INTEGER, guid TEXT, mid INTEGER, flds TEXT)");
    db.run("CREATE TABLE cards (id INTEGER, nid INTEGER, did INTEGER, ord INTEGER)");
    db.run("INSERT INTO notes VALUES (1, 'g1', 9, 'a\x1fb'), (2, 'g2', 9, 'c\x1fd')");
    db.run("INSERT INTO notes VALUES (3, 'g3', 8, 'e'), (4, 'g4', 8, 'f'), (5, 'g5', 9, 'g')");
    db.run("INSERT INTO cards VALUES (1, 1, 42, 0), (3, 3, 43, 0), (4, 4, 43, 0), (5, 5, 43, 0)");
    const zip = new JSZip();
    zip.file("collection.anki2", db.export());
    const pkg = await parseApkg(await zip.generateAsync({ type: "uint8array" }), init);
    expect(pkg.models["9"].fields).toEqual(["A", "B"]);
    // Biggest deck first.
    expect(pkg.decks.map((d) => [d.id, d.name, d.notes.map((n) => n.guid)])).toEqual([
      ["43", "Anki deck", ["g3", "g4", "g5"]],
      ["42", "Anki deck", ["g1"]],
    ]);
    expect(pkg.decks[1].notes[0].fields).toEqual(["a", "b"]);
    expect(mainModel(pkg.decks[0])).toBe("8");
  });

  test("mainModel of an empty deck", () => {
    expect(mainModel({ id: "1", name: "x", notes: [] })).toBe("");
  });
});

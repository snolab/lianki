// A tiny Anki package built on the fly, for unit/words-apkg.test.ts and
// scripts/qa/qa-words.mjs — no binary fixture in the repo. Only the tables and
// columns lib/words/apkg.ts reads are created.
//
//   buildApkg({ deck: "Spanish", fields: ["Front", "Back"], notes: [["hola", "hello"]] })
//   buildApkg({ ..., format: "anki21b" })  // Anki 2.1.50+ export (zstd, schema 18)
import JSZip from "jszip";
import initSqlJs from "sql.js";
import { zstdCompressSync } from "node:zlib";

/**
 * @param {{ deck?: string, deckId?: number, model?: string, fields: string[],
 *   notes: (string[] | { guid: string, fields: string[] })[], format?: "anki2" | "anki21b" }} o
 * @returns {Promise<Uint8Array>} the .apkg bytes
 */
export async function buildApkg(o) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const deckId = o.deckId ?? 1700000000001;
  const mid = 1600000000001;
  const modern = o.format === "anki21b";
  db.run(
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, guid TEXT, mid INTEGER, flds TEXT, tags TEXT)",
  );
  db.run("CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER)");
  if (modern) {
    db.run("CREATE TABLE col (id INTEGER PRIMARY KEY, models TEXT, decks TEXT)");
    db.run("INSERT INTO col VALUES (1, '', '')");
    db.run("CREATE TABLE notetypes (id INTEGER PRIMARY KEY, name TEXT)");
    db.run("CREATE TABLE fields (ntid INTEGER, ord INTEGER, name TEXT)");
    db.run("CREATE TABLE decks (id INTEGER PRIMARY KEY, name TEXT)");
    db.run("INSERT INTO notetypes VALUES (?, ?)", [mid, o.model ?? "Basic"]);
    o.fields.forEach((f, i) => db.run("INSERT INTO fields VALUES (?, ?, ?)", [mid, i, f]));
    db.run("INSERT INTO decks VALUES (?, ?)", [
      deckId,
      (o.deck ?? "QA deck").split("::").join("\x1f"),
    ]);
  } else {
    const models = {
      [mid]: {
        id: mid,
        name: o.model ?? "Basic",
        flds: o.fields.map((name, ord) => ({ name, ord })),
      },
    };
    const decks = {
      1: { id: 1, name: "Default" },
      [deckId]: { id: deckId, name: o.deck ?? "QA deck" },
    };
    db.run("CREATE TABLE col (id INTEGER PRIMARY KEY, models TEXT, decks TEXT)");
    db.run("INSERT INTO col VALUES (1, ?, ?)", [JSON.stringify(models), JSON.stringify(decks)]);
  }
  o.notes.forEach((n, i) => {
    const note = Array.isArray(n) ? { guid: `qa-guid-${i}`, fields: n } : n;
    const id = 1700000001000 + i;
    db.run("INSERT INTO notes VALUES (?, ?, ?, ?, '')", [
      id,
      note.guid,
      mid,
      note.fields.join("\x1f"),
    ]);
    db.run("INSERT INTO cards VALUES (?, ?, ?, 0)", [id, id, deckId]);
  });
  const bytes = db.export();
  db.close();
  const zip = new JSZip();
  if (modern) {
    zip.file("collection.anki21b", zstdCompressSync(bytes));
    // The stub an old Anki would open instead: it must be ignored.
    const stub = new SQL.Database();
    stub.run("CREATE TABLE col (models TEXT, decks TEXT)");
    zip.file("collection.anki2", stub.export());
    stub.close();
  } else zip.file("collection.anki2", bytes);
  zip.file("media", "{}");
  return zip.generateAsync({ type: "uint8array" });
}

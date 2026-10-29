/**
 * Read an Anki package (.apkg, or a whole collection .colpkg) into decks of
 * notes — in the browser, so a deck never has to be uploaded whole.
 *
 * A package is a zip holding an SQLite collection:
 * - `collection.anki21b` (Anki 2.1.50+ default export): zstd-compressed,
 *   schema 18 — note types and fields in their own tables;
 * - `collection.anki21` / `collection.anki2` (legacy export, what AnkiWeb
 *   shared decks are): note types and decks as JSON in the `col` row.
 * A new-format package also carries a stub `collection.anki2` that only says
 * "please update Anki", so the newest collection present wins.
 */
import type JSZip from "jszip";
import type { Database, SqlJsStatic } from "sql.js";

export class ApkgError extends Error {}

export type ApkgModel = { id: string; name: string; fields: string[] };
export type ApkgNote = { id: string; guid: string; modelId: string; fields: string[] };
export type ApkgDeck = { id: string; name: string; notes: ApkgNote[] };
export type ApkgPackage = { decks: ApkgDeck[]; models: Record<string, ApkgModel> };

type Row = (string | number | Uint8Array | null)[];
const rows = (db: Database, sql: string): Row[] => db.exec(sql)[0]?.values ?? [];

async function collectionBytes(zip: JSZip): Promise<Uint8Array> {
  const b = zip.file("collection.anki21b");
  if (b) {
    const { decompress } = await import("fzstd");
    return decompress(await b.async("uint8array"));
  }
  const legacy = zip.file("collection.anki21") ?? zip.file("collection.anki2");
  if (!legacy) throw new ApkgError("no collection in this file");
  return legacy.async("uint8array");
}

function readModels(db: Database): Record<string, ApkgModel> {
  const models: Record<string, ApkgModel> = {};
  const hasFieldsTable =
    rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='fields'").length > 0;
  if (hasFieldsTable) {
    for (const [id, name] of rows(db, "SELECT id, name FROM notetypes"))
      models[String(id)] = { id: String(id), name: String(name), fields: [] };
    for (const [ntid, name] of rows(db, "SELECT ntid, name FROM fields ORDER BY ntid, ord"))
      models[String(ntid)]?.fields.push(String(name));
    return models;
  }
  const json = rows(db, "SELECT models FROM col LIMIT 1")[0]?.[0];
  const parsed = JSON.parse(String(json ?? "{}")) as Record<
    string,
    { id?: number; name: string; flds: { name: string; ord?: number }[] }
  >;
  for (const [id, m] of Object.entries(parsed))
    models[id] = {
      id,
      name: m.name,
      fields: [...m.flds].sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0)).map((f) => f.name),
    };
  return models;
}

function readDecks(db: Database): Map<string, string> {
  const names = new Map<string, string>();
  const hasDecksTable =
    rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='decks'").length > 0;
  if (hasDecksTable) {
    // Schema 18 separates deck path parts with \x1f.
    for (const [id, name] of rows(db, "SELECT id, name FROM decks"))
      names.set(String(id), String(name).split("\x1f").join("::"));
    return names;
  }
  const json = rows(db, "SELECT decks FROM col LIMIT 1")[0]?.[0];
  for (const [id, d] of Object.entries(
    JSON.parse(String(json ?? "{}")) as Record<string, { name: string }>,
  ))
    names.set(id, d.name);
  return names;
}

/**
 * Parse a package. `initSql` loads sql.js (the browser passes one that finds
 * /sql-wasm.wasm; tests pass the Node build).
 */
export async function parseApkg(
  data: ArrayBuffer | Uint8Array,
  initSql: () => Promise<SqlJsStatic>,
): Promise<ApkgPackage> {
  let zip: JSZip;
  try {
    // Loaded on demand: the page only needs it once a file is dropped.
    zip = await (await import("jszip")).default.loadAsync(data);
  } catch {
    throw new ApkgError("not a zip file");
  }
  const bytes = await collectionBytes(zip);
  const SQL = await initSql();
  // sql.js opens anything; a file that is not SQLite fails at the first query.
  const db: Database = new SQL.Database(bytes);
  try {
    const models = readModels(db);
    const deckNames = readDecks(db);
    const decks = new Map<string, ApkgDeck>();
    // A note belongs to the deck of its first card; notes come in creation order.
    const noteRows = rows(
      db,
      `SELECT n.id, n.guid, n.mid, n.flds,
         (SELECT c.did FROM cards c WHERE c.nid = n.id ORDER BY c.ord LIMIT 1) AS did
       FROM notes n ORDER BY n.id`,
    );
    for (const [id, guid, mid, flds, did] of noteRows) {
      if (did == null) continue; // a note with no cards is not studied in Anki either
      const deckId = String(did);
      let deck = decks.get(deckId);
      if (!deck) {
        deck = { id: deckId, name: deckNames.get(deckId) ?? "Anki deck", notes: [] };
        decks.set(deckId, deck);
      }
      deck.notes.push({
        id: String(id),
        guid: String(guid),
        modelId: String(mid),
        fields: String(flds).split("\x1f"),
      });
    }
    return { decks: [...decks.values()].sort((a, b) => b.notes.length - a.notes.length), models };
  } catch (e) {
    if (e instanceof ApkgError) throw e;
    throw new ApkgError(`unreadable collection: ${(e as Error).message}`);
  } finally {
    db.close();
  }
}

/** The note type most of a deck's notes use. */
export function mainModel(deck: ApkgDeck): string {
  const n = new Map<string, number>();
  for (const note of deck.notes) n.set(note.modelId, (n.get(note.modelId) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

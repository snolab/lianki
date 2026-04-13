import JSZip from "jszip";
import initSqlJs from "sql.js";

export type ParsedNote = {
  id: number;
  fields: Record<string, string>;
  tags: string[];
  modelName: string;
};

export type ParsedApkg = {
  deckName: string;
  notes: ParsedNote[];
  modelNames: string[];
};

export async function parseApkg(buffer: ArrayBuffer): Promise<ParsedApkg> {
  const zip = await JSZip.loadAsync(buffer);

  // Find the SQLite database file
  const dbFileName = zip.file("collection.anki21")
    ? "collection.anki21"
    : zip.file("collection.anki2")
      ? "collection.anki2"
      : null;

  if (!dbFileName) {
    throw new Error("Invalid APKG file: no collection database found");
  }

  const dbData = await zip.file(dbFileName)!.async("uint8array");

  const SQL = await initSqlJs();
  const db = new SQL.Database(dbData);

  try {
    // Get deck name and models from col table
    const colResult = db.exec("SELECT models, decks FROM col LIMIT 1");
    if (colResult.length === 0) {
      throw new Error("Invalid APKG: empty col table");
    }

    const modelsJson = JSON.parse(colResult[0].values[0][0] as string);
    const decksJson = JSON.parse(colResult[0].values[0][1] as string);

    // Extract deck name (use first non-default deck, or "Default")
    const deckEntries = Object.values(decksJson) as Array<{ name: string; id: number }>;
    const mainDeck = deckEntries.find((d) => d.name !== "Default") || deckEntries[0];
    const deckName = mainDeck?.name || "Imported Deck";

    // Build model field map: modelId -> { name, fields[] }
    const modelMap = new Map<string, { name: string; fields: string[] }>();
    for (const [mid, model] of Object.entries(modelsJson) as Array<[string, any]>) {
      const fields = (model.flds as Array<{ name: string }>).map((f) => f.name);
      modelMap.set(mid, { name: model.name, fields });
    }

    // Query notes
    const notesResult = db.exec("SELECT id, mid, flds, tags FROM notes");
    if (notesResult.length === 0) {
      return { deckName, notes: [], modelNames: [...modelMap.values()].map((m) => m.name) };
    }

    const notes: ParsedNote[] = [];
    for (const row of notesResult[0].values) {
      const id = row[0] as number;
      const mid = String(row[1]);
      const flds = row[2] as string;
      const tags = (row[3] as string).trim().split(/\s+/).filter(Boolean);

      const model = modelMap.get(mid);
      if (!model) continue;

      const fieldValues = flds.split("\x1f");
      const fields: Record<string, string> = {};
      for (let i = 0; i < model.fields.length; i++) {
        fields[model.fields[i]] = fieldValues[i] || "";
      }

      notes.push({
        id,
        fields,
        tags,
        modelName: model.name,
      });
    }

    return {
      deckName,
      notes,
      modelNames: [...modelMap.values()].map((m) => m.name),
    };
  } finally {
    db.close();
  }
}

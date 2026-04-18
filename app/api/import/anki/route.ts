import { NextRequest, NextResponse } from "next/server";
import { createEmptyCard } from "ts-fsrs";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { newServerHLC } from "@/app/fsrs-helpers";
import { parseApkg } from "@/app/lib/apkg-parser";
import { logSanitizedError } from "@/lib/safeError";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    const email = session?.user?.email;
    if (!email) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (!file.name.endsWith(".apkg")) {
      return NextResponse.json({ error: "File must be an .apkg file" }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "File too large (max 100MB)" }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    const parsed = await parseApkg(buffer);

    const FSRSNotes = getFSRSNotesCollection(email);
    let imported = 0;
    let skipped = 0;

    for (const note of parsed.notes) {
      const url = `lianki://anki-import/${encodeURIComponent(parsed.deckName)}/${note.id}`;

      // Skip if already exists
      const existing = await FSRSNotes.findOne({ url });
      if (existing) {
        skipped++;
        continue;
      }

      // Build title from first two fields
      const fieldValues = Object.values(note.fields);
      const title = fieldValues.slice(0, 2).join(" — ").slice(0, 200);

      try {
        await FSRSNotes.insertOne({
          url,
          title,
          card: createEmptyCard(),
          hlc: newServerHLC(),
          log: [],
          notes: `[anki] ${note.modelName} | ${note.tags.join(", ")}`,
        } as any);
        imported++;
      } catch {
        skipped++;
      }
    }

    return NextResponse.json({
      success: true,
      imported,
      skipped,
      deckName: parsed.deckName,
      totalNotes: parsed.notes.length,
      message: `Imported ${imported} cards from "${parsed.deckName}"${skipped > 0 ? ` (${skipped} skipped)` : ""}`,
    });
  } catch (error) {
    logSanitizedError("import.anki", error);
    return NextResponse.json({ error: "Failed to import deck" }, { status: 500 });
  }
}

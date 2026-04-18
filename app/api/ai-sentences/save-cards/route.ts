import { NextRequest, NextResponse } from "next/server";
import { createEmptyCard } from "ts-fsrs";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { newServerHLC } from "@/app/fsrs-helpers";
import { logSanitizedError } from "@/lib/safeError";

export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    const email = session?.user?.email;
    if (!email) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { words } = await req.json();

    if (!Array.isArray(words) || words.length === 0 || words.length > 100) {
      return NextResponse.json({ error: "Invalid words array" }, { status: 400 });
    }

    const FSRSNotes = getFSRSNotesCollection(email);
    let saved = 0;
    let skipped = 0;

    for (const item of words) {
      const { word, definition, language } = item;
      if (!word || !language) {
        skipped++;
        continue;
      }

      const url = `lianki://ai-vocab/${encodeURIComponent(language)}/${encodeURIComponent(word)}/${Date.now()}`;

      try {
        await FSRSNotes.insertOne({
          url,
          title: `${word} — ${definition || ""}`,
          card: createEmptyCard(),
          hlc: newServerHLC(),
          log: [],
          notes: `[ai-vocab] ${language} | ${word}`,
        } as any);
        saved++;
      } catch {
        skipped++;
      }
    }

    return NextResponse.json({
      success: true,
      saved,
      skipped,
      message: `Saved ${saved} cards${skipped > 0 ? `, skipped ${skipped}` : ""}`,
    });
  } catch (error) {
    logSanitizedError("ai-sentences.save-cards", error);
    return NextResponse.json({ error: "Failed to save cards" }, { status: 500 });
  }
}

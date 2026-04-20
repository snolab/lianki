import { NextRequest, NextResponse } from "next/server";
import { createEmptyCard } from "ts-fsrs";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { newServerHLC } from "@/app/fsrs-helpers";
import { logSanitizedError } from "@/lib/safeError";
import { z } from "zod";

const BATCH_MAX = 200;

const zCard = z.object({
  url: z.string(),
  title: z.string(),
  notes: z.string().optional(),
});

const zBody = z.object({
  cards: z.array(zCard).max(BATCH_MAX),
});

export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    const email = session?.user?.email;
    if (!email) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await req.json();
    const { cards } = zBody.parse(body);

    const FSRSNotes = getFSRSNotesCollection(email);
    let imported = 0;
    let skipped = 0;

    for (const card of cards) {
      const existing = await FSRSNotes.findOne({ url: card.url });
      if (existing) {
        skipped++;
        continue;
      }
      try {
        await FSRSNotes.insertOne({
          url: card.url,
          title: card.title,
          card: createEmptyCard(),
          hlc: newServerHLC(),
          log: [],
          notes: card.notes ?? "",
        } as any);
        imported++;
      } catch {
        skipped++;
      }
    }

    return NextResponse.json({ imported, skipped });
  } catch (error) {
    logSanitizedError("import.anki-client", error);
    return NextResponse.json({ error: "Import failed" }, { status: 500 });
  }
}

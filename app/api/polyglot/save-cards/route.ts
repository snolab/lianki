import { NextRequest, NextResponse } from "next/server";
import { createEmptyCard } from "ts-fsrs";
import { authEmail } from "@/app/signInEmail";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";

export async function POST(req: NextRequest) {
  try {
    const email = await authEmail();
    const FSRSNotes = getFSRSNotesCollection(email);

    const { matrix } = await req.json();

    const cards = [];

    // Create a card for each filled cell in the matrix
    for (const [questionId, langData] of Object.entries(matrix)) {
      for (const [langCode, content] of Object.entries(
        langData as Record<string, { question: string; answer: string }>,
      )) {
        const { question, answer } = content;

        // Create a unique URL for this polyglot card
        const url = `lianki://polyglot/${langCode}/${questionId}/${Date.now()}`;
        const title = `[Polyglot ${langCode}] ${question}`;

        // Save the card to MongoDB
        const result = await FSRSNotes.findOneAndUpdate(
          { url },
          {
            $setOnInsert: {
              card: createEmptyCard(),
              url,
            },
            $set: {
              title,
              polyglot: {
                language: langCode,
                questionId,
                question,
                answer,
              },
            },
          },
          { upsert: true, returnDocument: "after" },
        );

        cards.push(result);
      }
    }

    return NextResponse.json({
      success: true,
      cardsCreated: cards.length,
      message: `${cards.length} polyglot cards saved successfully!`,
    });
  } catch (error) {
    console.error("Save cards error:", error);
    if ((error as Error).message?.includes("email")) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to save cards" }, { status: 500 });
  }
}

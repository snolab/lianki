import { NextRequest, NextResponse } from "next/server";
import { createEmptyCard } from "ts-fsrs";
import { authEmail } from "@/app/signInEmail";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";

export async function POST(req: NextRequest) {
  try {
    const { language, sentences } = await req.json();
    const email = await authEmail();
    const FSRSNotes = getFSRSNotesCollection(email);

    const cards = [];

    // Create a card for each sentence
    for (const [questionId, data] of Object.entries(sentences)) {
      const { text, audioUrl } = data as { text: string; audioUrl: string | null };

      // Create a unique URL for this self-intro card
      const url = `lianki://self-intro/${language}/${questionId}/${Date.now()}`;
      const title = `[Self-Intro ${language}] ${text}`;

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
            // Store the text and audio reference
            selfIntro: {
              language,
              questionId,
              text,
              // Note: We can't store blob URLs in DB, they're temporary
              // In production, you'd want to upload audio to storage (S3, etc.)
              // For now, users will need to regenerate audio when reviewing
            },
          },
        },
        { upsert: true, returnDocument: "after" }
      );

      cards.push(result);
    }

    return NextResponse.json({
      success: true,
      cardsCreated: cards.length,
      message: `${cards.length} self-introduction cards saved successfully!`
    });
  } catch (error) {
    console.error("Save cards error:", error);
    return NextResponse.json(
      { error: "Failed to save cards" },
      { status: 500 }
    );
  }
}

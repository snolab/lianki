import { generateObject } from "ai";
import { metered, refusal } from "@/lib/payments/metered";
import { MAX_OUT } from "@/lib/payments/paid-calls";
import { textHoldUsd, textUsd } from "@/lib/payments/prices";
import { walletDb, walletUserId } from "@/lib/payments/wallet-db";
import { textModel, workersAiStructuredModel } from "@/lib/workers-ai";
import { NextRequest, NextResponse } from "next/server";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { cappedJsonError, readJsonCapped, tooMany } from "@/lib/security/route-guard";
import { accountKey } from "@/lib/security/throttle";
import { LooseRoadmapSchema } from "@/lib/roadmap/generate-schema";
import { ATTEMPTS, generateFailedResponse, generateWithRetry } from "@/lib/roadmap/generate";
import { roadmapPrompt } from "@/lib/roadmap/prompt";
import { matchExamDecks } from "@/lib/roadmap/exam-match";
import catalogue from "@/public/words/index.json";

/** Model calls per account (D1): each one is a paid generation. */
const GENERATE_LIMIT = { max: 10, windowMs: 60 * 60_000 };

export const maxDuration = 60;

/** The schema's share of the prompt, in characters (held, never shrunk). */
const SCHEMA_CHARS = 2000;

export async function POST(request: NextRequest) {
  const email = await authEmailOrToken(request);
  if (!email) return new NextResponse("Unauthorized", { status: 401 });

  const limited = await tooMany(await accountKey("roadmap-generate", email), GENERATE_LIMIT);
  if (limited) return limited;

  const body = await readJsonCapped(request, 4096);
  if (!body.ok) return cappedJsonError(body.status);
  const { topic } = (body.value ?? {}) as { topic?: unknown };
  if (!topic || typeof topic !== "string" || topic.length > 500) {
    return new NextResponse("Invalid topic", { status: 400 });
  }

  const db = walletDb();
  const payer = { id: await walletUserId(db, email) };
  // Exam decks the wish names (JLPT N1…): offered to the model as deck steps.
  const decks = matchExamDecks(topic, catalogue.lists).map((d) => ({ id: d.id, name: d.name }));
  const prompt = roadmapPrompt(topic, decks);
  const model = textModel();
  const maxOut = MAX_OUT["roadmap.generate"];
  // The JSON schema the SDK adds to the prompt: held as SCHEMA_CHARS more characters.
  const oneHoldUsd = textHoldUsd(model, prompt.length + SCHEMA_CHARS, maxOut);
  try {
    // One hold for the first try and its retry (lib/roadmap/generate.ts): never a second charge.
    const paid = await metered(
      { d1: db },
      { userId: payer.id, email },
      { what: "roadmap.generate", holdUsd: oneHoldUsd * ATTEMPTS },
      () =>
        generateWithRetry(
          async () => {
            const r = await generateObject({
              model: workersAiStructuredModel(model),
              schema: LooseRoadmapSchema,
              maxOutputTokens: maxOut,
              prompt,
            });
            return { object: r.object, usage: r.usage };
          },
          {
            usd: (u) => textUsd(model, u.inputTokens ?? 0, u.outputTokens ?? 0),
            fallbackUsd: oneHoldUsd,
          },
          undefined,
          { decks: decks.map((d) => d.id) },
        ),
    );
    if (!paid.ok) return refusal(paid);
    return NextResponse.json(paid.value);
  } catch (err) {
    return generateFailedResponse(err);
  }
}

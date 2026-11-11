import { refusal } from "@/lib/payments/metered";
import { MAX_OUT, openAiCreate, paidChat } from "@/lib/payments/paid-calls";
import { walletDb } from "@/lib/payments/wallet-db";
import { NextRequest, NextResponse } from "next/server";
import {
  isWorkersAiConfigured,
  textModel,
  workersAiOpenAI,
  WORKERS_AI_NOT_CONFIGURED,
} from "@/lib/workers-ai";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { routeLimit } from "@/lib/security/route-guard";
import { accountKey } from "@/lib/security/throttle";
import { logSanitizedError } from "@/lib/safeError";

const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;

export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    const email = session?.user?.email;
    if (!email) {
      return NextResponse.json({ error: "login-required" }, { status: 401 });
    }

    const rateLimit = await routeLimit(await accountKey("ai-new-word", email), {
      windowMs: RATE_LIMIT_WINDOW_MS,
      max: RATE_LIMIT_MAX_REQUESTS,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "rate-limited" },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)) },
        },
      );
    }

    const { topic, language, knownWords } = await req.json();

    if (typeof topic !== "string" || topic.length === 0 || topic.length > 500) {
      return NextResponse.json({ error: "invalid-topic" }, { status: 400 });
    }
    if (typeof language !== "string" || language.length === 0) {
      return NextResponse.json({ error: "invalid-language" }, { status: 400 });
    }

    if (!isWorkersAiConfigured()) {
      return NextResponse.json({ error: WORKERS_AI_NOT_CONFIGURED }, { status: 500 });
    }

    const openai = workersAiOpenAI();

    const knownWordsContext =
      Array.isArray(knownWords) && knownWords.length > 0
        ? `\nAVOID these words the user already knows: ${knownWords.join(", ")}`
        : "";

    const paid = await paidChat(
      { userId: session!.user.id, email: email, db: walletDb() },
      "ai-sentences",
      {
        model: textModel(),
        messages: [
          {
            role: "system",
            content: `You are a language learning assistant. Suggest a new vocabulary word in ${language} based on the given topic.
Return a JSON object with:
- "word": the vocabulary word in the target language
- "definition": a brief definition in English (under 100 characters)

Prefer common, high-frequency words that are useful for conversation.${knownWordsContext}`,
          },
          {
            role: "user",
            content: `Suggest a new word for the topic: "${topic}"`,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.9,
        max_tokens: MAX_OUT["ai-sentences"],
      },
      openAiCreate(openai),
    );
    if (!paid.ok) return refusal(paid);
    const completion = paid.value;

    const result = JSON.parse(completion.choices[0]?.message?.content || "{}");

    return NextResponse.json({
      word: result.word || "",
      definition: result.definition || "",
    });
  } catch (error) {
    logSanitizedError("ai-sentences.new-word", error);
    return NextResponse.json({ error: "generate-failed" }, { status: 500 });
  }
}

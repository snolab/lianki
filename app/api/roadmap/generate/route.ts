import { generateObject } from "ai";
import { metered, refusal } from "@/lib/payments/metered";
import { MAX_OUT } from "@/lib/payments/paid-calls";
import { textHoldUsd, textUsd } from "@/lib/payments/prices";
import { walletDb, walletUserId } from "@/lib/payments/wallet-db";
import { textModel, workersAiProvider } from "@/lib/workers-ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { cappedJsonError, readJsonCapped, tooMany } from "@/lib/security/route-guard";
import { accountKey } from "@/lib/security/throttle";

/** Model calls per account (D1): each one is a paid generation. */
const GENERATE_LIMIT = { max: 10, windowMs: 60 * 60_000 };

export const maxDuration = 60;

/** The schema's share of the prompt, in characters (held, never shrunk). */
const SCHEMA_CHARS = 2000;

const RoadmapSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        description: z.string().max(200),
        keywords: z.array(z.string()).min(2).max(8),
        order: z.number(),
      }),
    )
    .min(3)
    .max(12),
});

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
  const prompt = `Generate a learning roadmap for: "${topic}"

Create 5-10 progressive learning milestones. Each node should represent a concrete skill or knowledge area.

For each node, provide:
- id: unique snake_case identifier
- title: short milestone title (max 50 chars)
- description: what the learner should know/do (max 200 chars)
- keywords: 2-8 keywords that would appear in study materials/URLs for this topic (e.g. "python loops", "for loop", "iteration")
- order: 0-based sequential number

Progress from fundamentals to advanced. Keywords should be specific enough to match real study cards.`;
  const model = textModel();
  const maxOut = MAX_OUT["roadmap.generate"];
  // The JSON schema the SDK adds to the prompt: held as SCHEMA_CHARS more characters.
  const holdUsd = textHoldUsd(model, prompt.length + SCHEMA_CHARS, maxOut);
  const paid = await metered(
    { d1: db },
    { userId: payer.id, email },
    { what: "roadmap.generate", holdUsd },
    async () => {
      const r = await generateObject({
        model: workersAiProvider()(model),
        schema: RoadmapSchema,
        maxOutputTokens: maxOut,
        prompt,
      });
      const u = r.usage;
      const usd =
        u?.inputTokens || u?.outputTokens
          ? textUsd(model, u.inputTokens ?? 0, u.outputTokens ?? 0)
          : holdUsd;
      return { value: r.object, usd };
    },
  );
  if (!paid.ok) return refusal(paid);
  const object = paid.value;

  return NextResponse.json(object);
}

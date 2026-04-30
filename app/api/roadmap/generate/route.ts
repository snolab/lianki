import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authEmailOrToken } from "@/lib/authEmailOrToken";

export const maxDuration = 60;

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

  const { topic } = await request.json();
  if (!topic || typeof topic !== "string" || topic.length > 500) {
    return new NextResponse("Invalid topic", { status: 400 });
  }

  const { object } = await generateObject({
    model: openai("gpt-4o-mini"),
    schema: RoadmapSchema,
    prompt: `Generate a learning roadmap for: "${topic}"

Create 5-10 progressive learning milestones. Each node should represent a concrete skill or knowledge area.

For each node, provide:
- id: unique snake_case identifier
- title: short milestone title (max 50 chars)
- description: what the learner should know/do (max 200 chars)
- keywords: 2-8 keywords that would appear in study materials/URLs for this topic (e.g. "python loops", "for loop", "iteration")
- order: 0-based sequential number

Progress from fundamentals to advanced. Keywords should be specific enough to match real study cards.`,
  });

  return NextResponse.json(object);
}

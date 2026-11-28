import { generateObject } from "ai";
import { workersAiStructuredModel } from "@/lib/workers-ai";
import { LooseRoadmapSchema } from "./generate-schema";

/** The outer generation loop owns retries and reserves the whole budget. */
export function generateRoadmapObject(
  model: string | undefined,
  prompt: string,
  maxOutputTokens: number,
) {
  return generateObject({
    model: workersAiStructuredModel(model),
    schema: LooseRoadmapSchema,
    prompt,
    maxOutputTokens,
    maxRetries: 0,
  });
}

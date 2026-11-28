/**
 * Roadmap generation with one retry, paid as ONE metered call
 * (lib/payments/metered.ts): the hold covers every attempt (`ATTEMPTS` ×
 * one call's worst case), and the settle keeps the summed real cost of the
 * attempts that reported usage. So a retry never takes a second hold, never
 * charges twice, and never trips the overage pause by costing more than its
 * hold. When every attempt fails, metered() refunds the hold in full.
 */
import { NoObjectGeneratedError } from "ai";
import { fitRoadmap, type LooseRoadmap, type RoadmapStep } from "./generate-schema";

/** First try plus one retry. */
export const ATTEMPTS = 2;

export type Usage = { inputTokens?: number; outputTokens?: number } | undefined;

/** One model call: the raw object and its usage. Throws as `generateObject` does. */
export type GenerateOnce = () => Promise<{ object: LooseRoadmap; usage: Usage }>;

/** Every attempt failed: the route answers 502 with `reason`, never the provider's words. */
export class RoadmapGenerateError extends Error {
  constructor(
    readonly reason: "no-object" | "invalid-shape" | "provider-error",
    readonly cause?: unknown,
  ) {
    super(`roadmap generate failed: ${reason}`);
    this.name = "RoadmapGenerateError";
  }
}

/** A failure worth one more try: the model's answer, not the provider, was wrong. */
export function isRetryable(err: unknown): boolean {
  if (NoObjectGeneratedError.isInstance(err)) return true;
  const name = (err as { name?: string } | null)?.name ?? "";
  return name === "AI_TypeValidationError" || name === "AI_JSONParseError";
}

/**
 * Run `once` up to ATTEMPTS times, until its answer fits (`fitRoadmap`).
 * `usd(usage)` prices one attempt; an attempt without usage counts nothing
 * unless it is the one that succeeded (then `fallbackUsd`, one call's hold,
 * as the route always charged). Answers what metered()'s `run` must return.
 */
export async function generateWithRetry(
  once: GenerateOnce,
  price: { usd: (u: NonNullable<Usage>) => number; fallbackUsd: number },
  log: (o: Record<string, unknown>) => void = (o) => console.warn(JSON.stringify(o)),
  fit: { decks?: readonly string[] } = {},
): Promise<{ value: { nodes: RoadmapStep[] }; usd: number }> {
  let spent = 0;
  let last: RoadmapGenerateError = new RoadmapGenerateError("no-object");
  const cost = (u: Usage) => (u && (u.inputTokens || u.outputTokens) ? price.usd(u) : 0);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const r = await once();
      const fitted = fitRoadmap(r.object, fit);
      const c = cost(r.usage);
      if (fitted) return { value: fitted, usd: spent + (c || price.fallbackUsd) };
      spent += c;
      last = new RoadmapGenerateError("invalid-shape");
      log({ event: "roadmap.generate.retry", attempt, reason: "invalid-shape" });
    } catch (err) {
      if (!isRetryable(err)) throw new RoadmapGenerateError("provider-error", err);
      spent += cost((err as { usage?: Usage }).usage);
      last = new RoadmapGenerateError("no-object", err);
      log({ event: "roadmap.generate.retry", attempt, reason: "no-object" });
    }
  }
  throw last;
}

/**
 * The generation failed after its retry: 502 with a short code only. The
 * server log keeps only error metadata: never provider text, generated
 * content, prompts or credentials.
 */
export function generateFailedResponse(
  err: unknown,
  log: (o: Record<string, unknown>) => void = (o) => console.error(JSON.stringify(o)),
): Response {
  const reason = err instanceof RoadmapGenerateError ? err.reason : "provider-error";
  const cause = err instanceof RoadmapGenerateError ? err.cause : err;
  const detail = cause as { name?: unknown; statusCode?: unknown; finishReason?: unknown } | null;
  const error =
    typeof detail?.name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(detail.name)
      ? detail.name
      : typeof cause;
  const status = detail?.statusCode;
  const finish = detail?.finishReason;
  log({
    event: "roadmap.generate.failed",
    reason,
    error,
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ? { statusCode: status }
      : {}),
    ...(typeof finish === "string" &&
    ["stop", "length", "content-filter", "tool-calls", "error", "other", "unknown"].includes(finish)
      ? { finishReason: finish }
      : {}),
  });
  return Response.json(
    { error: "generate-failed", reason },
    { status: 502, headers: { "cache-control": "no-store" } },
  );
}

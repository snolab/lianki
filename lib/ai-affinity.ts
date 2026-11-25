/**
 * Workers AI prefix caching (developers.cloudflare.com/workers-ai/features/prompt-caching):
 * a cache hit needs the same leading bytes on the same instance, which the
 * `x-session-affinity` header pins. One stable id per account and thread, so
 * every call for that conversation (the automatic polish, and later Li's reply:
 * docs/partner-ai.md, "Prompt caching") lands on the same cache. A hash, never
 * the raw account id.
 */
export const AFFINITY_HEADER = "x-session-affinity";

export async function chatAffinity(userId: string, thread: string): Promise<string> {
  const bytes = new TextEncoder().encode(`lianki-chat:${userId}:${thread}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(hash.subarray(0, 16), (b) => b.toString(16).padStart(2, "0"));
  return `ses_${hex.join("")}`;
}

/** Cached prompt tokens from an OpenAI-compatible `usage` (0 when the provider does not say). */
export function cachedTokens(usage: unknown): number {
  const u = usage as
    | { prompt_tokens_details?: { cached_tokens?: unknown }; cached_tokens?: unknown }
    | undefined;
  const n = u?.prompt_tokens_details?.cached_tokens ?? u?.cached_tokens;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

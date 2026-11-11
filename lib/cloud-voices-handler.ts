/**
 * GET /api/voice/tts?voice=<google:…|azure:…>&text=… — one sentence of Li's
 * read-aloud in a provider voice (lib/cloud-voices.ts; docs/li-sound-hub.md,
 * "Provider voices"). The route (app/api/voice/tts/route.ts) wires the I/O.
 *
 * - Signed in, and the feature on for this viewer (flag `voice.cloud-voices`
 *   plus the `dev` grant: audience owner) — else 404, as if absent.
 * - Paid from the user's credits like every paid call (feature
 *   `voice.cloud`, docs/payments.md): held and charged at the provider's list
 *   price × MARGIN for the characters billed. Every account the same: no
 *   permission skips the wallet.
 * - No key: 503 `X-Voice: not-configured`; the page reads the line in its
 *   usual voice. A provider error: 502; the same fallback.
 * - Never kept: `no-store`, nothing in R2 (a chat line is not asked for again).
 */
import { parseLineVoice } from "@lianki/debug-chat/voices";
import type { LexEntry } from "@lianki/debug-chat/lexicon";
import { personKey } from "@/lib/rateLimit";
import { refusal, type Metered } from "@/lib/payments/metered";
import { providerTtsUsd } from "@/lib/payments/prices";
import { billedChars, providerConfigured, type ProviderVoice } from "@/lib/cloud-voices";

/** The chat's sentences are at most this long (voice-out.ts TTS_MAX_TEXT). */
export const CLOUD_VOICE_MAX_TEXT = 200;
const WINDOW_MS = 10 * 60_000;
/** Generated sentences per account per 10 minutes (the chat's read-aloud, as /api/words/tts). */
export const CLOUD_VOICE_MAX = 300;
const NO_STORE = { "Cache-Control": "no-store" };

export type CloudVoiceDeps = {
  /** The feature is on for this viewer (flag and grant). */
  enabled(email: string): Promise<boolean>;
  configured?(p: ProviderVoice["kind"]): boolean;
  lexicon(): Promise<readonly LexEntry[]>;
  checkRateLimit(
    key: string,
    opts: { windowMs: number; max: number },
  ): { allowed: boolean; retryAfterMs: number };
  /** Paid from the user's credits (lib/payments/metered.ts). */
  pay<T>(usd: number, run: () => Promise<T>): Promise<Metered<T>>;
  synthesize(
    v: ProviderVoice,
    text: string,
    lexicon: readonly LexEntry[],
  ): Promise<{ audio: Uint8Array<ArrayBuffer>; contentType: string }>;
  log(where: string, err: unknown): void;
};

const json = (body: unknown, status: number, headers?: Record<string, string>) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

export async function cloudVoiceTts(
  params: URLSearchParams,
  email: string | null | undefined,
  deps: CloudVoiceDeps,
): Promise<Response> {
  if (!email) return json({ error: "Login required" }, 401);
  if (!(await deps.enabled(email))) return json({ error: "Not found" }, 404);
  const v = parseLineVoice(params.get("voice") ?? "");
  if ("error" in v || (v.kind !== "google" && v.kind !== "azure"))
    return json({ error: "voice: google:<name> or azure:<name>[/<locale>]" }, 400);
  const text = (params.get("text") ?? "").trim();
  if (!text || text.length > CLOUD_VOICE_MAX_TEXT)
    return json({ error: `text: 1–${CLOUD_VOICE_MAX_TEXT} characters` }, 400);
  if (!(deps.configured ?? providerConfigured)(v.kind))
    return json({ error: "not-configured" }, 503, { "X-Voice": "not-configured" });
  const limit = deps.checkRateLimit(personKey("voice-cloud", email), {
    windowMs: WINDOW_MS,
    max: CLOUD_VOICE_MAX,
  });
  if (!limit.allowed)
    return json({ error: "Too many sentences to voice; retry later" }, 429, {
      "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)),
    });
  try {
    const lexicon = await deps.lexicon();
    const usd = providerTtsUsd(v.kind, v.name, billedChars(v, text, lexicon));
    const paid = await deps.pay(usd, () => deps.synthesize(v, text, lexicon));
    if (!paid.ok) return refusal(paid);
    const { audio, contentType } = paid.value;
    return new Response(audio, {
      headers: { "Content-Type": contentType, "X-Voice": v.kind, ...NO_STORE },
    });
  } catch (err) {
    deps.log("voice.cloud.generate", err);
    return json({ error: "Failed to generate speech" }, 502);
  }
}

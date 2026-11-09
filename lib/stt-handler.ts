/**
 * POST /api/debug/stt — the debug chat mic's transcription (docs/workers-ai.md,
 * "Speech to text"). The body is one utterance's audio, its Content-Type its
 * format (STT_MIMES, else 415). Signed-in users only; at most STT_MAX_BYTES; rate limited per user.
 * `?model=` is honoured for the owner only (from STT_MODELS), `?lang=` is an
 * optional hint (none = detect). Answers {text, model, ms, language?, signals?}. Logs
 * sizes and timings only — never the audio or the text.
 *
 * The route (app/api/debug/stt/route.ts) only wires in the session, the
 * Workers AI client and the rate limiter, so this is tested on its own.
 */
import { refusal, type Metered } from "@/lib/payments/metered";
import type { SttSignals } from "@lianki/debug-chat/stt-guard";
import {
  DEFAULT_STT_MODEL,
  FALLBACK_STT_MODEL,
  STT_MAX_BYTES,
  type SttHint,
  type SttModel,
  isSttMime,
  isSttModel,
  pickSttModel,
  sttHint,
  sttLang,
} from "./stt";

/**
 * Requests per user per STT_WINDOW_MS. Partial results while someone talks
 * come often, so this is generous; the owner's bench (clips × models) needs more.
 * The counter is per isolate (lib/rateLimit.ts), as for the other AI routes.
 */
export const STT_MAX = 120;
export const STT_MAX_OWNER = 600;
export const STT_WINDOW_MS = 10 * 60_000;

export type SttDeps = {
  user: { id: string } | null;
  owner: boolean;
  transcribe: (o: {
    audio: Uint8Array;
    mime: string;
    model: SttModel;
    lang?: string;
    hint?: SttHint;
  }) => Promise<{ text: string; language?: string; signals?: SttSignals }>;
  /**
   * The transcription paid from the user's credits (lib/payments/paid-calls.ts
   * paidStt); none: unmetered (tests, the owner's bench tools).
   */
  pay?: <T>(bytes: number, run: () => Promise<T>) => Promise<Metered<T>>;
  /** A fixed-window counter: may `key` make one more request out of `max`? */
  limit: (key: string, max: number) => { allowed: boolean; retryAfterMs: number };
  clock?: () => number;
  log?: (o: Record<string, unknown>) => void;
};

/** Both models failed: 502 with this message, and the hold refunded. */
class SttFailed extends Error {}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export async function handleStt(req: Request, d: SttDeps): Promise<Response> {
  const clock = d.clock ?? Date.now;
  const log = d.log ?? ((o) => console.log(JSON.stringify(o)));
  if (!d.user?.id) return json({ error: "Sign in" }, 401);
  if (req.method !== "POST") return json({ error: "POST the audio" }, 405);
  const mime = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!isSttMime(mime)) return json({ error: `unsupported audio type: ${mime || "none"}` }, 415);
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > STT_MAX_BYTES) return json({ error: "audio too large" }, 413);
  const audio = new Uint8Array(await req.arrayBuffer());
  if (audio.byteLength > STT_MAX_BYTES) return json({ error: "audio too large" }, 413);
  if (audio.byteLength === 0) return json({ error: "no audio" }, 400);
  const rl = d.limit(`stt:${d.user.id}`, d.owner ? STT_MAX_OWNER : STT_MAX);
  if (!rl.allowed)
    return json({ error: "too many transcriptions; try again soon" }, 429, {
      "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)),
    });

  const url = new URL(req.url);
  const asked = url.searchParams.get("model");
  const model = pickSttModel(asked, d.owner);
  const lang = sttLang(url.searchParams.get("lang"));
  const hint = sttHint(url.searchParams.get("hint"));
  const t0 = clock();
  let used = model;
  let out: { text: string; language?: string; signals?: SttSignals };
  // One attempt: the default, falling back once; a model the owner asked for does not.
  const attempt = async () => {
    try {
      out = await d.transcribe({ audio, mime, model, lang, hint });
    } catch (e) {
      if (model !== DEFAULT_STT_MODEL || (d.owner && isSttModel(asked))) {
        log({ msg: "debug.stt.error", model, bytes: audio.byteLength });
        throw new SttFailed(`transcription failed: ${(e as Error).message.slice(0, 200)}`);
      }
      used = FALLBACK_STT_MODEL;
      try {
        out = await d.transcribe({ audio, mime, model: used, lang, hint });
      } catch (e2) {
        log({ msg: "debug.stt.error", model: used, bytes: audio.byteLength });
        throw new SttFailed(`transcription failed: ${(e2 as Error).message.slice(0, 200)}`);
      }
    }
    return out;
  };
  try {
    if (d.pay) {
      // Paid from the user's credits, held by the audio's size; a failure is refunded.
      const paid = await d.pay(audio.byteLength, attempt);
      if (!paid.ok) return refusal(paid);
      out = paid.value;
    } else out = await attempt();
  } catch (e) {
    if (e instanceof SttFailed) return json({ error: e.message }, 502);
    throw e;
  }
  const ms = clock() - t0;
  log({
    msg: "debug.stt",
    model: used,
    bytes: audio.byteLength,
    ms,
    chars: out.text.length,
    ...(hint ? { hint } : {}),
    ...(out.language ? { language: out.language } : {}),
  });
  return json({
    text: out.text,
    model: used,
    ms,
    ...(out.language ? { language: out.language } : {}),
    ...(out.signals ? { signals: out.signals } : {}),
  });
}

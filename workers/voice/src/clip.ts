/**
 * lianki-voice — the pre-rendered word clips, served at the edge.
 *
 * Routed in front of the main Worker for `lianki.com/api/words/tts*`. A clip
 * rendered offline (scripts/voice, R2 `voice/<lang>/<sha256>.mp3`) is read
 * from Cloudflare's edge cache, or else from R2, and answered here — public
 * and immutable, so the edge and the browser keep it. Everything else (a
 * meaning, a language with no recordings, a text not in a list, a guest
 * asking for MeloTTS, any error here) goes to the main Worker over the MAIN
 * service binding, unchanged: app/api/words/tts/route.ts answers it as before.
 *
 * Why a Worker of its own: the main Worker is the whole Next.js app (≈23 MB).
 * A tap on a word in a new isolate waited 1–2.5 s for it to start, and every
 * clip waited on a session lookup in D1 before R2 was even asked. This one is
 * a few KB, needs no session — the clips are of the bundled public word lists
 * (public/words, public/alphabets) — and an edge-cache hit never reaches R2.
 *
 * Types are declared here rather than taken from @cloudflare/workers-types:
 * the repo's root tsconfig type-checks this folder with the DOM lib.
 */
import { MAX_TTS_TEXT, VOICE_CREDITS, ttsParams, voiceKeyAsync } from "../../../lib/voice-clip";

type R2Object = {
  body: ReadableStream;
  size: number;
  httpEtag: string;
};
type Bucket = { get(key: string): Promise<R2Object | null> };
type Fetcher = { fetch(req: Request): Promise<Response> };
/** `caches.default`: Cloudflare's cache in this data centre. */
export type EdgeCache = {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
};
export type Ctx = { waitUntil(p: Promise<unknown>): void };

export type Env = { BLOBS: Bucket; MAIN: Fetcher };

export const CLIP_PATH = "/api/words/tts";
export const CLIP_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * The cache key: one per clip whatever the spelling of the query ("fr-FR",
 * extra parameters, a padded text), and no headers — a clip is the same for
 * everyone.
 */
export function cacheKeyUrl(origin: string, lang: string, text: string) {
  return `${origin}${CLIP_PATH}?lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(text)}`;
}

/** The recording this request asks for, or null when it can only be the main Worker's. */
export function recordedClipOf(req: Request): { lang: string; text: string } | null {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  if (url.pathname !== CLIP_PATH) return null;
  const { lang, text } = ttsParams(url.searchParams);
  if (!text || text.length > MAX_TTS_TEXT || !VOICE_CREDITS[lang]) return null;
  return { lang, text };
}

export async function handle(req: Request, env: Env, ctx: Ctx, cache: EdgeCache) {
  const clip = recordedClipOf(req);
  if (!clip) return env.MAIN.fetch(req);
  try {
    const key = new Request(cacheKeyUrl(new URL(req.url).origin, clip.lang, clip.text));
    const hit = await cache.match(key);
    if (hit) return hit;
    const obj = await env.BLOBS.get(await voiceKeyAsync(clip.lang, clip.text));
    if (!obj) return env.MAIN.fetch(req);
    const res = new Response(obj.body, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(obj.size),
        ETag: obj.httpEtag,
        "Cache-Control": CLIP_CACHE_CONTROL,
        "X-Voice": "recorded",
      },
    });
    ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
    return res;
  } catch (err) {
    console.error(JSON.stringify({ event: "voice.edge.error", error: String(err).slice(0, 300) }));
    return env.MAIN.fetch(req);
  }
}

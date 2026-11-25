/**
 * How the agent's voice leaves the page and how the mic is opened
 * (docs/monitoring.md, "Hands-free voice", "Echo cancellation"):
 *
 * - `lk:voice-out` picks the output: "speech" (default, the device's own
 *   speechSynthesis) or "cloud" (each sentence fetched from /api/words/tts and
 *   played through one `<audio>` element routed through the mic's
 *   AudioContext and a GainNode — page audio, so the browser's echo canceller
 *   has it as its reference, and the gain ducks it; iOS ignores
 *   `element.volume`).
 * - `lk:voice-aec` (aec.ts; default on) opens the mic with echoCancellation,
 *   noiseSuppression and autoGainControl and keeps it open while the agent
 *   speaks. "0" opens it with no processing at all, and capture is held
 *   while anything plays (half-duplex).
 *
 * createCloudOut takes its browser pieces injected (fetch, the element, the
 * AudioContext), so it is tested with fakes in unit/voice-out.test.ts.
 */
import { noteOpened } from "./aec";
import { encodeWav } from "./mic";
import type { CloudOut, LinePick, PlayEvents, Playback, ReadTiming } from "./voice";
import { type HeardVoice, pickLocalVoice, pinnedLocalVoice } from "./voice-heard";
import { CLONE_VOICE_NAME, cloneTimeoutMs, cloneTtsBase, cloneTtsUrl } from "./polish-readback";
import { MELO_LANGS, VOICES, type VoiceId, cloudVoice } from "./voices";
import { localTtsFallback } from "./local-tts-fallback";

/** The route's X-Voice for a clip in a lane's own cloud speaker (lib/words-tts.ts). */
export const AURA_VOICE = "aura-2";

export const VOICE_OUT_KEY = "lk:voice-out";
export type OutMode = "speech" | "cloud";
// The echo cancellation switch lives in aec.ts (small, so /words can show it).
export {
  AEC_CONSTRAINTS,
  LEGACY_CONSTRAINTS,
  RAW_CONSTRAINTS,
  VOICE_AEC_KEY,
  aecOn,
  applyAec,
  micAec,
  micConstraints,
  setAec,
} from "./aec";

/** /api/words/tts refuses text longer than this (its MAX_TEXT). */
export const TTS_MAX_TEXT = 200;
/** Languages the route can voice any text in (MeloTTS, lib/workers-ai.ts MELOTTS_LANGS). */
export const CLOUD_LANGS: ReadonlySet<string> = new Set(MELO_LANGS);
/** A clip resumed after an interruption starts this much before where it stopped. */
export const RESUME_REWIND_S = 0.3;
const ignore = () => {};
/**
 * How long a suspended AudioContext gets to resume before a clip: Chrome
 * keeps resume() pending (not rejected) until the page has had a tap, and
 * the element, routed through the context, would play into silence.
 */
export const CTX_RESUME_MS = 1_500;
/** Clips (blob URLs) kept for replays and resumes. */
const CLIP_CACHE = 64;

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
/** The output mode: "cloud" only when asked for. */
export const outMode = (): OutMode => (read(VOICE_OUT_KEY) === "cloud" ? "cloud" : "speech");
/**
 * speechSynthesis lists no voice at all (some Android Chromes, always): the
 * replies go to the cloud (voice.ts), so its element is unlocked in a gesture.
 */
export const noSpeechVoices = (): boolean => {
  try {
    return typeof speechSynthesis === "undefined" || speechSynthesis.getVoices().length === 0;
  } catch {
    return true;
  }
};
/** What the browser actually applied to the mic track, for the debug log. */
let applied: Record<string, unknown> | null = null;
export function noteTrack(
  stream: { getAudioTracks(): { getSettings?(): object }[] },
  aec?: boolean,
) {
  // The mode it was opened with (aec.ts micAec): the hold and the clips' `aec` go by it.
  if (aec !== undefined) noteOpened(aec);
  try {
    const s = (stream.getAudioTracks()[0]?.getSettings?.() ?? {}) as Record<string, unknown>;
    const { echoCancellation, noiseSuppression, autoGainControl, sampleRate, channelCount } = s;
    applied = { echoCancellation, noiseSuppression, autoGainControl, sampleRate, channelCount };
  } catch {
    applied = null;
  }
}
export const appliedSettings = () => applied;

/**
 * The page's one AudioContext for voice: the energy fallback records through
 * it, the voice cues play on it, and cloud replies play through it. Made on
 * the mic tap (a gesture, which iOS needs).
 */
let audio: AudioContext | null = null;
export function audioCtx(): AudioContext | null {
  if (audio) return audio;
  const Ctx =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctx ? (audio = new Ctx()) : null;
}
export const existingCtx = () => audio;

/**
 * How long a clip has left to play (the chat's reading sweep): its seconds
 * still to go over its speed, and the share already behind it (a resume by
 * offset). Null while its length is unknown (no metadata yet, or a stream).
 */
export function clipTiming(
  a: Pick<ElementLike, "duration" | "currentTime" | "playbackRate">,
): ReadTiming | null {
  const d = a.duration;
  if (d === undefined || !Number.isFinite(d) || d <= 0) return null;
  const at = Math.min(Math.max(0, a.currentTime || 0), d);
  const rate = a.playbackRate && a.playbackRate > 0 ? a.playbackRate : 1;
  return { ms: ((d - at) / rate) * 1000, done: at / d };
}

/** The slice of an HTMLAudioElement the cloud output uses. */
export type ElementLike = {
  src: string;
  currentTime: number;
  volume: number;
  preload: string;
  paused: boolean;
  /** The reading speed; load() resets it to defaultPlaybackRate, so both are set. */
  playbackRate?: number;
  defaultPlaybackRate?: number;
  /** Keep the voice's pitch at any speed (and Safari's prefixed name). */
  preservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
  /** Seconds, once the metadata is in (NaN before; Infinity for a stream). */
  duration?: number;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  onloadedmetadata: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
};
export type GainLike = {
  gain: {
    value: number;
    cancelScheduledValues(t: number): unknown;
    setValueAtTime(v: number, t: number): unknown;
    linearRampToValueAtTime(v: number, t: number): unknown;
  };
  connect(n: unknown): unknown;
};
export type AudioBufferLike = {
  duration: number;
};
export type BufferSourceLike = {
  buffer: AudioBufferLike | null;
  playbackRate?: { value: number };
  onended: (() => void) | null;
  connect(n: unknown): unknown;
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
  disconnect?(): void;
};
export type CtxLike = {
  currentTime: number;
  destination: unknown;
  state?: string;
  resume?(): Promise<void>;
  createGain(): GainLike;
  createMediaElementSource(el: unknown): { connect(n: unknown): unknown };
  decodeAudioData?(data: ArrayBuffer): Promise<AudioBufferLike>;
  createBufferSource?(): BufferSourceLike;
};

/**
 * The route's URL for one sentence. `store=0`: a chat line is never asked for
 * again, so the route does not keep it in R2 and sends it `no-store`; a
 * replay comes from `clips` below (blob URLs in memory), not the HTTP cache.
 */
export const ttsUrl = (text: string, lang: string, speaker?: string) =>
  `/api/words/tts?lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(text)}&store=0${
    speaker ? `&speaker=${encodeURIComponent(speaker)}` : ""
  }`;

/**
 * A provider voice's URL for one sentence (lib/cloud-voices-handler.ts):
 * synthesized on the server, never kept (`no-store`), paid from credits.
 */
export const providerTtsUrl = (voice: string, text: string) =>
  `/api/voice/tts?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}`;

export const LOCAL_TTS_KEY = "lk:agent-local-tts";
/** The owner's Mac-local Kokoro server, from the build's environment (never the repository); "" = none. */
export const DEFAULT_LOCAL_TTS_BASE =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_LIANKI_LOCAL_TTS_BASE) || "";

let nekoTurnIdx = 0;

/**
 * A Mac-local Kokoro clip's URL, and the concrete voice it asks for:
 * `neko-cycle` is the voice pinned on this device (voice-heard.ts), else the
 * rotation's next turn (one per clip).
 */
export const localTts = (voice: string, text: string): { url: string; heard: HeardVoice } => {
  const base = (read(LOCAL_TTS_KEY) || DEFAULT_LOCAL_TTS_BASE).replace(/\/+$/, "");
  const pinned = voice === "neko-cycle" ? pinnedLocalVoice() : null;
  const heard = pickLocalVoice(voice, nekoTurnIdx, pinned);
  if (voice === "neko-cycle" && !pinned) nekoTurnIdx++;
  return {
    url: `${base}/tts?voice=${encodeURIComponent(heard.name)}&text=${encodeURIComponent(text)}`,
    heard,
  };
};
export const localTtsUrl = (voice: string, text: string) => localTts(voice, text).url;

/** The provider id of the owner's cloned voice (polish-readback.ts). */
export const CLONE_PROVIDER = "clone";

/** Why a provider voice cannot be asked for a sentence (null: ask it). Any language. */
export function providerSkip(text: string): string | null {
  if (!text.trim()) return "empty";
  if (text.length > TTS_MAX_TEXT) return "long";
  return null;
}

/** Why a sentence cannot be fetched at all (null: try the route). */
export function cloudSkip(text: string, lang: string): string | null {
  if (!CLOUD_LANGS.has(lang.toLowerCase().split(/[-_]/)[0])) return "lang";
  if (!text.trim()) return "empty";
  if (text.length > TTS_MAX_TEXT) return "long";
  return null;
}

export type ScheduledPlayOpts = {
  buffer: AudioBufferLike;
  /** AudioContext.currentTime at which to start (default: ctx.currentTime). */
  when?: number;
  /** Buffer offset in seconds (default: 0). */
  offset?: number;
  volume: number;
  rate?: number;
};

export type DecodedClip = {
  clipKey: string;
  buffer: AudioBufferLike;
  decodeMs: number;
  fellBack: boolean;
  shift: number;
};

export type DecodeClipInput = {
  text: string;
  written?: string;
  lang: string;
  voice?: VoiceId;
  pick?: LinePick;
};

/** Compute the canonical cache/sync key for a clip request. */
export const clipCacheKey = (
  text: string,
  lang: string,
  speaker?: string,
  provider?: string,
): string => `${provider ?? lang}\n${speaker ?? ""}\n${text}`;

/**
 * Cloud replies: one `<audio>` element for the whole page (unlocked once in
 * a gesture, so iOS lets later sentences play), routed through the
 * AudioContext and one GainNode. A sentence that cannot be fetched or played
 * calls `onfail` (the session reads it with speechSynthesis instead).
 */
export function createCloudOut(d: {
  fetch: (url: string) => Promise<{
    ok: boolean;
    status: number;
    headers: { get(k: string): string | null };
    blob(): Promise<Blob>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  }>;
  element: () => ElementLike;
  /** A second element, never routed through the context: ElevenLabs previews (absent: none play). */
  plain?: () => ElementLike;
  ctx: () => CtxLike | null;
  toUrl?: (b: Blob) => string;
  revoke?: (u: string) => void;
  setTimer?: (f: () => void, ms: number) => unknown;
  now?: () => number;
  /** The clone server's base URL (null: off on this device); absent: polish-readback.ts cloneTtsBase. */
  cloneBase?: () => string | null;
  /** How long a clone clip may take (ms); absent: polish-readback.ts cloneTimeoutMs. */
  cloneTimeout?: () => number;
}): CloudOut & {
  unlock(): void;
  gain(): GainLike | null;
  decodeClip(s: DecodeClipInput): Promise<DecodedClip>;
  playScheduled(opts: ScheduledPlayOpts, ev: PlayEvents): Playback;
} {
  const toUrl = d.toUrl ?? ((b) => URL.createObjectURL(b));
  const revoke = d.revoke ?? ((u) => URL.revokeObjectURL(u));
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const nowMs = d.now ?? (() => Date.now());
  const cloneBase = d.cloneBase ?? cloneTtsBase;
  const cloneTimeout = d.cloneTimeout ?? cloneTimeoutMs;
  /**
   * The context the element plays through, running: null when it is (or
   * there is none, or the element is not routed through it), else the state
   * it is stuck in after CTX_RESUME_MS.
   */
  const ctxReady = (): Promise<string | null> => {
    const ctx = d.ctx();
    if (!ctx || !gain || !ctx.resume || ctx.state === undefined || ctx.state === "running")
      return Promise.resolve(null);
    return new Promise((done) => {
      const check = () => done(ctx.state === "running" ? null : String(ctx.state));
      setTimer(check, CTX_RESUME_MS);
      ctx.resume!().then(check, check);
    });
  };
  const clipBlobs = new Map<string, Promise<{ blob: Blob; fellBack: boolean; heard: { name: string } }>>();
  const clips = new Map<string, Promise<string>>();
  const decodedClips = new Map<string, Promise<{ buffer: AudioBufferLike; decodeMs: number }>>();
  /** Clips that came back in the route's one voice though a speaker was asked for. */
  const fellBack = new Set<string>();
  /** The concrete voice of each clip (blob URL): a rotated Kokoro name, a provider id, aura:/melo:. */
  const clipVoice = new Map<string, HeardVoice>();
  let el: ElementLike | null = null;
  let gain: GainLike | null = null;
  let wired = false;
  let activeSource: BufferSourceLike | null = null;
  /** Bumped by every play and stop: the element's events for older ones are ignored. */
  let turn = 0;

  const stopActiveSource = () => {
    const src = activeSource;
    if (!src) return;
    activeSource = null;
    src.onended = null;
    try {
      src.stop();
      src.disconnect?.();
    } catch {}
  };

  const ensureGain = (): GainLike | null => {
    if (gain) return gain;
    const ctx = d.ctx();
    if (!ctx) return null;
    try {
      const g = ctx.createGain();
      g.connect(ctx.destination);
      gain = g;
    } catch {
      gain = null;
    }
    return gain;
  };

  const element = () => {
    if (!el) {
      el = d.element();
      el.preload = "auto";
    }
    if (!wired) {
      // Through Web Audio once a context exists; createMediaElementSource may be called once per element.
      const ctx = d.ctx();
      if (ctx) {
        wired = true;
        try {
          const g = ensureGain();
          if (g) ctx.createMediaElementSource(el).connect(g);
        } catch {
          gain = null; // plays unrouted: no ducking on iOS
        }
      }
    }
    return el;
  };

  const fetchClipBlob = (
    text: string,
    lang: string,
    speaker?: string,
    provider?: string,
  ): Promise<{ blob: Blob; fellBack: boolean; heard: { name: string } }> => {
    const pin = provider === "local:neko-cycle" ? pinnedLocalVoice() : null;
    const key = clipCacheKey(text, lang, speaker, pin && provider ? `${provider}@${pin}` : provider);
    const have = clipBlobs.get(key);
    if (have) return have;
    const base = lang.split(/[-_]/)[0]!;
    const local = provider?.startsWith("local:") ? localTts(provider.slice(6), text) : null;
    const clone = provider === CLONE_PROVIDER;
    const cloneAt = clone ? cloneBase() : null;
    if (clone && !cloneAt) return Promise.reject(new Error("clone off"));
    const url = local
      ? local.url
      : cloneAt
        ? cloneTtsUrl(cloneAt, text)
        : provider
          ? providerTtsUrl(provider, text)
          : ttsUrl(text, base, speaker);
    const got = clone
      ? new Promise<Awaited<ReturnType<typeof d.fetch>>>((ok, no) => {
          const ms = cloneTimeout();
          setTimer(() => no(new Error(`clone timeout ${ms} ms`)), ms);
          d.fetch(url).then(ok, no);
        })
      : local
        ? d.fetch(url).catch(() =>
            d.fetch(`${ttsUrl(text, base)}&localVoice=${encodeURIComponent(local.heard.name)}`),
          )
        : d.fetch(url);
    const p = got.then(async (r) => {
      if (!r.ok)
        throw new Error(`http ${r.status}${r.headers.get("X-Voice") ? ` ${r.headers.get("X-Voice")}` : ""}`);
      const blob = await r.blob();
      const said = r.headers.get("X-Voice");
      const fb = Boolean(speaker && said !== null && said !== AURA_VOICE);
      const heard = local
        ? local.heard
        : clone
          ? { name: CLONE_VOICE_NAME }
          : { name: provider ?? (speaker && !fb ? `aura:${speaker}` : `melo:${base}`) };
      return { blob, fellBack: fb, heard };
    });
    clipBlobs.set(key, p);
    p.catch(() => clipBlobs.delete(key));
    if (clipBlobs.size > CLIP_CACHE) {
      const oldest = clipBlobs.keys().next().value;
      if (oldest !== undefined) clipBlobs.delete(oldest);
    }
    return p;
  };

  /** `speaker`: a lane's own cloud voice (voices.ts cloudVoice); absent = the language's one voice. */
  /** `provider`: a provider voice id (google:, azure:), fetched from its own route. */
  const fetchClip = (
    text: string,
    lang: string,
    speaker?: string,
    provider?: string,
  ): Promise<string> => {
    const pin = provider === "local:neko-cycle" ? pinnedLocalVoice() : null;
    const key = clipCacheKey(text, lang, speaker, pin && provider ? `${provider}@${pin}` : provider);
    const have = clips.get(key);
    if (have) return have;
    const p = fetchClipBlob(text, lang, speaker, provider).then(({ blob, fellBack: fb, heard }) => {
      const url = toUrl(blob);
      if (fb) fellBack.add(url);
      clipVoice.set(url, heard);
      return url;
    });
    clips.set(key, p);
    p.catch(() => clips.delete(key));
    if (clips.size > CLIP_CACHE) {
      const [k, old] = clips.entries().next().value as [string, Promise<string>];
      clips.delete(k);
      old.then((u) => {
        fellBack.delete(u);
        clipVoice.delete(u);
        revoke(u);
      }, ignore);
    }
    return p;
  };

  const ramp = (level: number, ms: number) => {
    const ctx = d.ctx();
    if (gain && ctx) {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(level, now + ms / 1000);
    } else if (el) el.volume = level;
  };
  /** What a sentence asks the route for: the line's own melo/aura voice, else its lane's. */
  const wanted = (
    lang: string,
    voice?: VoiceId,
    pick?: LinePick,
  ): { lang: string; speaker?: string; provider?: string; shift: number } => {
    if (pick?.kind === "google" || pick?.kind === "azure")
      return { lang, provider: pick.id, shift: 1 };
    if (pick?.kind === "local")
      return { lang, provider: `local:${pick.name}`, shift: 1 };
    if (pick?.kind === "clone") return { lang, provider: CLONE_PROVIDER, shift: 1 };
    if (voice === "bright" && read(LOCAL_TTS_KEY) !== "off")
      return { lang, provider: "local:neko-cycle", shift: 1 };
    // The calm lanes (codex, 小克) get a Mac-local voice of their own for Chinese
    // (yunxi is a Mandarin voice), so they never sound like the baby voice beside
    // them (owner, 2026-11-14 "听起来一模一样"); other languages keep the cloud's.
    if (voice === "calm" && /^zh/i.test(lang) && read(LOCAL_TTS_KEY) !== "off")
      return { lang, provider: "local:yunxi", shift: 1 };
    if (pick?.kind === "melo") return { lang: pick.lang, shift: 1 };
    if (pick?.kind === "aura") return { lang: pick.lang, speaker: pick.speaker, shift: 1 };
    const local = localTtsFallback(
      lang,
      voice,
      read(LOCAL_TTS_KEY) !== "off" && Boolean(read(LOCAL_TTS_KEY) || DEFAULT_LOCAL_TTS_BASE),
    );
    if (local && !cloudVoice(voice ?? "main", lang).speaker)
      return { lang, provider: `local:${local}`, shift: 1 };
    return { lang, ...cloudVoice(voice ?? "main", lang) };
  };

  /**
   * An ElevenLabs preview clip (voices.ts ELEVEN_PREVIEWS), straight from
   * ElevenLabs. On its own element, not through the voice context: their
   * storage sends no CORS headers, and a context plays such media as silence.
   * Any failure (refused before a tap, gone, blocked) is onfail: the session
   * then reads the line in its lane's voice.
   */
  let plainEl: ElementLike | null = null;
  const plain = () => (plainEl ??= d.plain?.() ?? null);
  const preview = (
    url: string,
    id: string,
    volume: number,
    live: () => boolean,
    ev: PlayEvents,
  ): Playback => {
    const a = plain();
    const fail = (why: string) => void Promise.resolve().then(() => live() && ev.onfail?.(why));
    const pb: Playback = {
      route: "audio",
      stop() {
        if (!live()) return {};
        turn++;
        a?.pause();
        return {};
      },
      volume: (level) => {
        if (live() && a) a.volume = level;
      },
    };
    if (!a) {
      fail("no element for a preview");
      return pb;
    }
    a.volume = volume;
    ev.onvoice?.({ name: `eleven:${id}` });
    a.onended = () => live() && ev.onend();
    a.onerror = () => live() && ev.onfail?.("preview error");
    // Its length may come after it started (no load() first): told then.
    let started = false;
    const tell = () => {
      const t = clipTiming(a);
      if (t) ev.ontiming?.(t);
    };
    a.onloadedmetadata = () => {
      if (!live()) return;
      a.onloadedmetadata = null;
      if (started) tell();
    };
    a.src = url;
    a.play().then(
      () => {
        if (!live()) return;
        started = true;
        ev.onstart?.();
        tell();
      },
      (e: unknown) => live() && ev.onfail?.(`play ${(e as Error)?.name ?? "error"}`),
    );
    return pb;
  };

  const setLevel = (level: number) => {
    const ctx = d.ctx();
    if (gain && ctx) {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(level, ctx.currentTime);
    } else if (el) el.volume = level;
  };

  const resolveClipRequest = (s: DecodeClipInput) => {
    const lane = wanted(s.lang, s.voice, s.pick);
    const base = lane.provider ? wanted(s.lang, s.voice) : lane;
    let used = lane;
    const keyFor = (w: typeof lane, txt: string) =>
      clipCacheKey(txt, w.provider ? w.lang : w.lang.split(/[-_]/)[0], w.speaker, w.provider);
    const fetchUsed = (): Promise<{
      clipKey: string;
      blob: Blob;
      fellBack: boolean;
      used: typeof lane;
    }> => {
      const ownVoice = () => {
        used = base;
        const skip = cloudSkip(s.text, base.lang);
        if (skip) return Promise.reject(new Error(skip));
        const clipKey = keyFor(base, s.text);
        return fetchClipBlob(s.text, base.lang, base.speaker).then((r) => ({
          ...r,
          clipKey,
          used,
        }));
      };
      if (lane.provider) {
        const said = s.written ?? s.text;
        if (providerSkip(said)) return ownVoice();
        const clipKey = keyFor(lane, said);
        return fetchClipBlob(said, lane.lang, undefined, lane.provider)
          .then((r) => ({ ...r, clipKey, used }))
          .catch(ownVoice);
      }
      const skip = cloudSkip(s.text, lane.lang);
      if (skip) return Promise.reject(new Error(skip));
      const clipKey = keyFor(lane, s.text);
      return fetchClipBlob(s.text, lane.lang, lane.speaker).then((r) => ({
        ...r,
        clipKey,
        used,
      }));
    };
    return { lane, fetchUsed };
  };

  const decodeClip = async (s: DecodeClipInput): Promise<DecodedClip> => {
    const ctx = d.ctx();
    if (!ctx?.decodeAudioData) throw new Error("no decodeAudioData");
    const { lane, fetchUsed } = resolveClipRequest(s);
    const t0 = nowMs();
    const { clipKey, blob, fellBack: fb, used } = await fetchUsed();
    let p = decodedClips.get(clipKey);
    if (!p) {
      p = blob.arrayBuffer().then(async (ab) => {
        const buffer = await ctx.decodeAudioData!(ab);
        return { buffer, decodeMs: Math.max(0, nowMs() - t0) };
      });
      decodedClips.set(clipKey, p);
      p.catch(() => decodedClips.delete(clipKey));
      if (decodedClips.size > CLIP_CACHE) {
        const oldest = decodedClips.keys().next().value;
        if (oldest !== undefined) decodedClips.delete(oldest);
      }
    }
    const { buffer, decodeMs } = await p;
    const shift =
      fb && (!s.pick || used !== lane) ? VOICES[s.voice ?? "main"].shift : used.shift;
    return { clipKey, buffer, decodeMs, fellBack: fb, shift };
  };

  const scheduleBuffer = (
    opts: ScheduledPlayOpts,
    ev: PlayEvents,
    me: number,
    live: () => boolean,
  ): Playback => {
    const fail = (why: string) => void Promise.resolve().then(() => live() && ev.onfail?.(why));
    let startCtxTime = 0;
    let startOffsetSec = Math.max(0, opts.offset ?? 0);
    let startRate = opts.rate ?? 1;
    let started = false;
    const pb: Playback = {
      route: "audio",
      stop() {
        if (!live()) return {};
        turn++;
        const ctx = d.ctx();
        stopActiveSource();
        if (!started || !ctx) return { at: startOffsetSec };
        const elapsed = Math.max(0, (ctx.currentTime - startCtxTime) * startRate);
        return { at: Math.max(0, startOffsetSec + elapsed - RESUME_REWIND_S) };
      },
      volume: (level, ms) => live() && ramp(level, ms),
    };
    const ctx = d.ctx();
    if (!ctx?.createBufferSource) {
      fail("no AudioBufferSourceNode");
      return pb;
    }
    const startNow = () => {
      if (!live()) return;
      ensureGain();
      setLevel(opts.volume);
      const src = ctx.createBufferSource!();
      activeSource = src;
      src.buffer = opts.buffer;
      startRate = opts.rate ?? 1;
      if (src.playbackRate) src.playbackRate.value = startRate;
      src.connect(gain ?? ctx.destination);
      src.onended = () => {
        if (activeSource === src) activeSource = null;
        if (live()) ev.onend();
      };
      const nowCtx = ctx.currentTime;
      const when = Math.max(nowCtx, opts.when ?? nowCtx);
      startCtxTime = when;
      startOffsetSec = Math.max(0, opts.offset ?? 0);
      started = true;
      src.start(when, startOffsetSec);
      const delayMs = Math.max(0, (when - nowCtx) * 1000);
      if (delayMs === 0) {
        ev.onstart?.();
      } else {
        setTimer(() => {
          if (live()) ev.onstart?.();
        }, delayMs);
      }
    };
    ensureGain();
    if (!ctx.resume || ctx.state === undefined || ctx.state === "running") {
      startNow();
    } else {
      ctxReady().then((stuck) => {
        if (!live()) return;
        if (stuck === "closed") return ev.onfail?.("audio context closed");
        if (stuck) return ev.onfail?.(`play NotAllowedError (audio context ${stuck})`);
        startNow();
      });
    }
    return pb;
  };

  return {
    unlock() {
      // In a gesture: an element that has played once may play later without one (iOS).
      const a = element();
      if (!a.paused) return;
      a.src = silentWav();
      const me = turn;
      // A reply that started meanwhile is not paused by this late settle.
      a.play().then(() => me === turn && a.src === silent && a.pause(), ignore);
      // The preview element too, so a preview may play later without a tap (iOS).
      const b = plain();
      if (b && b.paused) {
        b.src = silentWav();
        b.play().then(() => me === turn && b.src === silent && b.pause(), ignore);
      }
    },
    gain: () => gain,
    decodeClip,
    playScheduled(opts: ScheduledPlayOpts, ev: PlayEvents): Playback {
      const me = ++turn;
      el?.pause();
      stopActiveSource();
      return scheduleBuffer(opts, ev, me, () => me === turn);
    },
    prepare(text, lang, voice, pick, written) {
      if (pick?.kind === "eleven") return;
      const w = wanted(lang, voice, pick);
      if (w.provider) {
        const said = written ?? text;
        if (!providerSkip(said)) fetchClip(said, w.lang, undefined, w.provider).catch(ignore);
      } else if (!cloudSkip(text, w.lang)) fetchClip(text, w.lang, w.speaker).catch(ignore);
    },
    play(
      s: Parameters<CloudOut["play"]>[0] & { when?: number; sync?: boolean },
      ev: PlayEvents,
    ): Playback {
      const me = ++turn;
      const live = () => me === turn;
      const fail = (why: string) => void Promise.resolve().then(() => live() && ev.onfail?.(why));
      stopActiveSource();
      if (s.pick?.kind === "eleven") return preview(s.pick.preview, s.pick.id, s.volume, live, ev);
      let activeScheduledPb: Playback | null = null;
      const pb: Playback = {
        route: "audio",
        stop() {
          if (activeScheduledPb) return activeScheduledPb.stop();
          if (!live()) return {};
          turn++;
          const a = el;
          if (!a) return { at: s.at };
          a.pause();
          return { at: Math.max(0, a.currentTime - RESUME_REWIND_S) };
        },
        volume: (level, ms) => live() && ramp(level, ms),
      };
      const playViaElement = () => {
        // The line's own cloud voice (melo:, aura:), else its lane's: its own speaker where
        // the engine has several, else the one voice at its own speed.
        const lane = wanted(s.lang, s.voice, s.pick);
        // A provider voice (google:, azure:) the server cannot voice (no key, an error, out
        // of credits): the lane's own cloud voice reads the spoken text instead.
        const base = lane.provider ? wanted(s.lang, s.voice) : lane;
        let used = lane;
        const ownVoice = () => {
          used = base;
          const skip = cloudSkip(s.text, base.lang);
          return skip ? Promise.reject(new Error(skip)) : fetchClip(s.text, base.lang, base.speaker);
        };
        let clip: Promise<string>;
        if (lane.provider === CLONE_PROVIDER) {
          // His own voice or nothing: a failure is onfail (voice.ts skips the sentence).
          const skip = providerSkip(s.text);
          clip = skip ? Promise.reject(new Error(skip)) : fetchClip(s.text, lane.lang, undefined, lane.provider);
        } else if (lane.provider) {
          const said = s.written ?? s.text;
          clip = providerSkip(said)
            ? ownVoice()
            : fetchClip(said, lane.lang, undefined, lane.provider).catch(ownVoice);
        } else {
          const skip = cloudSkip(s.text, lane.lang);
          if (skip) {
            fail(skip);
            return;
          }
          clip = fetchClip(s.text, lane.lang, lane.speaker);
        }
        clip.then(
          (url) => {
            if (!live()) return;
            const a = element();
            return ctxReady().then((stuck) => {
              if (!live()) return;
              // Routed through a context the browser will not run (no tap yet): it would be silent.
              // A closed one never runs again: not a tap's matter, that clip fails outright.
              if (stuck === "closed") return ev.onfail?.("audio context closed");
              if (stuck) return ev.onfail?.(`play NotAllowedError (audio context ${stuck})`);
              const heard = clipVoice.get(url);
              if (heard) ev.onvoice?.(heard);
              setLevel(s.volume);
              a.onended = () => live() && ev.onend();
              a.onerror = () => live() && ev.onerror();
              a.onloadedmetadata = () => {
                if (!live()) return;
                a.onloadedmetadata = null;
                // Resume by offset: where the interrupted clip stopped (else its start).
                a.currentTime = s.at;
                // The speed, pitch kept (a resume after a duck keeps it: it is per play).
                // A lane with no voice of its own here: its own speed, pitch still kept —
                // a pitch-free clip stalls mid-word on iOS (voices.ts, "Cloud voices").
                const shift =
                  fellBack.has(url) && (!s.pick || used !== lane)
                    ? VOICES[s.voice ?? "main"].shift
                    : used.shift;
                const rate = (s.rate ?? 1) * shift;
                a.defaultPlaybackRate = rate;
                a.playbackRate = rate;
                a.preservesPitch = true;
                a.webkitPreservesPitch = true;
                a.play().then(
                  () => {
                    if (!live()) return;
                    ev.onstart?.();
                    // The metadata is in: the clip's own length, at its speed.
                    const t = clipTiming(a);
                    if (t) ev.ontiming?.(t);
                  },
                  (e: unknown) => {
                    if (live()) ev.onfail?.(`play ${(e as Error)?.name ?? "error"}`);
                  },
                );
              };
              a.src = url;
              a.load();
            });
          },
          (e: unknown) => live() && ev.onfail?.(String((e as Error)?.message ?? e)),
        );
      };

      const ctx = d.ctx();
      if ((s.sync || s.when !== undefined) && ctx?.decodeAudioData && ctx?.createBufferSource) {
        decodeClip(s).then(
          (decoded) => {
            if (!live()) return;
            activeScheduledPb = scheduleBuffer(
              {
                buffer: decoded.buffer,
                when: s.when,
                offset: s.at,
                volume: s.volume,
                rate: (s.rate ?? 1) * decoded.shift,
              },
              ev,
              me,
              live,
            );
          },
          () => {
            if (!live()) return;
            // Decode failed: fall back to the `<audio>` element path.
            playViaElement();
          },
        );
        return pb;
      }

      playViaElement();
      return pb;
    },
  };
}

/** 10 ms of silence (8 kHz WAV): what unlock() plays in the gesture. */
let silent = "";
const silentWav = () => {
  if (silent) return silent;
  let bin = "";
  for (const b of encodeWav(new Float32Array(80), 8_000)) bin += String.fromCharCode(b);
  return (silent = `data:audio/wav;base64,${btoa(bin)}`);
};

let browserCloud: ReturnType<typeof createCloudOut> | null = null;
/** The page's cloud output (null outside a browser). */
export function cloudOut() {
  if (browserCloud) return browserCloud;
  if (typeof Audio === "undefined" || typeof fetch === "undefined") return null;
  browserCloud = createCloudOut({
    fetch: (u) => fetch(u),
    element: () => new Audio() as unknown as ElementLike,
    plain: () => new Audio() as unknown as ElementLike,
    ctx:() => existingCtx() as unknown as CtxLike | null,
  });
  return browserCloud;
}

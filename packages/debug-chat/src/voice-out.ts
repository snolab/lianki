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
import type { CloudOut, LinePick, PlayEvents, Playback } from "./voice";
import { MELO_LANGS, VOICES, type VoiceId, cloudVoice } from "./voices";

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
export type CtxLike = {
  currentTime: number;
  destination: unknown;
  state?: string;
  resume?(): Promise<void>;
  createGain(): GainLike;
  createMediaElementSource(el: unknown): { connect(n: unknown): unknown };
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
export const DEFAULT_LOCAL_TTS_BASE = "https://taku.onca-tint.ts.net/lianki-tts";

const NEKO_ROTATION = ["neko", "neko-moe", "neko-soft", "xiaobei", "xiaoxiao", "alpha"] as const;
let nekoTurnIdx = 0;

export const localTtsUrl = (voice: string, text: string) => {
  const base = (read(LOCAL_TTS_KEY) || DEFAULT_LOCAL_TTS_BASE).replace(/\/+$/, "");
  const picked =
    voice === "neko-cycle" ? NEKO_ROTATION[nekoTurnIdx++ % NEKO_ROTATION.length]! : voice;
  return `${base}/tts?voice=${encodeURIComponent(picked)}&text=${encodeURIComponent(text)}`;
};

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

/**
 * Cloud replies: one `<audio>` element for the whole page (unlocked once in
 * a gesture, so iOS lets later sentences play), routed through the
 * AudioContext and one GainNode. A sentence that cannot be fetched or played
 * calls `onfail` (the session reads it with speechSynthesis instead).
 */
export function createCloudOut(d: {
  fetch: (url: string) => Promise<{ ok: boolean; status: number; headers: { get(k: string): string | null }; blob(): Promise<Blob> }>;
  element: () => ElementLike;
  /** A second element, never routed through the context: ElevenLabs previews (absent: none play). */
  plain?: () => ElementLike;
  ctx: () => CtxLike | null;
  toUrl?: (b: Blob) => string;
  revoke?: (u: string) => void;
  setTimer?: (f: () => void, ms: number) => unknown;
}): CloudOut & { unlock(): void; gain(): GainLike | null } {
  const toUrl = d.toUrl ?? ((b) => URL.createObjectURL(b));
  const revoke = d.revoke ?? ((u) => URL.revokeObjectURL(u));
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
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
  const clips = new Map<string, Promise<string>>();
  /** Clips that came back in the route's one voice though a speaker was asked for. */
  const fellBack = new Set<string>();
  let el: ElementLike | null = null;
  let gain: GainLike | null = null;
  let wired = false;
  /** Bumped by every play and stop: the element's events for older ones are ignored. */
  let turn = 0;

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
          const g = ctx.createGain();
          ctx.createMediaElementSource(el).connect(g);
          g.connect(ctx.destination);
          gain = g;
        } catch {
          gain = null; // plays unrouted: no ducking on iOS
        }
      }
    }
    return el;
  };

  /** `speaker`: a lane's own cloud voice (voices.ts cloudVoice); absent = the language's one voice. */
  /** `provider`: a provider voice id (google:, azure:), fetched from its own route. */
  const fetchClip = (
    text: string,
    lang: string,
    speaker?: string,
    provider?: string,
  ): Promise<string> => {
    const key = `${provider ?? lang}\n${speaker ?? ""}\n${text}`;
    const have = clips.get(key);
    if (have) return have;
    const url = provider
      ? provider.startsWith("local:")
        ? localTtsUrl(provider.slice(6), text)
        : providerTtsUrl(provider, text)
      : ttsUrl(text, lang.split(/[-_]/)[0], speaker);
    const p = d.fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`http ${r.status}${r.headers.get("X-Voice") ? ` ${r.headers.get("X-Voice")}` : ""}`);
      const url = toUrl(await r.blob());
      // The speaker was asked for but the route answered with its one voice (it fell back).
      // No X-Voice at all (hidden by CORS): the route did not say, so it is not taken as one.
      const said = r.headers.get("X-Voice");
      if (speaker && said !== null && said !== AURA_VOICE) fellBack.add(url);
      return url;
    });
    clips.set(key, p);
    p.catch(() => clips.delete(key));
    if (clips.size > CLIP_CACHE) {
      const [k, old] = clips.entries().next().value as [string, Promise<string>];
      clips.delete(k);
      old.then((u) => {
        fellBack.delete(u);
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
    // In unit test environment, keep MeloTTS behavior for voice: "bright" unless test specifically sets lk:agent-local-tts
    if (voice === "bright" && read(LOCAL_TTS_KEY) === "on")
      return { lang, provider: "local:neko", shift: 1 };
    if (pick?.kind === "melo") return { lang: pick.lang, shift: 1 };
    if (pick?.kind === "aura") return { lang: pick.lang, speaker: pick.speaker, shift: 1 };
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
  const preview = (url: string, volume: number, live: () => boolean, ev: PlayEvents): Playback => {
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
    a.onended = () => live() && ev.onend();
    a.onerror = () => live() && ev.onfail?.("preview error");
    a.onloadedmetadata = null;
    a.src = url;
    a.play().then(
      () => live() && ev.onstart?.(),
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
    prepare(text, lang, voice, pick, written) {
      if (pick?.kind === "eleven") return;
      const w = wanted(lang, voice, pick);
      if (w.provider) {
        const said = written ?? text;
        if (!providerSkip(said)) fetchClip(said, w.lang, undefined, w.provider).catch(ignore);
      } else if (!cloudSkip(text, w.lang)) fetchClip(text, w.lang, w.speaker).catch(ignore);
    },
    play(s, ev: PlayEvents): Playback {
      const me = ++turn;
      const live = () => me === turn;
      const fail = (why: string) => void Promise.resolve().then(() => live() && ev.onfail?.(why));
      if (s.pick?.kind === "eleven") return preview(s.pick.preview, s.volume, live, ev);
      const pb: Playback = {
        route: "audio",
        stop() {
          if (!live()) return {};
          turn++;
          const a = el;
          if (!a) return { at: s.at };
          a.pause();
          return { at: Math.max(0, a.currentTime - RESUME_REWIND_S) };
        },
        volume: (level, ms) => live() && ramp(level, ms),
      };
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
      if (lane.provider) {
        const said = s.written ?? s.text;
        clip = providerSkip(said)
          ? ownVoice()
          : fetchClip(said, lane.lang, undefined, lane.provider).catch(ownVoice);
      } else {
        const skip = cloudSkip(s.text, lane.lang);
        if (skip) {
          fail(skip);
          return pb;
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
              () => live() && ev.onstart?.(),
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

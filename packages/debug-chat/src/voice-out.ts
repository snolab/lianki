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
import type { CloudOut, PlayEvents, Playback } from "./voice";
import { VOICES, cloudVoice } from "./voices";

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
export const CLOUD_LANGS: ReadonlySet<string> = new Set(["en", "es", "fr", "zh", "ja", "ko"]);
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
  const fetchClip = (text: string, lang: string, speaker?: string): Promise<string> => {
    const key = `${lang}\n${speaker ?? ""}\n${text}`;
    const have = clips.get(key);
    if (have) return have;
    const p = d.fetch(ttsUrl(text, lang.split(/[-_]/)[0], speaker)).then(async (r) => {
      if (!r.ok) throw new Error(`http ${r.status}${r.headers.get("X-Voice") ? ` ${r.headers.get("X-Voice")}` : ""}`);
      const url = toUrl(await r.blob());
      // The speaker was asked for but the route answered with its one voice (it fell back).
      if (speaker && r.headers.get("X-Voice") !== AURA_VOICE) fellBack.add(url);
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
    },
    gain: () => gain,
    prepare(text, lang, voice) {
      const speaker = voice ? cloudVoice(voice, lang).speaker : undefined;
      if (!cloudSkip(text, lang)) fetchClip(text, lang, speaker).catch(ignore);
    },
    play(s, ev: PlayEvents): Playback {
      const me = ++turn;
      const live = () => me === turn;
      const fail = (why: string) => void Promise.resolve().then(() => live() && ev.onfail?.(why));
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
      const skip = cloudSkip(s.text, s.lang);
      if (skip) {
        fail(skip);
        return pb;
      }
      // A lane's cloud voice: its own speaker where the engine has several, else the one voice shifted.
      const lane = s.voice ? cloudVoice(s.voice, s.lang) : { shift: 1 };
      fetchClip(s.text, s.lang, lane.speaker).then(
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
            // A lane with no voice of its own here: shifted, its pitch moving with the speed.
            const shift = fellBack.has(url) && s.voice ? VOICES[s.voice].shift : lane.shift;
            const rate = (s.rate ?? 1) * shift;
            const keepPitch = shift === 1;
            a.defaultPlaybackRate = rate;
            a.playbackRate = rate;
            a.preservesPitch = keepPitch;
            a.webkitPreservesPitch = keepPitch;
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
    ctx: () => existingCtx() as unknown as CtxLike | null,
  });
  return browserCloud;
}

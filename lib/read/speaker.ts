// How /read says one line aloud (the player, lib/read/player.ts, decides
// which line and when). Browser pieces are injected, so it is tested with
// fakes in unit/read-speaker.test.ts — and never makes a sound there.
//
// - The engine follows the chat's voice-out setting (`lk:voice-out`,
//   packages/debug-chat/src/voice-out.ts): "speech" (default) uses a browser
//   voice of the book's own language (pickVoice: a French voice for French,
//   never the device default reading French in another accent); "cloud", or
//   no such voice on the device, fetches each sentence from /api/words/tts
//   (MeloTTS: en, es, fr, zh, ja, ko). One engine failing falls back to the
//   other once; when neither can, `onerror` says why — the player stops.
// - The line is spoken in sentences of at most 200 characters (the route's
//   limit, and Chrome cuts long utterances off after about 15 s).
// - A browser voice that never starts (no engine behind the API, as on some
//   Androids, or `onend` fired at once with nothing said) counts as a failure
//   after WATCHDOG_MS, rather than an instant "end" that would race ahead.
// - Each line holds the chat mic while it plays, echo cancellation or not
//   (page-audio.ts `always`), and its text goes to the echo guard, so the
//   book read aloud is never transcribed into the chat.

import { pickVoice } from "@lianki/debug-chat/wire";
import type { PageAudio } from "@lianki/debug-chat/page-audio";
import { speechChunks } from "./player";

export const CLOUD_LANGS: ReadonlySet<string> = new Set(["en", "es", "fr", "zh", "ja", "ko"]);
/** A browser utterance that has not started after this has failed. */
export const WATCHDOG_MS = 2500;

export type VoiceLike = { lang: string; name?: string; voiceURI?: string; default?: boolean };
export type UtterLike = {
  text: string;
  lang: string;
  voice: VoiceLike | null;
  rate: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
};
export type AudioLike = {
  src: string;
  paused: boolean;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
};
export type ReadSpeakerDeps = {
  mode(): "speech" | "cloud";
  synth(): { speak(u: UtterLike): void; cancel(): void; getVoices(): VoiceLike[] } | null;
  utterance(text: string): UtterLike;
  fetch(url: string): Promise<{ ok: boolean; status: number; blob(): Promise<Blob> }>;
  audio(): AudioLike;
  toUrl(b: Blob): string;
  revoke(u: string): void;
  pageAudio(): PageAudio;
  setTimer(f: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  log?(ev: Record<string, unknown>): void;
};
export type SpeakCallbacks = { onend(): void; onerror(why: string): void };

export const baseLang = (lang: string) => lang.toLowerCase().split(/[-_]/)[0];
export const readTtsUrl = (text: string, lang: string) =>
  `/api/words/tts?lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(text)}`;

/** A tiny silent WAV, played in a gesture so iOS lets the element play later. */
function silentWav(): string {
  const n = 80;
  const b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, "data");
  v.setUint32(40, n, true);
  b.fill(128, 44);
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

export function createReadSpeaker(d: ReadSpeakerDeps) {
  const log = d.log ?? (() => {});
  /** Bumped by every speak and cancel: callbacks of older ones are ignored. */
  let turn = 0;
  let stopCurrent: (() => void) | null = null;
  let el: AudioLike | null = null;
  const element = () => (el ??= d.audio());

  const voiceFor = (lang: string): VoiceLike | null => {
    try {
      const s = d.synth();
      return (s && pickVoice(s.getVoices(), lang)) || null;
    } catch {
      return null;
    }
  };

  return {
    /** In the Play tap (a gesture): lets later lines play on iOS. Silent. */
    unlock() {
      try {
        const a = element();
        if (a.paused) {
          a.src = silentWav();
          a.play().then(
            () => a.pause(),
            () => {},
          );
        }
      } catch {}
    },
    /** Which engine would speak `lang` now (null: none can). */
    engineFor(lang: string): "speech" | "cloud" | null {
      const cloudOk = CLOUD_LANGS.has(baseLang(lang));
      if (d.mode() === "cloud" && cloudOk) return "cloud";
      if (voiceFor(lang)) return "speech";
      return cloudOk ? "cloud" : null;
    },
    /** Say `text` in `lang`; exactly one of the callbacks, once, unless cancelled first. */
    speak(text: string, lang: string, cb: SpeakCallbacks): () => void {
      stopCurrent?.();
      const me = ++turn;
      const live = () => me === turn;
      const chunks = speechChunks(text);
      // The mic hold is renewed per sentence (each well under the registry's
      // 30 s cap), the next taken before the last is let go, so a long
      // paragraph never reopens the mic mid-line; the echo guard gets each.
      let release: (() => void) | null = null;
      const hold = (part?: string) => {
        const next = part ? d.pageAudio().start({ text: part, always: true }) : null;
        release?.();
        release = next;
      };
      /** Bumped when one engine gives up: its late callbacks are ignored. */
      let attempt = 0;
      let timer: unknown = null;
      let url: string | null = null;
      const cleanup = () => {
        if (timer !== null) d.clearTimer(timer);
        timer = null;
        if (url) d.revoke(url);
        url = null;
      };
      const finish = (ok: boolean, why = "") => {
        if (!live()) return;
        turn++;
        cleanup();
        hold();
        stopCurrent = null;
        if (ok) cb.onend();
        else cb.onerror(why);
      };
      const cancel = () => {
        if (!live()) return;
        turn++;
        cleanup();
        hold();
        stopCurrent = null;
        try {
          d.synth()?.cancel();
        } catch {}
        try {
          el?.pause();
        } catch {}
      };
      stopCurrent = cancel;
      if (!chunks.length) {
        // Nothing to say: end on the next tick, never synchronously inside a render.
        timer = d.setTimer(() => finish(true), 0);
        return cancel;
      }

      const voice = voiceFor(lang);
      const cloudOk = CLOUD_LANGS.has(baseLang(lang));
      const tried = new Set<string>();

      const viaSpeech = (from: number): void => {
        tried.add("speech");
        const mine = ++attempt;
        const cur = () => live() && mine === attempt;
        const s = d.synth();
        if (!s || !voice) return fail(from, "speech", `no browser voice for ${lang}`);
        const one = (i: number) => {
          if (!cur()) return;
          if (i >= chunks.length) return finish(true);
          hold(chunks[i]);
          try {
            speakOne(i);
          } catch (e) {
            fail(i, "speech", `browser voice: ${(e as Error)?.message ?? e}`);
          }
        };
        const speakOne = (i: number) => {
          const u = d.utterance(chunks[i]);
          u.voice = voice;
          u.lang = voice.lang;
          u.rate = 0.95;
          let started = false;
          u.onstart = () => {
            if (!cur()) return;
            started = true;
            if (timer !== null) d.clearTimer(timer);
            timer = null;
          };
          u.onend = () => {
            if (!cur()) return;
            if (!started) return fail(i, "speech", "the browser voice did not start");
            one(i + 1);
          };
          u.onerror = (e) => {
            if (!cur() || e?.error === "interrupted" || e?.error === "canceled") return;
            fail(i, "speech", `browser voice: ${e?.error ?? "error"}`);
          };
          if (timer !== null) d.clearTimer(timer);
          timer = d.setTimer(() => {
            timer = null;
            if (cur() && !started) {
              try {
                s.cancel();
              } catch {}
              fail(i, "speech", "the browser voice did not start");
            }
          }, WATCHDOG_MS);
          s.speak(u);
        };
        one(from);
      };

      const viaCloud = (from: number): void => {
        tried.add("cloud");
        const mine = ++attempt;
        const cur = () => live() && mine === attempt;
        if (!cloudOk) return fail(from, "cloud", `no server voice for ${lang}`);
        const a = element();
        const one = async (i: number) => {
          if (!cur()) return;
          if (i >= chunks.length) return finish(true);
          hold(chunks[i]);
          try {
            const r = await d.fetch(readTtsUrl(chunks[i], baseLang(lang)));
            if (!cur()) return;
            if (!r.ok) return fail(i, "cloud", `server voice: HTTP ${r.status}`);
            const blob = await r.blob();
            if (!cur()) return;
            if (url) d.revoke(url);
            url = d.toUrl(blob);
            a.onended = () => cur() && void one(i + 1);
            a.onerror = () => cur() && fail(i, "cloud", "server voice: the clip did not play");
            a.src = url;
            await a.play();
          } catch (e) {
            if (cur()) fail(i, "cloud", `server voice: ${(e as Error)?.message ?? e}`);
          }
        };
        void one(from);
      };

      const fail = (at: number, engine: "speech" | "cloud", why: string): void => {
        if (!live()) return;
        log({ ev: "read-tts-fail", engine, why, lang });
        // The engine that failed is done: its watchdog, sound and callbacks go.
        attempt++;
        if (timer !== null) d.clearTimer(timer);
        timer = null;
        try {
          if (engine === "speech") d.synth()?.cancel();
          else el?.pause();
        } catch {}
        if (engine === "speech" && !tried.has("cloud") && cloudOk) return viaCloud(at);
        if (engine === "cloud" && !tried.has("speech") && voice) return viaSpeech(at);
        finish(false, why);
      };

      if (d.mode() === "cloud" && cloudOk) viaCloud(0);
      else if (voice) viaSpeech(0);
      else if (cloudOk) viaCloud(0);
      else finish(false, `no voice for ${lang} on this device`);
      return cancel;
    },
    cancel() {
      stopCurrent?.();
    },
  };
}

export type ReadSpeaker = ReturnType<typeof createReadSpeaker>;

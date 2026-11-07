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
// - No wait between sentences (owner, 2026-11-05: "句子之间感觉有 1s 停顿"):
//   the cloud voice fetched each sentence only after the one before had
//   ended, so every sentence boundary waited a whole round trip (session
//   lookup, R2 or MeloTTS, download, decode). Now, as soon as a sentence
//   starts, the next PREFETCH_AHEAD are fetched and the next one is loaded
//   into the second of two unlocked <audio> elements, so `ended` starts it
//   on the spot. Clips are kept in memory for the session (CLIP_MEMORY,
//   newest kept), beside the server's R2 copy and the browser's cache. The
//   browser voice queues the next sentence when one starts, so the engine
//   chains them itself. No pause is added: the voice's own sentence end is
//   the pause. Cancel (pause, stop, a tap elsewhere) aborts what is still
//   being fetched for that line, and nothing of it plays.
// - The line is spoken in sentences of at most 200 characters (the route's
//   limit, and Chrome cuts long utterances off after about 15 s).
// - A browser voice that never starts (no engine behind the API, as on some
//   Androids, or `onend` fired at once with nothing said) counts as a failure
//   after WATCHDOG_MS, rather than an instant "end" that would race ahead.
// - While the chat mic is on, the clips play through the voice AudioContext
//   (`route`), as Li's own voice does (voice-out.ts): iOS's capture unit
//   ducks a bare <audio> element to near silence (owner, 2026-11-07: the
//   reader "plays" — currentTime runs — but nothing is heard).
// - Each line holds the chat mic while it plays, echo cancellation or not
//   (page-audio.ts `always`), and its text goes to the echo guard, so the
//   book read aloud is never transcribed into the chat.

import { pickVoice } from "@lianki/debug-chat/wire";
import type { PageAudio } from "@lianki/debug-chat/page-audio";
import { AUDIO_PRIO, type AudioOwner, type AudioOwnerOpts } from "@lianki/debug-chat/audio-claim";
import { speechChunks } from "./player";

export const CLOUD_LANGS: ReadonlySet<string> = new Set(["en", "es", "fr", "zh", "ja", "ko"]);
/** A browser utterance that has not started after this has failed. */
export const WATCHDOG_MS = 2500;
/** The mic hold of a sentence still playing is taken again this often (page-audio caps one at 30 s). */
export const HOLD_RENEW_MS = 20_000;
/** Sentences fetched ahead of the one playing (cloud voice). */
export const PREFETCH_AHEAD = 2;
/** Cloud clips kept in memory for the session, the most recently used. */
export const CLIP_MEMORY = 64;

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
  /** Starts loading `src` now (preload), so play() has it ready. */
  load?(): void;
};
export type ReadSpeakerDeps = {
  mode(): "speech" | "cloud";
  synth(): { speak(u: UtterLike): void; cancel(): void; getVoices(): VoiceLike[] } | null;
  utterance(text: string): UtterLike;
  fetch(
    url: string,
    init?: { signal?: AbortSignal },
  ): Promise<{ ok: boolean; status: number; blob(): Promise<Blob> }>;
  /**
   * A new element for `route` (from `route()`; null: a bare element). The
   * reader's clips play through the voice AudioContext while the chat mic
   * captures: on iOS the capture's voice-processing unit ducks any other
   * audio to near silence, so a bare element is inaudible then (owner,
   * 2026-11-07 21:07 JST: "朗读没声音" with the mic on).
   */
  audio(route?: unknown): AudioLike;
  /**
   * Where elements should play now: an opaque token (the running voice
   * context while the mic is on), or null for a bare element. Each route
   * keeps its own pair of elements (a routed element cannot be unrouted).
   */
  route?(): unknown;
  toUrl(b: Blob): string;
  revoke(u: string): void;
  pageAudio(): PageAudio;
  setTimer(f: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  log?(ev: Record<string, unknown>): void;
  /**
   * The page's audio owner (packages/debug-chat/src/audio-claim.ts): each
   * line claims the page before it plays, pauses while a higher one (Li, a
   * word read aloud) holds it, and goes on from the same sentence after.
   */
  owner?(o: Omit<AudioOwnerOpts, "id" | "target">): AudioOwner;
  /**
   * Called as a line starts: ms to wait before it, so the output device is
   * awake (packages/debug-chat output-bed.ts `begin`).
   */
  preroll?(): number;
};
export type SpeakCallbacks = {
  onend(): void;
  /**
   * Nothing was said. `noVoice`: neither engine has a voice for the
   * language here (no browser voice, and the server has none or answered
   * 404) — the card says "no voice for this language", not a failure.
   */
  onerror(why: string, noVoice?: boolean): void;
  /** A part (of `speak`'s array form) starts: its index. */
  onpart?(part: number): void;
  /** Its rank for the page's audio (AUDIO_PRIO; default: a paragraph). */
  prio?: number;
};

/**
 * Where the reader's clips play: through the chat's voice AudioContext while
 * the mic is on and that context runs (the one Li's voice plays through, so
 * iOS's capture unit does not duck it), else a bare element (null).
 */
export function readRoute<C extends { state: string }>(
  pa: Pick<PageAudio, "mic">,
  ctx: C | null,
): C | null {
  return pa.mic() && ctx && ctx.state === "running" ? ctx : null;
}

export const baseLang = (lang: string) => lang.toLowerCase().split(/[-_]/)[0];
export const readTtsUrl = (text: string, lang: string) =>
  `/api/words/tts?lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(text)}`;

/** A tiny silent WAV, played in a gesture so iOS lets the element play later. */
export function silentWav(): string {
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
  /** Two elements per route, taking turns: one plays while the next sentence loads in the other. */
  const pairs = new Map<unknown, [AudioLike, AudioLike]>();
  const routeNow = (): unknown => {
    try {
      return d.route?.() ?? null;
    } catch {
      return null;
    }
  };
  const pair = (r: unknown = routeNow()): [AudioLike, AudioLike] => {
    let p = pairs.get(r);
    if (!p) {
      p = [d.audio(r), d.audio(r)];
      pairs.set(r, p);
    }
    return p;
  };
  const pauseAll = () => {
    for (const p of pairs.values())
      for (const a of p) {
        try {
          a.pause();
        } catch {}
      }
  };
  type Clip = { p: Promise<Blob>; done: boolean };
  /** Cloud clips by "lang\ntext", oldest first (a Map keeps insertion order). */
  const clips = new Map<string, Clip>();
  /** The clip of `text`, from memory or fetched; `own` collects the keys this line started. */
  const clip = (text: string, lang: string, own: Set<string>, signal: AbortSignal) => {
    const k = `${lang}\n${text}`;
    const had = clips.get(k);
    if (had) {
      clips.delete(k);
      clips.set(k, had);
      return had.p;
    }
    const c: Clip = {
      p: (async () => {
        const r = await d.fetch(readTtsUrl(text, lang), { signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })(),
      done: false,
    };
    c.p.then(
      () => void (c.done = true),
      // A failure is never kept: the next try fetches again.
      () => void (clips.get(k) === c && clips.delete(k)),
    );
    clips.set(k, c);
    own.add(k);
    while (clips.size > CLIP_MEMORY) clips.delete(clips.keys().next().value as string);
    return c.p;
  };

  const voiceFor = (lang: string): VoiceLike | null => {
    try {
      const s = d.synth();
      return (s && pickVoice(s.getVoices(), lang)) || null;
    } catch {
      return null;
    }
  };

  /** Which engine would speak `lang` now (null: none can). */
  const engineFor = (lang: string): "speech" | "cloud" | null => {
    const cloudOk = CLOUD_LANGS.has(baseLang(lang));
    if (d.mode() === "cloud" && cloudOk) return "cloud";
    if (voiceFor(lang)) return "speech";
    return cloudOk ? "cloud" : null;
  };
  /** Prefetches of a line not started yet belong to no line: never aborted (a clip or two). */
  const spare = new AbortController();

  return {
    /** In the Play tap (a gesture): lets later lines play on iOS. Silent. */
    unlock() {
      for (const a of pair()) {
        try {
          if (a.paused) {
            const wav = silentWav();
            a.src = wav;
            a.play().then(
              // A sentence loaded into it meanwhile is not paused.
              () => a.src === wav && a.pause(),
              () => {},
            );
          }
        } catch {}
      }
    },
    engineFor,
    /**
     * The line read next (the next paragraph, in auto mode): its first
     * sentences are fetched now, while this one plays, so the paragraph
     * boundary does not wait on the network either. Cloud voice only; kept
     * in the session's memory, where speak() finds them.
     */
    prefetch(text: string | readonly string[], lang: string) {
      if (engineFor(lang) !== "cloud") return;
      const first = (typeof text === "string" ? [text] : text)
        .flatMap((p) => speechChunks(p))
        .slice(0, PREFETCH_AHEAD);
      for (const c of first) clip(c, baseLang(lang), new Set(), spare.signal).catch(() => {});
    },
    /**
     * Say `text` in `lang`; exactly one of onend / onerror, once, unless
     * cancelled first. An array is said part after part (the reader v2's
     * sentences), and `onpart` hears each part start, for its highlight.
     */
    speak(text: string | readonly string[], lang: string, cb: SpeakCallbacks): () => void {
      stopCurrent?.();
      const me = ++turn;
      const live = () => me === turn;
      const parts = typeof text === "string" ? [text] : text;
      const chunks: string[] = [];
      /** The part each chunk belongs to. */
      const partOf: number[] = [];
      parts.forEach((p, i) =>
        speechChunks(p).forEach((c) => {
          chunks.push(c);
          partOf.push(i);
        }),
      );
      let partShown = -1;
      /** The sentence due now: where a pause (a higher sound) goes on from. */
      let at = 0;
      const startChunk = (i: number) => {
        at = i;
        if (partOf[i] === partShown) return;
        partShown = partOf[i];
        cb.onpart?.(partShown);
      };
      // The mic hold is taken per sentence, the next before the last is let
      // go, and renewed every HOLD_RENEW_MS while one sentence lasts (a slow
      // fetch, a long CJK sentence), so the registry's 30 s cap never reopens
      // the mic mid-line. The echo guard gets each sentence.
      let release: (() => void) | null = null;
      let renew: unknown = null;
      const hold = (part?: string) => {
        const next = part ? d.pageAudio().start({ text: part, always: true }) : null;
        release?.();
        release = next;
        if (renew !== null) d.clearTimer(renew);
        renew = part ? d.setTimer(() => live() && hold(part), HOLD_RENEW_MS) : null;
      };
      /** Bumped when one engine gives up: its late callbacks are ignored. */
      let attempt = 0;
      let timer: unknown = null;
      /** This line's object URLs, revoked when it ends. */
      const urls = new Set<string>();
      /** Cloud fetches of this line: aborted, and dropped from memory unfinished, on cancel. */
      const ctrl = new AbortController();
      const own = new Set<string>();
      const cleanup = () => {
        if (timer !== null) d.clearTimer(timer);
        timer = null;
        for (const u of urls) d.revoke(u);
        urls.clear();
      };
      const dropFetches = () => {
        for (const k of own) if (clips.get(k)?.done === false) clips.delete(k);
        own.clear();
        try {
          ctrl.abort();
        } catch {}
      };
      /** Paused for a higher sound; it resumes at `at`. */
      let parked = false;
      let owner: AudioOwner | null = null;
      const finish = (ok: boolean, why = "", noVoice = false) => {
        if (!live()) return;
        turn++;
        cleanup();
        dropFetches();
        owner?.dispose();
        hold();
        stopCurrent = null;
        if (ok) cb.onend();
        else cb.onerror(why, noVoice);
      };
      const cancel = () => {
        if (!live()) return;
        turn++;
        cleanup();
        dropFetches();
        hold();
        stopCurrent = null;
        // Paused for a higher sound: ours is silent already, and a cancel would cut Li's voice.
        if (!parked) {
          try {
            d.synth()?.cancel();
          } catch {}
          pauseAll();
        }
        // Last: a waiter resuming on this release must not be silenced by the lines above.
        owner?.dispose();
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
      /** The server answered 404 for this line: it has no voice for the language (or this text). */
      let cloud404 = false;

      const viaSpeech = (from: number): void => {
        tried.add("speech");
        const mine = ++attempt;
        const cur = () => live() && mine === attempt;
        const s = d.synth();
        if (!s || !voice) return fail(from, "speech", `no browser voice for ${lang}`);
        /** Utterances handed to the engine: the next is queued when one starts. */
        const said = new Map<number, { started: boolean }>();
        const one = (i: number) => {
          if (!cur()) return;
          if (i >= chunks.length) return finish(true);
          hold(chunks[i]);
          startChunk(i);
          try {
            if (!said.has(i)) speakOne(i);
          } catch (e) {
            return fail(i, "speech", `browser voice: ${(e as Error)?.message ?? e}`);
          }
          // Queued or not, it must start within WATCHDOG_MS of being due.
          if (said.get(i)?.started) return;
          if (timer !== null) d.clearTimer(timer);
          timer = d.setTimer(() => {
            timer = null;
            if (cur() && !said.get(i)?.started) {
              try {
                s.cancel();
              } catch {}
              fail(i, "speech", "the browser voice did not start");
            }
          }, WATCHDOG_MS);
        };
        const speakOne = (i: number) => {
          const u = d.utterance(chunks[i]);
          u.voice = voice;
          u.lang = voice.lang;
          u.rate = 0.95;
          const st = { started: false };
          u.onstart = () => {
            if (!cur()) return;
            st.started = true;
            if (timer !== null) d.clearTimer(timer);
            timer = null;
            // The next sentence waits in the engine's own queue, not on us.
            if (i + 1 < chunks.length && !said.has(i + 1)) {
              try {
                speakOne(i + 1);
              } catch {
                // one(i + 1) tries again when it is due, and says why.
              }
            }
          };
          u.onend = () => {
            if (!cur()) return;
            if (!st.started) return fail(i, "speech", "the browser voice did not start");
            one(i + 1);
          };
          u.onerror = (e) => {
            if (!cur() || e?.error === "interrupted" || e?.error === "canceled") return;
            fail(i, "speech", `browser voice: ${e?.error ?? "error"}`);
          };
          said.set(i, st);
          try {
            s.speak(u);
          } catch (e) {
            said.delete(i);
            throw e;
          }
        };
        one(from);
      };

      const viaCloud = (from: number): void => {
        tried.add("cloud");
        const mine = ++attempt;
        const cur = () => live() && mine === attempt;
        if (!cloudOk) return fail(from, "cloud", `no server voice for ${lang}`);
        const L = baseLang(lang);
        // The route as this attempt starts (the mic on or off): a resume picks again.
        const [a0, a1] = pair();
        /** Chunk i plays in one element while i + 1 loads in the other. */
        const slot = (i: number) => ((i - from) % 2 === 0 ? a0 : a1);
        type Staged = { el: AudioLike; url: string };
        const staging = new Map<number, Promise<Staged>>();
        const ready = new Map<number, Staged>();
        const errText = (e: unknown) => (e as Error)?.message ?? String(e);
        /** Chunk i's clip, loaded into its element (not playing yet). */
        const stage = (i: number): Promise<Staged> => {
          let p = staging.get(i);
          if (!p) {
            p = clip(chunks[i], L, own, ctrl.signal).then((blob) => {
              if (!cur()) throw new Error("cancelled");
              const el = slot(i);
              // Its last sentence's handlers must not fire for this one.
              el.onended = null;
              el.onerror = null;
              const url = d.toUrl(blob);
              urls.add(url);
              el.src = url;
              try {
                el.load?.();
              } catch {}
              const st = { el, url };
              ready.set(i, st);
              return st;
            });
            p.catch(() => {});
            staging.set(i, p);
          }
          return p;
        };
        const start = (i: number, st: Staged) => {
          const a = st.el;
          a.onended = () => {
            if (!cur()) return;
            urls.delete(st.url);
            d.revoke(st.url);
            one(i + 1);
          };
          a.onerror = () => cur() && fail(i, "cloud", "server voice: the clip did not play");
          a.play().catch((e) => cur() && fail(i, "cloud", `server voice: ${errText(e)}`));
          // The other element is free now (i - 1 has ended): the next loads there.
          if (i + 1 < chunks.length) stage(i + 1);
        };
        const one = (i: number) => {
          if (!cur()) return;
          if (i >= chunks.length) return finish(true);
          hold(chunks[i]);
          startChunk(i);
          const st = ready.get(i);
          // Loaded while the last one played: it starts within this `ended`.
          if (st) start(i, st);
          else
            stage(i).then(
              (n) => cur() && start(i, n),
              (e) => cur() && fail(i, "cloud", `server voice: ${errText(e)}`),
            );
          // Then the ones after it, so each is here before its turn.
          for (let k = 1; k <= PREFETCH_AHEAD && i + k < chunks.length; k++)
            clip(chunks[i + k], L, own, ctrl.signal).catch(() => {});
        };
        one(from);
      };

      const fail = (at: number, engine: "speech" | "cloud", why: string): void => {
        if (!live()) return;
        log({ ev: "read-tts-fail", engine, why, lang });
        if (engine === "cloud" && /HTTP 404/.test(why)) cloud404 = true;
        // The engine that failed is done: its watchdog, sound and callbacks go.
        attempt++;
        if (timer !== null) d.clearTimer(timer);
        timer = null;
        try {
          if (engine === "speech") d.synth()?.cancel();
          else pauseAll();
        } catch {}
        if (engine === "speech" && !tried.has("cloud") && cloudOk) return viaCloud(at);
        if (engine === "cloud" && !tried.has("speech") && voice) return viaSpeech(at);
        finish(false, why, !voice && (!cloudOk || cloud404));
      };

      const begin = (from: number) => {
        if (d.mode() === "cloud" && cloudOk) viaCloud(from);
        else if (voice) viaSpeech(from);
        else if (cloudOk) viaCloud(from);
        else finish(false, `no voice for ${lang} on this device`, true);
      };
      owner =
        d.owner?.({
          prio: cb.prio ?? AUDIO_PRIO.para,
          // A higher sound: silence this line now, keep its sentence and its callbacks.
          onYield: () => {
            if (!live() || parked) return;
            parked = true;
            attempt++;
            cleanup();
            hold();
            try {
              d.synth()?.cancel();
            } catch {}
            pauseAll();
            log({ ev: "read-yield", at });
          },
          onResume: () => {
            if (!live() || !parked) return;
            parked = false;
            tried.clear();
            log({ ev: "read-resume", at });
            begin(at);
          },
        }) ?? null;
      if (owner && !owner.claim()) parked = true;
      else {
        const wait = d.preroll?.() ?? 0;
        if (wait > 0) {
          // In the tap: the browser voice's first line would come after it (iOS).
          try {
            d.synth()?.speak(d.utterance(""));
          } catch {}
          // `timer`: a cancel or a yield clears it; a resume starts the line itself.
          timer = d.setTimer(() => {
            timer = null;
            if (live() && !parked) begin(0);
          }, wait);
        } else begin(0);
      }
      return cancel;
    },
    cancel() {
      stopCurrent?.();
    },
  };
}

export type ReadSpeaker = ReturnType<typeof createReadSpeaker>;

"use client";

import { chatExtra } from "./chat-ui-locales";
import { type Adaptive, LIMIT, voiceAdapt } from "./adaptive";
import { VOICE_CAPTURE_EVENT, voiceTune } from "./voice-tune";
import { useEffect, useRef, useState } from "react";
import {
  type MicState,
  type Vad,
  type VadEvents,
  type MicAdapt,
  RATE,
  energyGate,
  micErrorNote,
  micStatus,
  postClip,
  sideClip,
  encodeWav,
  postStt,
  reportLocalStt,
  resample,
} from "./mic";
import {
  CUE_SEND_KEY,
  CUE_SPEECH_KEY,
  type CueContext,
  type Cues,
  cueAllowed,
  cueOn,
  createCues,
} from "./cues";
import { silenceHere } from "./speak-rules";
import { voiceLatency, noteSttVia } from "./latency";
import { type SttTag, sttTagOf } from "./wire";
import { postSessionClip } from "./clips-store";
import { createRecorder, pageRecorder } from "./recorder";
import { createLocalStt } from "./local-stt";
import {
  PUBLIC_CONNECT_TIMEOUT_MS,
  isMixedRoutes,
  isPublicRoutes,
  mixedOpen,
  publicOpen,
} from "./public-stt";
import type { SttSignals } from "./stt-guard";
import { VOICE_DEVICE_KEY, deviceSlug, filterSwitch, filterVerdict, noteFiltered, noteSpeaker, subscribeFiltered } from "./voiceprint";
import { localSttStrings, wakeStrings } from "./ui-strings";
import { createKws } from "./wake-kws";
import { MIC_BOX, MIC_RING, NO_SELECT } from "./bar-geometry";
import { type LifeEvent, MIC_BLOCKED_NOTE, type MicSession, type MicView, micSession } from "./mic-session";
import { autoOffNote, micLook } from "./mic-off";
import { sttHint } from "./stt-hint";
import {
  PTT_PREROLL_MS,
  PTT_TAIL_MS,
  chunkSamples,
  createRing,
  joinClip,
  joinTexts,
  type PttState,
  onPttHolding,
  pcmTap,
  pttHolding,
  setPttHolding,
} from "./ptt";
import { speechEnabled, voice } from "./voice";
import { captureHeld, pageAudio } from "./page-audio";
import { ECHO_WINDOW_MS, echoScore } from "./echo";
import { micAec, onOpened } from "./aec";
import {
  aecOn,
  appliedSettings,
  audioCtx,
  cloudOut,
  existingCtx,
  micConstraints,
  noSpeechVoices,
  noteTrack,
  outMode,
} from "./voice-out";

/**
 * Silero VAD (@ricky0123/vad-web) and its ONNX runtime, from jsDelivr at pinned
 * versions, loaded only when the mic is first turned on, so neither is in any
 * bundle. The runtime's wasm is ~11 MB, too big to self-host for one debug
 * button; the app sets no CSP.
 */
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
const VAD = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/";
const REC = "oklch(0.6 0.22 25)";
/**
 * The capturing ring's pulse: its opacity and a slight scale, both on the GPU,
 * about the ring's own centre, so it stays concentric and nothing moves. Under
 * reduced motion it holds still, a little thicker than the listening ring.
 * In a <style> beside the button, not a Tailwind class: a stale stylesheet
 * (docs/dev-debug-widget.md, "concentric") cannot drop it.
 */
const MIC_PULSE = `@keyframes lk-mic-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.12)}}
@media (prefers-reduced-motion:reduce){[data-testid="debug-chat-mic-ring"][data-rec]{animation:none!important;box-shadow:0 0 0 3px ${REC}!important}}`;
/** The agent speaking (capture held): gold, unlike the red of capture. */
const TALK = "oklch(0.75 0.14 80)";
/** Push to talk held: seal red, darker than REC so white text on it is AA. */
const PTT_RING = "oklch(0.5 0.2 27)";
/** Passive (docs/wake-word.md): on, but only waiting for "Linky": a quiet warm grey. */
const WAIT = "oklch(0.62 0.03 70)";
/** The local-STT dot: the Mac's model, connecting, or the cloud fallback. */
const LOCAL_DOT = {
  ready: "oklch(0.7 0.16 150)",
  connecting: "oklch(0.78 0.14 80)",
  down: "oklch(0.65 0 0)",
} as const;

/** Suspend the context when nothing needs it: the mic off, nothing being read, no cue playing. */
const suspendIdle = () => {
  const st = voice().state();
  // Not while the page plays: the reader's clips play through it while the mic is on (lib/read/speaker.ts).
  if (!st.mic && !st.speaking && pageCues().quiet() && !pageAudio().playing())
    void existingCtx()?.suspend().catch(() => {});
};

/**
 * The page's voice cues (cues.ts), one for every copy of this module: the
 * guard must be the one the page's mic session asks. Made on first use, on the
 * mic's AudioContext (made here when a reload's auto-resume or a voice mode
 * opened the mic without a tap; it then waits for the page's next tap).
 */
const CUES_KEY = "__lkCues";
export function pageCues(): Cues {
  const g = globalThis as unknown as Record<string, Cues | undefined>;
  return (g[CUES_KEY] ??= createCues({
    ctx: () => audioCtx() as unknown as CueContext | null,
    allowed: (kind) => {
      const st = voice().state();
      return cueAllowed(kind, {
        on: cueOn(kind === "send" || kind === "amend" ? CUE_SEND_KEY : CUE_SPEECH_KEY),
        muted: !speechEnabled(),
        silenced: silenceHere() !== null,
        speaking: st.speaking,
        aec: micAec(),
      });
    },
    idle: suspendIdle,
  }));
}

type MicVAD = {
  start(): Promise<void>;
  pause(): Promise<void>;
  destroy(): Promise<void>;
};
type VadGlobal = { MicVAD: { new: (o: Record<string, unknown>) => Promise<MicVAD> } };

const script = (src: string) =>
  new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error(`could not load ${src}`));
    };
    document.head.append(s);
  });

/**
 * The mic, with echo cancellation, noise suppression and auto gain all on or
 * all off (lk:voice-aec; aec.ts). vad-web is handed this stream (getStream),
 * so these are the constraints it runs with. The mode it was opened with and
 * what the browser applied are kept, for the hold, the clips' metadata and
 * the per-utterance debug log. The mic session (mic-session.ts) owns it:
 * the VADs below listen on it and never stop it.
 */
/** The always-on session's open stream (push to talk records from it, and its pre-roll). */
let liveStream: MediaStream | null = null;
const micStream = async () => {
  const aec = aecOn();
  const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(aec) });
  noteTrack(s, aec);
  liveStream = s;
  return s;
};
const liveTrack = () =>
  liveStream?.getAudioTracks().some((t) => t.readyState === "live") ? liveStream : null;

/**
 * The pre-roll (ptt.ts): while the always-on mic is open, its last
 * PTT_PREROLL_MS in a ring, in memory only. Started and stopped with the
 * session's state; a hold takes it, never stored or sent otherwise.
 */
let preroll: { ring: ReturnType<typeof createRing>; stop: () => void } | null = null;
const prerollOn = (on: boolean) => {
  if (!on) {
    preroll?.stop();
    preroll?.ring.clear();
    preroll = null;
    return;
  }
  const ctx = audioCtx();
  const s = liveTrack();
  if (preroll || !ctx || !s) return;
  const ring = createRing((ctx.sampleRate * PTT_PREROLL_MS) / 1000);
  try {
    preroll = { ring, stop: pcmTap(ctx, s, (c) => ring.push(c)) };
  } catch {
    preroll = null;
  }
};

/**
 * Push to talk's recorder (ptt.ts): `start` at the pointerdown (the
 * session's open stream, else one of its own), `finish` keeps PTT_TAIL_MS
 * more, then sends the pre-roll and the hold through the STT route (in
 * pieces only past its size limit) and resolves to one line's text;
 * `abort` drops everything. While it records, the always-on capture holds
 * (setPttHolding), so the VAD makes no line of its own from it.
 */
export function pttRecorder() {
  let rec: {
    ctx: AudioContext;
    pre: Float32Array;
    chunks: Float32Array[];
    stop: () => void;
    own: MediaStream | null;
  } | null = null;
  let starting: Promise<void> | null = null;
  const end = () => {
    rec?.stop();
    rec?.own?.getTracks().forEach((t) => t.stop());
    rec = null;
    setPttHolding(false);
  };
  return {
    start() {
      setPttHolding(true);
      starting = (async () => {
        const ctx = audioCtx();
        if (!ctx) throw new Error("no audio context");
        if (ctx.state !== "running") await ctx.resume().catch(() => {});
        const live = liveTrack();
        // Mic off: a stream of its own, closed with the clip (never the session's).
        const own = live
          ? null
          : await navigator.mediaDevices.getUserMedia({ audio: micConstraints(aecOn()) });
        const chunks: Float32Array[] = [];
        const pre = preroll?.ring.take() ?? new Float32Array(0);
        rec = { ctx, pre, chunks, own, stop: pcmTap(ctx, (live ?? own)!, (c) => chunks.push(c)) };
      })();
      starting.catch(() => setPttHolding(false));
    },
    abort() {
      void starting?.finally(end).catch(end);
    },
    async finish(): Promise<{ text: string; audioMs: number; stt?: SttTag }> {
      await starting;
      await new Promise((r) => setTimeout(r, PTT_TAIL_MS));
      const r = rec;
      end();
      if (!r) return { text: "", audioMs: 0 };
      const held = new Float32Array(r.chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of r.chunks) {
        held.set(c, at);
        at += c.length;
      }
      const clip = resample(joinClip(r.pre, held), r.ctx.sampleRate, RATE);
      const texts: string[] = [];
      let model: string | undefined;
      for (const piece of chunkSamples(clip)) {
        const out = await postStt(encodeWav(piece), fetch, "audio/wav", sttHint());
        texts.push(out.text);
        model ??= out.model;
      }
      // Always the cloud route: its model is the line's engine (SttTag).
      const stt = sttTagOf("cloud", model);
      return { text: joinTexts(texts), audioMs: Math.round((clip.length / RATE) * 1000), stt };
    },
  };
}

/**
 * Whisper mode's input gain (adaptive.ts): the mic → a gain → a tanh soft
 * limiter at 0.9 FS → a stream for the VAD, in a context of its own (the
 * shared one is suspended while the mic is off and nothing speaks). The
 * gain is set per frame by the estimator (0 dB in normal mode). The shaper
 * maps [-1, 1] to ±HEADROOM of real signal, so a +30 dB gain is limited,
 * not clipped. Where the context cannot run (no gesture on iOS after a
 * reload), the mic's own stream is used, unprocessed.
 */
const HEADROOM = 32;
async function agcChain(raw: MediaStream) {
  const AC =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  await ctx.resume().catch(() => {});
  if (ctx.state !== "running") {
    void ctx.close().catch(() => {});
    return null;
  }
  const src = ctx.createMediaStreamSource(raw);
  const gain = ctx.createGain();
  const lin = (db: number) => 10 ** (db / 20) / HEADROOM;
  gain.gain.value = lin(voiceAdapt().state().gainDb);
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(2049);
  for (let i = 0; i < curve.length; i++) {
    const x = ((i / (curve.length - 1)) * 2 - 1) * HEADROOM;
    curve[i] = LIMIT * Math.tanh(x / LIMIT);
  }
  shaper.curve = curve;
  const dest = ctx.createMediaStreamDestination();
  src.connect(gain).connect(shaper).connect(dest);
  let last = Number.NaN;
  return {
    stream: dest.stream,
    setGain: (db: number) => {
      if (db === last) return;
      last = db;
      gain.gain.setTargetAtTime(lin(db), ctx.currentTime, 0.01);
    },
    close: () => {
      src.disconnect();
      void ctx.close().catch(() => {});
    },
  };
}
/** The running chain, for the estimator's per-frame gain. */
let agcNow: { setGain(db: number): void } | null = null;

/** The estimator as the mic sees it: each frame sets the chain's gain. */
const micAdapt = (a: Adaptive): MicAdapt => ({
  frame: (f, p, capturing) => void agcNow?.setGain(a.frame(f, p, capturing)),
  end: () => {},
  state: () => a.state(),
});

/**
 * Silero, on the session's stream. It ends an utterance after vad-web's
 * default `redemptionMs` of silence: 1400 ms in 0.0.30 (43 frames of 32 ms),
 * the largest fixed wait on the voice → reply path (latency.ts `vadMs`).
 */
async function silero(ev: VadEvents, stream: MediaStream): Promise<Vad> {
  await script(`${ORT}ort.wasm.min.js`);
  await script(`${VAD}bundle.min.js`);
  const g = (globalThis as unknown as { vad?: VadGlobal }).vad;
  if (!g) throw new Error("vad-web did not load");
  const t = voiceTune();
  const adapt = voiceAdapt();
  const agc = await agcChain(stream).catch(() => null);
  agcNow = agc;
  const input = agc?.stream ?? stream;
  // The page's overrides (__lkVoiceTune) win over the adaptive values.
  const over = (globalThis as { __lkVoiceTune?: Record<string, unknown> }).__lkVoiceTune ?? {};
  const pick = () =>
    Object.fromEntries(Object.entries(adapt.vad()).filter(([k]) => !(k in over)));
  const v = await g.MicVAD.new({
    // From the VAD A/B (voice-tune.ts), then the adaptive values (adaptive.ts).
    positiveSpeechThreshold: t.positiveSpeechThreshold,
    negativeSpeechThreshold: t.negativeSpeechThreshold,
    minSpeechMs: t.minSpeechMs,
    ...pick(),
    preSpeechPadMs: t.preSpeechPadMs,
    redemptionMs: t.redemptionMs,
    baseAssetPath: VAD,
    onnxWASMBasePath: ORT,
    model: "v5",
    submitUserSpeechOnPause: true,
    startOnLoad: false,
    getStream: async () => input,
    pauseStream: async () => {},
    resumeStream: async () => input,
    onSpeechStart: ev.onSpeechStart,
    onSpeechEnd: ev.onSpeechEnd,
    onVADMisfire: ev.onMisfire,
    onFrameProcessed: (p: { isSpeech?: number } | undefined, frame: Float32Array) =>
      ev.onFrame?.(frame, p?.isSpeech),
  });
  // Normal ↔ whisper (between utterances): Silero takes the new start settings live.
  const off = adapt.subscribe(() =>
    (v as MicVAD & { setOptions?: (o: Record<string, unknown>) => void }).setOptions?.(pick()),
  );
  return {
    start: () => v.start(),
    pause: () => v.pause(),
    flush: async () => {
      await v.pause();
      await v.start();
    },
    destroy: async () => {
      off();
      await v.destroy();
      if (agcNow === agc) agcNow = null;
      agc?.close();
    },
  };
}

/** The fallback: an energy threshold on the raw signal (mic.ts energyGate), on the session's stream. */
async function energy(ev: VadEvents, stream: MediaStream): Promise<Vad> {
  const ctx = audioCtx();
  if (!ctx) throw new Error("no Web Audio");
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but everywhere, and needs no worklet file.
  const node = ctx.createScriptProcessor(2048, 1, 1);
  const gate = energyGate({ rate: ctx.sampleRate });
  let on = false;
  const emit = (r: ReturnType<typeof gate.push>) => {
    if (r === "start") ev.onSpeechStart();
    else if (r === "misfire") ev.onMisfire();
    else if (r) ev.onSpeechEnd(resample(r, ctx.sampleRate, RATE));
  };
  node.onaudioprocess = (e) => {
    if (!on) return;
    const frame = new Float32Array(e.inputBuffer.getChannelData(0));
    const r = gate.push(frame);
    if (r === "start") emit(r);
    ev.onFrame?.(resample(frame, ctx.sampleRate, RATE));
    if (r !== "start") emit(r);
  };
  src.connect(node);
  node.connect(ctx.destination);
  return {
    start: () => {
      on = true;
      return ctx.resume();
    },
    pause: () => {
      on = false;
      emit(gate.flush()); // held: the mic drops it
    },
    flush: () => emit(gate.flush()),
    destroy: () => {
      on = false;
      node.disconnect();
      src.disconnect();
    },
  };
}

/**
 * The browser's half of a mic, for another listener than the chat (/vibe,
 * docs/vibe.md): the same stream and VADs, with no chat, cue, estimator, clip
 * sink or cloud attached. The caller owns the stream and stops it.
 */
export const voiceCapture = () => ({
  getStream: micStream as () => Promise<MediaStream>,
  load: (ev: VadEvents, s: MediaStream) => silero(ev, s),
  fallback: (ev: VadEvents, s: MediaStream) => energy(ev, s),
});

/** How long the mic says a line was stopped by the voiceprint filter. */
const FILTERED_NOTE_MS = 3_000;

/** This device's slug for the voiceprint (voiceprint.ts; localStorage lk:agent-voice-device overrides it). */
export const voiceDevice = () => {
  let o: string | null = null;
  try {
    o = localStorage.getItem(VOICE_DEVICE_KEY);
  } catch {}
  return deviceSlug(typeof navigator === "undefined" ? "" : navigator.userAgent, o);
};

/** The wake word is off on this device (localStorage lk:agent-wake = "0"; docs/wake-word.md). */
const wakeOff = () => {
  try {
    return localStorage.getItem("lk:agent-wake") === "0";
  } catch {
    return false;
  }
};

/** The page's recorder (recorder.ts): one per page, shared by every mic session. */
const recorder = (v: { log(ev: Record<string, unknown>): void }) =>
  pageRecorder(() => createRecorder({ fetch: globalThis.fetch.bind(globalThis), log: (ev) => v.log(ev) }));

/** The page's mic session, built with this module's browser pieces (mic-session.ts). */
function session(): MicSession {
  const v = voice();
  return micSession({
    cue: {
      guard: () => pageCues().guard(),
      edge: (edge) => void (edge === "start" ? pageCues().speechStart() : pageCues().speechEnd()),
    },
    getStream: micStream,
    // Learns nothing while the agent's voice is out (adaptive.ts).
    adapt: micAdapt(voiceAdapt(() => v.state().speaking)),
    load: (ev, s) => silero(ev, s as MediaStream),
    fallback: (ev, s) => energy(ev, s as MediaStream),
    onState: (s, last) => {
      const active = s !== "off";
      // Push to talk's pre-roll runs while the mic is open (ptt.ts), memory only.
      prerollOn(active);
      v.setMic(active);
      pageAudio().setMic(active);
      // The user starts talking: over the agent it ducks (a barge-in if they
      // keep going), else the reading pauses; it reads on once they are done.
      if (s === "capturing") {
        pageCues().capture(true);
        v.userSpeech();
        // A line held for joining waits for this speech (voice-tune.ts createJoiner).
        window.dispatchEvent(new Event(VOICE_CAPTURE_EVENT));
      }
      else if (last === "capturing") {
        pageCues().capture(false);
        v.userIdle();
      }
      if (!active) suspendIdle();
    },
    onProb: (p) => v.userFrame(p),
    // Only with lk:voice-aec off: else the mic stays open and the user can barge in.
    // Held while the chat reads (voice.ts) or the page plays word audio (page-audio.ts).
    subscribeHold: (f) => {
      const page = pageAudio();
      // Push to talk recording holds it too: the hold is one line, not the VAD's.
      const calc = () =>
        f(captureHeld(v.state().hold, page.playing(), micAec(), page.always()) || pttHolding());
      calc();
      const a = v.subscribe(calc);
      const b = page.subscribe(calc);
      const c = onOpened(calc);
      const d = onPttHolding(calc);
      return () => {
        a();
        b();
        c();
        d();
      };
    },
    // The device goes along, so the Mac scores finals against this device's voiceprint.
    // Lianki's speech servers for another account (public-stt.ts): no device, no thread,
    // no filter (none of the owner's voiceprint applies), WebRTC then the WSS tunnel.
    // His own list may mix rtc:lianki (his phone to his own Mac over WebRTC) with the
    // tailnet: each route its own transport, and everything of his goes along.
    localStt: (url) =>
      isMixedRoutes(url)
        ? createLocalStt(url, {
            log: (ev) => v.log(ev),
            open: mixedOpen({ log: (ev) => v.log(ev) }),
            connectTimeoutMs: PUBLIC_CONNECT_TIMEOUT_MS,
            device: voiceDevice(),
            thread: "owner",
            filter: filterSwitch(),
          })
        : isPublicRoutes(url)
        ? createLocalStt(url, {
            log: (ev) => v.log(ev),
            open: publicOpen({ log: (ev) => v.log(ev) }),
            connectTimeoutMs: PUBLIC_CONNECT_TIMEOUT_MS,
          })
        : createLocalStt(url, { log: (ev) => v.log(ev), device: voiceDevice(), thread: "owner", filter: filterSwitch() }),
    speaker: noteSpeaker,
    filtered: (r) => void v.log({ ev: "voice-filtered", mode: "passive", n: noteFiltered("filtered", r).n, ...r }),
    // The account's recordings (recorder.ts, docs/recordings.md): every finished utterance
    // while the mic is on, queued and sent in the background when the account has them on.
    // A passive one goes for its text only to his own local STT, never a public speech
    // server, and only once the account is known to have recordings on.
    record: {
      keep: (r) => recorder(v).add({ ...r, device: voiceDevice() }),
      local: (cfg) =>
        !!cfg.localStt &&
        (isMixedRoutes(cfg.localStt) || !isPublicRoutes(cfg.localStt)) &&
        recorder(v).enabled(),
    },
    // The "Linky" spotter: made (and downloaded) the first time the mic goes passive.
    // localStorage lk:agent-wake = "0" turns the wake word off (never passive).
    kws: wakeOff() ? undefined : (onState) => createKws({ log: (ev) => v.log(ev), onState }),
    upload: async (wav, { seq, durationMs, partial, local, onEcho, onSignals }, cfg) => {
      const at = Date.now();
      const sink = partial ? undefined : cfg.clipSink;
      // The mode and track this utterance was recorded on: a reopen while it is transcribed changes both.
      const aecAt = v.aec();
      const trackAt = appliedSettings();
      try {
        // `ms`: the server's own time, the route's or the Mac's decode (sttServerMs in the timing).
        let out: { text: string; model?: string; ms?: number; signals?: SttSignals };
        let via: "local" | "cloud" = "cloud";
        // The local server was asked and failed: the cloud's answer is a fallback (SttTag).
        let fellBack = false;
        if (local) {
          // Streamed to the owner's Mac (local-stt.ts); on any failure, the route as before.
          try {
            const f = await local;
            // Served by the speech server: booked as a cloud call (cost ledger), filtered or not.
            // Not for Lianki's speech servers' public routes: the registry books those itself.
            if (!partial && !isPublicRoutes(cfg.localStt ?? "")) reportLocalStt(durationMs, fetch);
            // The filter stopped it on the Mac: not text, not the cloud, not the clip sink.
            if (filterVerdict(f, durationMs, (ev) => v.log(ev))) return "";
            out = f;
            via = "local";
            v.log({
              ev: "local-stt-final",
              model: f.model,
              durationMs,
              decodeMs: f.ms,
              endToFinalMs: f.endToFinalMs,
              firstPartialMs: f.firstPartialMs,
            });
          } catch (e) {
            v.log({ ev: "local-stt-fallback", error: String((e as Error)?.message ?? e) });
            fellBack = true;
            out = await postStt(wav, fetch, "audio/wav", sttHint());
          }
        } else out = await postStt(wav, fetch, "audio/wav", sttHint());
        onSignals?.(out.signals);
        // The text guard: the agent's own words that leaked past the AEC are dropped.
        const chatEcho = v.echoCheck(out.text, durationMs);
        // The page reads aloud too (/read): what it said is the same kind of echo.
        // But first the page may claim the line as the user's own (/read's shadowing).
        const page = pageAudio();
        // From `at` (taken before the transcription await): when the speech began.
        const spokeAt = at - durationMs;
        if (!partial && !chatEcho.drop && page.heard(out.text, spokeAt)) {
          v.log({ ev: "voice-utt-page", durationMs, chars: out.text.length });
          return "";
        }
        const pageEcho = chatEcho.drop
          ? null
          : echoScore(
              out.text,
              page.said(spokeAt, ECHO_WINDOW_MS).map((r) => r.text),
            );
        const echo = pageEcho?.drop ? { ...pageEcho, during: chatEcho.during } : chatEcho;
        if (!partial)
          v.log({
            ev: "voice-utt",
            out: v.mode(),
            aec: aecAt,
            settings: trackAt,
            durationMs,
            during: echo.during,
            drop: echo.drop,
            score: echo.score,
            // Length only: this runs before the silence guard, and it reaches the Worker logs.
            chars: out.text.length,
            against: echo.drop ? echo.against?.slice(0, 80) : undefined,
          });
        if (echo.drop) {
          if (!partial) v.echoDropped();
          onEcho?.();
          return "";
        }
        // The route's own ms, for the latency record (latency.ts).
        if (!partial && out.ms !== undefined) voiceLatency().mark(seq, { sttServerMs: out.ms });
        // Which recognizer it was, for the menu's latency (latency.ts viaAt).
        if (!partial) noteSttVia(via);
        // And which engine, carried on the line (wire.ts SttTag; dev-only in the chat). Never the text.
        if (!partial) voiceLatency().mark(seq, { stt: sttTagOf(via, out.model, fellBack) });
        // Off the critical path: the clip goes after the transcript is returned (sideClip).
        if (sink) {
          const meta = {
            at,
            durationMs,
            label: cfg.label,
            transcript: out.text,
            model: out.model,
            aec: aecAt,
            track: trackAt,
          };
          sideClip(() => postSessionClip(sink, (key) => postClip(sink, wav, meta, fetch, key), v.log));
        }
        return out.text;
      } catch (e) {
        if (sink) {
          const meta = { at, durationMs, label: cfg.label, aec: aecAt, track: trackAt };
          sideClip(() => postSessionClip(sink, (key) => postClip(sink, wav, meta, fetch, key), v.log));
        }
        throw e;
      }
    },
    storage: {
      get: (k) => sessionStorage.getItem(k),
      set: (k, x) => sessionStorage.setItem(k, x),
      remove: (k) => sessionStorage.removeItem(k),
    },
    permission: async () => {
      const p = await navigator.permissions?.query({ name: "microphone" as PermissionName });
      return (p?.state as "granted" | "denied" | "prompt" | undefined) ?? "unknown";
    },
    visible: () => document.visibilityState !== "hidden",
    // Android backgrounds a PWA (hidden, then frozen): the session logs it, and a track lost meanwhile is reopened.
    lifecycle: (f) => {
      const vis = () => f(document.visibilityState === "hidden" ? "hidden" : "visible");
      const on: [EventTarget, string, () => void][] = [
        [document, "visibilitychange", vis],
        [document, "freeze", () => f("freeze")],
        [document, "resume", () => f("resume")],
        [window, "pagehide", () => f("pagehide")],
        [window, "pageshow", () => f("pageshow")],
      ];
      for (const [t, e, h] of on) t.addEventListener(e, h);
      return () => {
        for (const [t, e, h] of on) t.removeEventListener(e, h);
      };
    },
    resumeAudio: async () => {
      const c = audioCtx();
      if (!c) return false;
      if (c.state === "running") return true;
      // Without a gesture this may never settle: give it a moment.
      await Promise.race([c.resume().catch(() => {}), new Promise((r) => setTimeout(r, 800))]);
      return (c.state as string) === "running";
    },
    log: (ev) => v.log(ev),
    timing: (seq, m) => voiceLatency().mark(seq, m),
  });
}

/** The page's mic session (the voiceprint card routes enrolment sentences through it). */
export const pageMic = session;

/** Phosphor "microphone" (MIT, (c) 2023 Phosphor Icons), regular and fill. */
const MIC_PATH = {
  regular:
    "M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176ZM96,64a32,32,0,0,1,64,0v64a32,32,0,0,1-64,0Zm40,143.6V240a8,8,0,0,1-16,0V207.6A80.11,80.11,0,0,1,48,128a8,8,0,0,1,16,0,64,64,0,0,0,128,0,8,8,0,0,1,16,0A80.11,80.11,0,0,1,136,207.6Z",
  fill: "M80,128V64a48,48,0,0,1,96,0v64a48,48,0,0,1-96,0Zm128,0a8,8,0,0,0-16,0,64,64,0,0,1-128,0,8,8,0,0,0-16,0,80.11,80.11,0,0,0,72,79.6V240a8,8,0,0,0,16,0V207.6A80.11,80.11,0,0,0,208,128Z",
};
const MicIcon = ({ fill }: { fill: boolean }) => (
  <svg viewBox="0 0 256 256" width="1em" height="1em" fill="currentColor" aria-hidden>
    <path d={fill ? MIC_PATH.fill : MIC_PATH.regular} />
  </svg>
);

/** The browser can capture: getUserMedia and Web Audio. */
export const canCapture = () =>
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  !!(
    globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext
  );

/**
 * The mic button beside the chat input (docs/monitoring.md, "Mic"). One tap
 * turns listening on, another (or Escape) off. Each utterance the VAD cuts is
 * sent to /api/debug/stt at once, and its transcript appended to the input in
 * order (`onText`); nothing is sent as a message. While capturing: a red
 * pulsing ring; listening but quiet: a steady faint ring. No text on the
 * button: the ring shows the state, and a polite live region says it. With
 * `clipSink` (the owner's dev server) each utterance is also posted there,
 * with its transcript, to build a local test set. Hidden where the browser
 * cannot capture.
 *
 * Hands-free (voice.ts): while the mic is on, replies are always read aloud
 * (a slow blue ring, "agent speaking"), and a tap cuts the reply short. With
 * echo cancellation (lk:voice-aec, default) the mic stays open: the user
 * talking over the agent ducks it, and keeps it paused past BARGE_IN_MS; each
 * transcript goes through the echo guard first. With it off, capture is held
 * while the agent speaks, as before.
 */
export function DebugMic({
  onText,
  onPending,
  onActive,
  clipSink,
  localStt,
  label,
  gesture,
}: {
  onText: (text: string) => void;
  onPending: (n: number, interim: string) => void;
  onActive: (on: boolean) => void;
  clipSink?: string;
  /** The owner's local streaming STT (local-stt.ts): utterances stream there first. */
  localStt?: string;
  label: string;
  /**
   * The chat bar's own press handling (DebugChat): a vertical drag scrubs the
   * history, a horizontal one moves the bar; `wasDrag` swallows the click that
   * ends either, so a scrub never toggles the mic.
   */
  gesture?: {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
    wasDrag: () => boolean;
    description?: string;
    /** Push to talk (ptt.ts): held shows the seal-red ring and the time held. */
    ptt?: { state: PttState; since: number };
  };
}) {
  const held = gesture?.ptt?.state === "held" || gesture?.ptt?.state === "away";
  const away = gesture?.ptt?.state === "away";
  /** Seconds held, ticking once a second while held only. */
  const [heldS, setHeldS] = useState(0);
  const since = gesture?.ptt?.since ?? 0;
  useEffect(() => {
    if (!held) return setHeldS(0);
    const tick = () => setHeldS(Math.floor((Date.now() - since) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [held, since]);
  const [can, setCan] = useState(false);
  /** The page's mic session (mic-session.ts): it outlives this button. */
  const [view, setView] = useState<MicView>({
    state: "off",
    pending: 0,
    interim: "",
    error: null,
    resume: false,
    wake: "active",
  });
  /** The agent's reply is being read (voice session). */
  const [talking, setTalking] = useState(false);
  /** Whisper settings in force (adaptive.ts): shown on the button's tooltip. */
  const [whisper, setWhisper] = useState(() => voiceAdapt().state().whisper);
  useEffect(() => voiceAdapt().subscribe((s) => setWhisper(s.whisper)), []);
  const cb = useRef({ onText, onPending, onActive, clipSink, localStt, label });
  cb.current = { onText, onPending, onActive, clipSink, localStt, label };
  const mic = useRef<MicSession | null>(null);

  useEffect(() => {
    setCan(canCapture());
    if (!canCapture()) return;
    // Attach to the session — the same one across hot swaps and remounts;
    // detaching (unmount) never stops it.
    const m = (mic.current = session());
    m.configure({
      clipSink: cb.current.clipSink,
      localStt: cb.current.localStt,
      label: cb.current.label,
    });
    let active = false;
    const unsubView = m.subscribe((x) => {
      setView(x);
      const on = x.state !== "off";
      if (on !== active) {
        active = on;
        cb.current.onActive(on);
      }
    });
    const detach = m.attach({
      onText: (t) => cb.current.onText(t),
      onPending: (n, interim) => cb.current.onPending(n, interim),
    });
    const v = voice();
    setTalking(v.state().speaking);
    const unsubVoice = v.subscribe((x) => setTalking(x.speaking));
    return () => {
      unsubView();
      detach();
      unsubVoice();
    };
  }, []);
  useEffect(() => {
    mic.current?.configure({ clipSink, localStt, label });
  }, [clipSink, localStt, label]);
  const state = view.state;
  const pending = view.pending;
  const ws = wakeStrings();
  // A mic opened without a tap (a reload's auto-resume): the cues' context starts on his next one.
  const micIsOn = state !== "off";
  useEffect(() => {
    if (!micIsOn) return;
    const unlock = () => {
      const c = audioCtx();
      if (c && c.state !== "running") void c.resume().catch(() => {});
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
    };
  }, [micIsOn]);
  // A line the voiceprint filter stopped says so, for a moment: he should see his words go.
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = subscribeFiltered(() => {
      setStopped(true);
      clearTimeout(t);
      t = setTimeout(() => setStopped(false), FILTERED_NOTE_MS);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, []);
  const look = micLook(view);
  const note = view.error
    ? micErrorNote(view.error)
    : view.auto && view.state === "off"
      ? autoOffNote(view.auto.reason, chatExtra(), MIC_BLOCKED_NOTE)
    : view.state !== "off" && view.kws === "failed"
      ? ws.failed
      : view.state !== "off" && view.kws === "needs-wifi"
        ? ws.wifi
        : view.state !== "off" && stopped
          ? localSttStrings().filtered
          : null;

  useEffect(() => {
    if (state === "off") return;
    // Escape is an explicit off.
    const esc = (e: KeyboardEvent) => e.key === "Escape" && void mic.current?.off("escape");
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [state]);

  if (!can) return null;
  const rec = state === "capturing";
  const listening = state === "listening" || rec;
  const status = micStatus(state, pending, talking);
  const speaking = status === "speaking";
  /** On, but only waiting for "Linky" (the agent never hears what is said meanwhile). */
  const passive = state !== "off" && view.wake === "passive" && !speaking;
  const wakeLabel = view.kws === "loading" ? ws.loading : ws.passive;
  const mt = chatExtra();
  return (
    // In the chat bar's cluster, after the + (open) or the pill's Li (folded).
    // Never text: a long press (push to talk) selects nothing, no iOS callout.
    <div className="relative flex shrink-0" style={NO_SELECT}>
      <style>{MIC_PULSE}</style>
      {/* What the ring shows, for screen readers: said on each change of state. */}
      <span role="status" aria-live="polite" className="sr-only" data-testid="debug-chat-mic-live">
        {state === "off" || state === "loading"
          ? ""
          : speaking
            ? mt.micReplyPlaying
            : passive
              ? wakeLabel
              : mt.micListening}
      </span>
      {note && (
        <span
          role="alert"
          data-testid="debug-chat-mic-note"
          // From the mic's start, over the bar: the mic is near the box's inner edge.
          className="pointer-events-none absolute start-0 bottom-full mb-2 whitespace-nowrap fs-10"
          style={{ color: "oklch(0.6 0.17 45)" }}
        >
          {note}
        </span>
      )}
      <button
        type="button"
        data-testid="debug-chat-mic"
        data-lk-tap
        data-state={state}
        data-resume={look === "off-self" || undefined}
        data-off-reason={look === "off-self" ? (view.auto?.reason ?? "reload") : undefined}
        data-status={status}
        data-wake={state !== "off" ? view.wake : undefined}
        data-whisper={whisper || undefined}
        data-ptt={gesture?.ptt?.state !== "idle" ? gesture?.ptt?.state : undefined}
        aria-pressed={state !== "off"}
        aria-label={
          state === "off"
            ? look === "off-self"
              ? mt.micResume
              : mt.micDictate
            : speaking
              ? mt.micReplyTap
              : passive
                ? wakeLabel
                : rec
              ? mt.micRecordingTap
              : mt.micListeningTap
        }
        aria-description={gesture?.description}
        title={
          passive
            ? wakeLabel
            : whisper && state !== "off"
              ? `Whisper mode${gesture?.description ? ` · ${gesture.description}` : ""}`
              : gesture?.description
        }
        // Keeps the input's focus: the log stays open while dictating.
        onPointerDown={(e) => {
          e.preventDefault();
          gesture?.onPointerDown(e);
        }}
        onPointerMove={gesture?.onPointerMove}
        onPointerUp={gesture?.onPointerUp}
        onPointerCancel={gesture?.onPointerCancel}
        onKeyDown={gesture?.onKeyDown}
        // A long press is push to talk, never the context menu.
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          // The click that ends a scrub or a move is not a tap.
          if (gesture?.wasDrag()) return;
          // Barge in: the reading stops (it reads on later), and capture resumes at once.
          if (speaking) return voice().interrupt("tap");
          // Made in this gesture, so iOS lets it play the cues (and cloud replies) later.
          if (state === "off") {
            void audioCtx()?.resume().catch(() => {});
            // The cloud reads replies when this device has no speechSynthesis voice (voice.ts).
            if (outMode() === "cloud" || noSpeechVoices()) cloudOut()?.unlock();
          }
          void mic.current?.toggle();
        }}
        // 40px wide, and 40px tall to the touch (tap-40); no scrolling under a drag.
        // Its circle is the line-sized square at its end (the start padding takes
        // the rest of the 40px): in the bar's corner, concentric with its border
        // (bar-geometry.ts).
        style={{
          ...MIC_BOX,
          ...NO_SELECT,
          color: state === "off" ? undefined : speaking ? TALK : passive ? WAIT : REC,
        }}
        className={`tap-40 pointer-events-auto relative flex touch-none flex-col items-center justify-center text-base leading-none text-gray-500 ${state === "loading" ? "opacity-50" : ""}`}
      >
        {held && (
          // Push to talk held: a seal-red ring that pulses, and the seconds held
          // (slid away to cancel: the ring dims and dashes).
          <>
            <span
              aria-hidden
              data-testid="debug-chat-mic-ptt"
              className={`pointer-events-none absolute rounded-full ${away ? "border-2 border-dashed opacity-60" : "animate-pulse motion-reduce:animate-none"}`}
              style={{
                ...MIC_RING,
                ...(away ? { borderColor: PTT_RING } : { boxShadow: `0 0 0 3px ${PTT_RING}` }),
                animationDuration: "1s",
              }}
            />
            <span
              data-testid="debug-chat-mic-ptt-time"
              className="pointer-events-none absolute bottom-full mb-1 rounded-full px-1.5 fs-10 font-semibold tabular-nums"
              style={{ background: PTT_RING, color: "oklch(0.99 0 0)" }}
            >
              {away ? "✕" : `${heldS}s`}
            </span>
          </>
        )}
        {speaking ? (
          // The agent speaks: a slow blue ring, so it is never mistaken for capture.
          <span
            aria-hidden
            data-testid="debug-chat-mic-speaking"
            className="pointer-events-none absolute rounded-full animate-pulse motion-reduce:animate-none"
            style={{ ...MIC_RING, boxShadow: `0 0 0 2px ${TALK}`, animationDuration: "2.4s" }}
          />
        ) : passive ? (
          // Passive: a dashed ring, pulsing slowly while the spotter downloads.
          <span
            aria-hidden
            data-testid="debug-chat-mic-passive"
            className={`pointer-events-none absolute rounded-full border-2 border-dashed ${view.kws === "loading" ? "animate-pulse motion-reduce:animate-none" : ""}`}
            style={{ ...MIC_RING, borderColor: WAIT }}
          />
        ) : look === "off-self" ? (
          // Off by itself (a reload, a lost track, another tab; mic-off.ts): one tap resumes.
          <span
            aria-hidden
            data-testid="debug-chat-mic-resume"
            className={`pointer-events-none absolute rounded-full border-2 border-dashed`}
            style={{ ...MIC_RING, borderColor: REC }}
          />
        ) : listening && (
          // Steady and faint while listening; red and pulsing (MIC_PULSE) while audio
          // is captured. The ring alone shows it: no text on the button (owner, 2026-11-03).
          <span
            aria-hidden
            data-testid="debug-chat-mic-ring"
            data-rec={rec || undefined}
            className="pointer-events-none absolute rounded-full"
            style={{
              ...MIC_RING,
              boxShadow: `0 0 0 2px ${rec ? REC : "oklch(0.6 0.22 25 / 0.35)"}`,
              animation: rec ? "lk-mic-pulse 1.2s ease-in-out infinite" : undefined,
            }}
          />
        )}
        <MicIcon fill={state !== "off"} />
        {state !== "off" && view.local && view.local !== "idle" && (
          // Where speech goes (docs/local-stt.md): green = the local model, amber = connecting, grey = the cloud.
          <span
            role="status"
            data-testid="debug-chat-mic-local"
            data-local={view.local}
            aria-label={localSttStrings()[view.local]}
            title={localSttStrings()[view.local]}
            className={`pointer-events-none absolute end-1 top-0 size-1.5 rounded-full ${view.local === "connecting" ? "animate-pulse motion-reduce:animate-none" : ""}`}
            style={{ background: LOCAL_DOT[view.local] }}
          />
        )}
      </button>
    </div>
  );
}

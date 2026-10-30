"use client";

import { useEffect, useRef, useState } from "react";
import {
  type MicState,
  type Vad,
  type VadEvents,
  RATE,
  energyGate,
  micErrorNote,
  micStatus,
  postClip,
  postStt,
  resample,
  scheduleTick,
} from "./mic";
import { voiceLatency } from "./latency";
import { createLocalStt } from "./local-stt";
import { localSttStrings } from "./ui-strings";
import { type MicSession, type MicView, micSession } from "./mic-session";
import { sttHint } from "./stt-hint";
import { voice } from "./voice";
import {
  aecOn,
  appliedSettings,
  audioCtx,
  cloudOut,
  existingCtx,
  micConstraints,
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
/** The agent speaking (capture held): a calm blue, unlike the red of REC. */
const TALK = "oklch(0.62 0.14 250)";
/** The local-STT dot: the Mac's model, connecting, or the cloud fallback. */
const LOCAL_DOT = {
  ready: "oklch(0.7 0.16 150)",
  connecting: "oklch(0.78 0.14 80)",
  down: "oklch(0.65 0 0)",
} as const;

/**
 * The soft tick for a spoken sentence sent by itself (scheduleTick), on the
 * mic's AudioContext; never while the agent speaks, never without the mic
 * (so typed sends are silent). Web Audio only, so a muted iPhone stays quiet.
 */
export function playSentTick(): boolean {
  const c = existingCtx();
  if (!c || c.state === "closed" || voice().state().speaking) return false;
  void c.resume().then(
    () => scheduleTick(c as unknown as Parameters<typeof scheduleTick>[0]),
    () => {},
  );
  return true;
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
 * The mic, with echo cancellation, noise suppression and auto gain on
 * (lk:voice-aec; voice-out.ts). vad-web is handed this stream (getStream),
 * so these are the constraints it runs with. What the browser applied is kept
 * for the per-utterance debug log. The mic session (mic-session.ts) owns it:
 * the VADs below listen on it and never stop it.
 */
const micStream = async () => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(aecOn()) });
  noteTrack(s);
  return s;
};

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
  const v = await g.MicVAD.new({
    baseAssetPath: VAD,
    onnxWASMBasePath: ORT,
    model: "v5",
    submitUserSpeechOnPause: true,
    startOnLoad: false,
    getStream: async () => stream,
    pauseStream: async () => {},
    resumeStream: async () => stream,
    onSpeechStart: ev.onSpeechStart,
    onSpeechEnd: ev.onSpeechEnd,
    onVADMisfire: ev.onMisfire,
    onFrameProcessed: (p: { isSpeech?: number } | undefined, frame: Float32Array) =>
      ev.onFrame?.(frame, p?.isSpeech),
  });
  return {
    start: () => v.start(),
    pause: () => v.pause(),
    flush: async () => {
      await v.pause();
      await v.start();
    },
    destroy: () => v.destroy(),
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

/** The page's mic session, built with this module's browser pieces (mic-session.ts). */
function session(): MicSession {
  const v = voice();
  return micSession({
    getStream: micStream,
    load: (ev, s) => silero(ev, s as MediaStream),
    fallback: (ev, s) => energy(ev, s as MediaStream),
    onState: (s, last) => {
      const active = s !== "off";
      v.setMic(active);
      // The user starts talking: over the agent it ducks (a barge-in if they
      // keep going), else the reading pauses; it reads on once they are done.
      if (s === "capturing") v.userSpeech();
      else if (last === "capturing") v.userIdle();
      if (!active && !v.state().speaking) void existingCtx()?.suspend().catch(() => {});
    },
    onProb: (p) => v.userFrame(p),
    // Only with lk:voice-aec off: else the mic stays open and the user can barge in.
    subscribeHold: (f) => {
      f(v.state().hold);
      return v.subscribe((x) => f(x.hold));
    },
    localStt: (url) => createLocalStt(url, { log: (ev) => v.log(ev) }),
    upload: async (wav, { seq, durationMs, partial, local }, cfg) => {
      const at = Date.now();
      const sink = partial ? undefined : cfg.clipSink;
      try {
        // `ms`: the server's own time, the route's or the Mac's decode (sttServerMs in the timing).
        let out: { text: string; model?: string; ms?: number };
        if (local) {
          // Streamed to the owner's Mac (local-stt.ts); on any failure, the route as before.
          try {
            const f = await local;
            out = f;
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
            out = await postStt(wav, fetch, "audio/wav", sttHint());
          }
        } else out = await postStt(wav, fetch, "audio/wav", sttHint());
        // The text guard: the agent's own words that leaked past the AEC are dropped.
        const echo = v.echoCheck(out.text, durationMs);
        if (!partial)
          v.log({
            ev: "voice-utt",
            out: v.mode(),
            aec: v.aec(),
            settings: appliedSettings(),
            durationMs,
            during: echo.during,
            drop: echo.drop,
            score: echo.score,
            text: out.text.slice(0, 80),
            against: echo.drop ? echo.against?.slice(0, 80) : undefined,
          });
        if (echo.drop) {
          if (!partial) v.echoDropped();
          return "";
        }
        // The route's own ms, for the latency record (latency.ts).
        if (!partial && out.ms !== undefined) voiceLatency().mark(seq, { sttServerMs: out.ms });
        if (sink)
          void postClip(sink, wav, {
            at,
            durationMs,
            label: cfg.label,
            transcript: out.text,
            model: out.model,
            aec: v.aec(),
          });
        return out.text;
      } catch (e) {
        if (sink) void postClip(sink, wav, { at, durationMs, label: cfg.label, aec: v.aec() });
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
 * pulsing ring and REC; listening but quiet: a steady faint ring. With
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
  };
}) {
  const [can, setCan] = useState(false);
  /** The page's mic session (mic-session.ts): it outlives this button. */
  const [view, setView] = useState<MicView>({
    state: "off",
    pending: 0,
    interim: "",
    error: null,
    resume: false,
  });
  /** The agent's reply is being read (voice session). */
  const [talking, setTalking] = useState(false);
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
  const note = view.error ? micErrorNote(view.error) : null;

  useEffect(() => {
    if (state === "off") return;
    // Escape is an explicit off.
    const esc = (e: KeyboardEvent) => e.key === "Escape" && void mic.current?.off();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [state]);

  if (!can) return null;
  const rec = state === "capturing";
  const listening = state === "listening" || rec;
  const status = micStatus(state, pending, talking);
  const speaking = status === "speaking";
  return (
    // The chat bar's last control, right of the input.
    <div className="relative flex shrink-0">
      {note && (
        <span
          role="alert"
          data-testid="debug-chat-mic-note"
          className="pointer-events-none absolute end-0 bottom-full mb-2 whitespace-nowrap text-[10px]"
          style={{ color: "oklch(0.6 0.17 45)" }}
        >
          {note}
        </span>
      )}
      <button
        type="button"
        data-testid="debug-chat-mic"
        data-state={state}
        data-resume={(view.resume && state === "off") || undefined}
        data-status={status}
        aria-pressed={state !== "off"}
        aria-label={
          state === "off"
            ? view.resume
              ? "Tap to resume listening"
              : "Dictate: listen and type what you say"
            : speaking
              ? "Agent speaking; tap to interrupt and talk"
              : rec
              ? "Recording; tap to stop listening"
              : "Listening; tap to stop"
        }
        aria-description={gesture?.description}
        title={gesture?.description}
        // Keeps the input's focus: the log stays open while dictating.
        onPointerDown={(e) => {
          e.preventDefault();
          gesture?.onPointerDown(e);
        }}
        onPointerMove={gesture?.onPointerMove}
        onPointerUp={gesture?.onPointerUp}
        onPointerCancel={gesture?.onPointerCancel}
        onKeyDown={gesture?.onKeyDown}
        onClick={() => {
          // The click that ends a scrub or a move is not a tap.
          if (gesture?.wasDrag()) return;
          // Barge in: the reading stops (it reads on later), and capture resumes at once.
          if (speaking) return voice().interrupt("tap");
          // Made in this gesture, so iOS lets it play the send tick (and cloud replies) later.
          if (state === "off") {
            void audioCtx()?.resume().catch(() => {});
            if (outMode() === "cloud") cloudOut()?.unlock();
          }
          void mic.current?.toggle();
        }}
        // 40px wide, and 40px tall to the touch (tap-40); no scrolling under a drag.
        className={`tap-40 pointer-events-auto relative flex h-8 w-10 touch-none flex-col items-center justify-center rounded-full text-base leading-none text-gray-500 ${state === "loading" ? "opacity-50" : ""}`}
        style={{ color: state === "off" ? undefined : speaking ? TALK : REC }}
      >
        {speaking ? (
          // The agent speaks: a slow blue ring, so it is never mistaken for REC.
          <span
            aria-hidden
            data-testid="debug-chat-mic-speaking"
            className="pointer-events-none absolute inset-x-1.5 inset-y-0.5 animate-pulse rounded-full"
            style={{ boxShadow: `0 0 0 2px ${TALK}`, animationDuration: "2.4s" }}
          />
        ) : view.resume && state === "off" ? (
          // Reloaded with the mic on, and it could not resume by itself: one tap does.
          <span
            aria-hidden
            data-testid="debug-chat-mic-resume"
            className="pointer-events-none absolute inset-x-1.5 inset-y-0.5 rounded-full border-2 border-dashed"
            style={{ borderColor: REC }}
          />
        ) : listening && (
          // Steady and faint while listening; red and pulsing while audio is captured.
          <span
            aria-hidden
            className={`pointer-events-none absolute inset-x-1.5 inset-y-0.5 rounded-full ${rec ? "animate-pulse" : ""}`}
            style={{ boxShadow: `0 0 0 2px ${rec ? REC : "oklch(0.6 0.22 25 / 0.35)"}` }}
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
        {rec && (
          <span
            data-testid="debug-chat-mic-rec"
            className="text-[8px] font-bold leading-none"
            style={{ color: REC }}
          >
            REC
          </span>
        )}
      </button>
    </div>
  );
}

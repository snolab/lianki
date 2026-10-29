"use client";

import { useEffect, useRef, useState } from "react";
import {
  type MicState,
  type Vad,
  type VadEvents,
  RATE,
  createMic,
  energyGate,
  micErrorNote,
  micStatus,
  postClip,
  postStt,
  resample,
} from "./mic";

/**
 * Silero VAD (@ricky0123/vad-web) and its ONNX runtime, from jsDelivr at pinned
 * versions, loaded only when the mic is first turned on, so neither is in any
 * bundle. The runtime's wasm is ~11 MB, too big to self-host for one debug
 * button; the app sets no CSP.
 */
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
const VAD = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/";
const REC = "oklch(0.6 0.22 25)";

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

const micStream = () =>
  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
const stop = (s: MediaStream) => {
  for (const t of s.getTracks()) t.stop();
};

/**
 * Silero: ends an utterance after ~0.8 s of silence. The mic is opened first
 * (so a refusal is told apart from a load failure, and skips the fallback),
 * and kept open across `flush` (= pause, which submits, + start).
 */
async function silero(ev: VadEvents): Promise<Vad> {
  const stream = await micStream();
  try {
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
      onFrameProcessed: (_p: unknown, frame: Float32Array) => ev.onFrame?.(frame),
    });
    return {
      start: () => v.start(),
      pause: () => v.pause(),
      flush: async () => {
        await v.pause();
        await v.start();
      },
      destroy: async () => {
        await v.destroy();
        stop(stream);
      },
    };
  } catch (e) {
    stop(stream);
    throw e;
  }
}

/** The fallback: an energy threshold on the raw microphone signal (lib/mic.ts energyGate). */
async function energy(ev: VadEvents): Promise<Vad> {
  const stream = await micStream();
  const Ctx =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
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
    },
    flush: () => emit(gate.flush()),
    destroy: () => {
      on = false;
      node.disconnect();
      src.disconnect();
      stop(stream);
      return ctx.close();
    },
  };
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

/** Pause the agent's read-aloud while listening (the mic would hear it), resume after. */
function holdSpeech(on: boolean) {
  if (typeof speechSynthesis === "undefined") return;
  if (on) speechSynthesis.pause();
  else speechSynthesis.resume();
}

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
 */
export function DebugMic({
  onText,
  onPending,
  onActive,
  clipSink,
  label,
}: {
  onText: (text: string) => void;
  onPending: (n: number, interim: string) => void;
  onActive: (on: boolean) => void;
  clipSink?: string;
  label: string;
}) {
  const [can, setCan] = useState(false);
  const [state, setState] = useState<MicState>("off");
  const [pending, setPending] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const cb = useRef({ onText, onPending, onActive, clipSink, label });
  cb.current = { onText, onPending, onActive, clipSink, label };
  const mic = useRef<ReturnType<typeof createMic> | null>(null);

  useEffect(() => {
    setCan(canCapture());
    mic.current = createMic({
      load: silero,
      fallback: energy,
      onState: (s) => {
        setState(s);
        const active = s !== "off";
        holdSpeech(active);
        cb.current.onActive(active);
      },
      onText: (t) => cb.current.onText(t),
      onPending: (n, interim) => {
        setPending(n);
        cb.current.onPending(n, interim);
      },
      onError: (e) => setNote(micErrorNote(e)),
      upload: async (wav, { durationMs, partial }) => {
        const at = Date.now();
        const sink = partial ? undefined : cb.current.clipSink;
        try {
          const out = await postStt(wav);
          if (sink)
            void postClip(sink, wav, {
              at,
              durationMs,
              label: cb.current.label,
              transcript: out.text,
              model: out.model,
            });
          return out.text;
        } catch (e) {
          if (sink) void postClip(sink, wav, { at, durationMs, label: cb.current.label });
          throw e;
        }
      },
    });
    return () => {
      const m = mic.current;
      if (m && m.state() !== "off") void m.off();
    };
  }, []);

  useEffect(() => {
    if (state === "off") return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && void mic.current?.off();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [state]);

  if (!can) return null;
  const rec = state === "capturing";
  const listening = state === "listening" || rec;
  return (
    // Inside the input, at its right edge (the input is padded so text never runs under it).
    <div className="absolute end-0.5 top-1/2 flex -translate-y-1/2">
      {note && (
        <span
          role="alert"
          data-testid="debug-chat-mic-note"
          className="pointer-events-none absolute end-0 bottom-full mb-1 whitespace-nowrap text-[10px]"
          style={{ color: "oklch(0.6 0.17 45)" }}
        >
          {note}
        </span>
      )}
      <button
        type="button"
        data-testid="debug-chat-mic"
        data-state={state}
        data-status={micStatus(state, pending)}
        aria-pressed={state !== "off"}
        aria-label={
          state === "off"
            ? "Dictate: listen and type what you say"
            : rec
              ? "Recording; tap to stop listening"
              : "Listening; tap to stop"
        }
        onClick={() => {
          setNote(null);
          void mic.current?.toggle();
        }}
        className={`pointer-events-auto relative flex size-8 flex-col items-center justify-center rounded-full text-base leading-none text-gray-500 ${state === "loading" ? "opacity-50" : ""}`}
        style={{ color: state === "off" ? undefined : REC }}
      >
        {listening && (
          // Steady and faint while listening; red and pulsing while audio is captured.
          <span
            aria-hidden
            className={`pointer-events-none absolute inset-0.5 rounded-full ${rec ? "animate-pulse" : ""}`}
            style={{ boxShadow: `0 0 0 2px ${rec ? REC : "oklch(0.6 0.22 25 / 0.35)"}` }}
          />
        )}
        <MicIcon fill={state !== "off"} />
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

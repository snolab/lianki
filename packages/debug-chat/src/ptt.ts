/**
 * Push to talk on the chat's mic (owner, 2026-11-10: "长按说话", "lose not a
 * single second"). docs/voice-mode.md, "Push to talk".
 *
 * - A short tap still toggles always-on listening, the VAD as ever.
 * - A long press (PTT_HOLD_MS, the platform's long-press) is ONE voice input:
 *   the recorder starts at the pointerdown itself (the line's start time),
 *   no VAD or endpoint cuts it while held, so soft or whispered speech is
 *   kept whole. Release keeps PTT_TAIL_MS more, then the whole clip goes
 *   through the STT route once (cut into pieces only past its size limit)
 *   and the line is SENT, no draft step.
 * - While the always-on mic is already open, the last PTT_PREROLL_MS of its
 *   audio is kept in a ring in memory (`createRing`) and put in front of the
 *   clip, so words said just before the press are not lost. Memory only:
 *   never stored or uploaded unless that clip is sent.
 * - Sliding the finger PTT_CANCEL_PX away while held arms a cancel; letting
 *   go there drops the clip. Coming back disarms it.
 * - It replaces the old drag-the-mic-to-scroll-history gesture; the history
 *   scrolls by dragging the history itself (log-engage.ts).
 *
 * The decisions are pure (the gesture, the ring, the chunking:
 * unit/ptt.test.ts); the audio glue is at the bottom.
 */
import { HOLD_MS } from "./log-engage";

/** A press held this long is push to talk (the platform's long-press). */
export const PTT_HOLD_MS = HOLD_MS;
/** Kept from before the press while the mic is open (owner: 1–3 s). */
export const PTT_PREROLL_MS = 2_000;
/** Kept after the release, so the last word is not cut (owner: 1–3 s). */
export const PTT_TAIL_MS = 1_000;
/** Held, the finger this far from where it pressed arms a cancel. */
export const PTT_CANCEL_PX = 80;
/**
 * The STT route's size limit (lib/stt.ts STT_MAX_BYTES; unit-tested equal):
 * a longer hold is sent in pieces under it, transcribed in order, one line.
 */
export const PTT_MAX_WAV_BYTES = 2 * 1024 * 1024;
/** A WAV file's header, before its 16-bit samples. */
const WAV_HEADER = 44;

/* The gesture. */

export type PttState = "idle" | "pressed" | "held" | "away";

export type PttEvents = {
  /** The pointer went down: start recording now (the line's start, `at`). */
  press(at: number): void;
  /** The press became push to talk (PTT_HOLD_MS): the held state, a haptic. */
  hold(at: number): void;
  /** Let go while held: keep the tail, then transcribe and send. */
  release(at: number): void;
  /** No clip: a tap, a cancel, or a press that became a drag. */
  drop(why: "tap" | "cancel" | "drag"): void;
  /** Each change of state, for the UI. */
  state?(s: PttState): void;
};

export function createPttGesture(
  on: PttEvents,
  d: {
    holdMs?: number;
    cancelPx?: number;
    now?: () => number;
    setTimer?: (f: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
  } = {},
) {
  const holdMs = d.holdMs ?? PTT_HOLD_MS;
  const cancelPx = d.cancelPx ?? PTT_CANCEL_PX;
  const now = d.now ?? (() => Date.now());
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let state: PttState = "idle";
  let from = { x: 0, y: 0 };
  let timer: unknown;
  const set = (s: PttState) => {
    state = s;
    on.state?.(s);
  };
  return {
    state: () => state,
    /** Held or away: the press was push to talk (its click is no tap). */
    wasHold: () => state === "held" || state === "away",
    down(x: number, y: number) {
      if (state !== "idle") return;
      from = { x, y };
      set("pressed");
      on.press(now());
      timer = setTimer(() => {
        if (state !== "pressed") return;
        set("held");
        on.hold(now());
      }, holdMs);
    },
    move(x: number, y: number) {
      if (state !== "held" && state !== "away") return;
      const far = Math.hypot(x - from.x, y - from.y) > cancelPx;
      if (far && state === "held") set("away");
      else if (!far && state === "away") set("held");
    },
    /** The press became something else before the hold (a drag that moves the bar). */
    drag() {
      if (state !== "pressed") return;
      clearTimer(timer);
      set("idle");
      on.drop("drag");
    },
    up() {
      clearTimer(timer);
      const s = state;
      set("idle");
      if (s === "pressed") on.drop("tap");
      else if (s === "held") on.release(now());
      else if (s === "away") on.drop("cancel");
    },
    /** The platform took the pointer (pointercancel): no clip. */
    cancel() {
      clearTimer(timer);
      const s = state;
      set("idle");
      if (s !== "idle") on.drop("cancel");
    },
  };
}

/* The pre-roll ring. */

/** A ring of the last `capacity` samples, in memory only. */
export function createRing(capacity: number) {
  const buf = new Float32Array(Math.max(0, Math.floor(capacity)));
  let end = 0;
  let size = 0;
  return {
    size: () => size,
    capacity: () => buf.length,
    push(chunk: Float32Array) {
      if (!buf.length) return;
      const src = chunk.length > buf.length ? chunk.subarray(chunk.length - buf.length) : chunk;
      for (let i = 0; i < src.length; i++) {
        buf[end] = src[i]!;
        end = (end + 1) % buf.length;
      }
      size = Math.min(buf.length, size + src.length);
    },
    /** The samples held, oldest first (a copy). */
    take(): Float32Array {
      const out = new Float32Array(size);
      const start = (end - size + buf.length) % (buf.length || 1);
      for (let i = 0; i < size; i++) out[i] = buf[(start + i) % buf.length]!;
      return out;
    },
    clear() {
      size = 0;
      end = 0;
      buf.fill(0);
    },
  };
}

/* The clip. */

/** Join the pre-roll and the held recording into one clip. */
export function joinClip(pre: Float32Array, held: Float32Array): Float32Array {
  const out = new Float32Array(pre.length + held.length);
  out.set(pre, 0);
  out.set(held, pre.length);
  return out;
}

/** Pieces of `samples` whose 16-bit WAV stays under `maxBytes` (one piece when it fits). */
export function chunkSamples(samples: Float32Array, maxBytes = PTT_MAX_WAV_BYTES): Float32Array[] {
  const per = Math.max(1, Math.floor((maxBytes - WAV_HEADER) / 2));
  if (samples.length <= per) return [samples];
  const out: Float32Array[] = [];
  for (let i = 0; i < samples.length; i += per) out.push(samples.subarray(i, i + per));
  return out;
}

/** The pieces' transcripts as one line (blank ones dropped). */
export const joinTexts = (texts: readonly string[]) =>
  texts
    .map((t) => t.trim())
    .filter(Boolean)
    .join(" ");

/* While held, the always-on mic's VAD must not cut a line of its own from the same speech. */

const holders = new Set<() => void>();
let holding = false;
/** Push to talk is recording (held or in its tail): the always-on capture holds. */
export const pttHolding = () => holding;
export function setPttHolding(on: boolean) {
  if (holding === on) return;
  holding = on;
  for (const f of holders) f();
}
export function onPttHolding(f: () => void) {
  holders.add(f);
  return () => void holders.delete(f);
}

/* The audio glue (browser). */

/**
 * Raw samples from `stream` in `ctx` (a ScriptProcessor into a silent gain:
 * nothing is ever played). `stop` ends it.
 */
export function pcmTap(
  ctx: AudioContext,
  stream: MediaStream,
  onChunk: (samples: Float32Array) => void,
): () => void {
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  proc.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  return () => {
    proc.onaudioprocess = null;
    try {
      src.disconnect();
      proc.disconnect();
      mute.disconnect();
    } catch {}
  };
}

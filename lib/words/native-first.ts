/**
 * A word with a private original recording ("原音", native-audio-client.ts)
 * is said from it when it can start soon; otherwise the synthetic voice says
 * it at once. The word is never silent: the recording gets `startMs` to become
 * audible, then the synthetic voice takes over (the archive keeps downloading
 * in the background and serves the next showing).
 */
import type { NativeCard, NativeClip } from "./native-audio-client";

export type NativeSource = {
  readonly ready: boolean;
  readonly enabled: boolean;
  load(card: NativeCard, signal: AbortSignal): Promise<NativeClip | null>;
};

export type NativeFirstDeps = {
  /** The account's "Original recordings" switch (`words.nativeAudio`). */
  on: boolean;
  client: NativeSource | null;
  card?: NativeCard;
  /** How long the recording may take to become audible (`words.nativeAudioStartMs`). */
  startMs: number;
  /** Aborted when the part is cut (card change, stop). */
  signal: AbortSignal;
  /** Play the clip's range; `started` once it is audible, `done` once it ends. */
  play: (
    clip: NativeClip,
    signal: AbortSignal,
    started: () => void,
    done: (played: boolean) => void,
  ) => void;
  /** Say the word with the synthetic voice; it reports done itself. */
  synthetic: () => void;
  done: (played: boolean) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
};

/** True when the word goes straight to the synthetic voice. */
export function skipsNative(d: Pick<NativeFirstDeps, "on" | "client" | "card">): boolean {
  return !d.on || !d.card || !d.client || (d.client.ready && !d.client.enabled);
}

export function sayNativeFirst(d: NativeFirstDeps): void {
  if (d.signal.aborted) return;
  if (skipsNative(d)) return d.synthetic();
  const own = new AbortController();
  const signal = AbortSignal.any([d.signal, own.signal]);
  let started = false;
  let settled = false;
  /** The synthetic voice says it instead; the recording is let go. */
  const instead = () => {
    if (settled || signal.aborted) return;
    settled = true;
    d.clearTimer(timer);
    own.abort();
    d.synthetic();
  };
  const timer = d.setTimer(() => {
    if (!started) instead();
  }, d.startMs);
  signal.addEventListener("abort", () => d.clearTimer(timer), { once: true });
  void d.client!.load(d.card!, signal).then(
    (clip) => {
      if (signal.aborted || settled) return;
      if (!clip) return instead();
      d.play(
        clip,
        signal,
        () => {
          started = true;
          d.clearTimer(timer);
        },
        (played) => {
          if (signal.aborted || settled) return;
          if (!played) return instead();
          settled = true;
          d.clearTimer(timer);
          d.done(true);
        },
      );
    },
    () => instead(),
  );
}

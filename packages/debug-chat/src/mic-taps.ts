/**
 * Command taps on the page's mic (docs/voice-mode.md): a page feature that
 * takes spoken commands (the /words voice mode) sees each final transcript
 * before the chat does, and may keep it. It can also pin the mic to active
 * mode, so commands need no wake word while it is on.
 *
 * The registry lives on globalThis (MIC_TAPS_KEY), not in the session: a mic
 * session that is replaced (a hot-swapped widget migrating it, mic-session.ts
 * `micSession`) consults the same taps and pins, so a feature never has to
 * re-register. A session older than MIC_SESSION_V 10 does not consult it.
 *
 * Pure apart from that one global, and unit-tested (unit/mic-taps.test.ts).
 */

/** globalThis key of the registry. */
export const MIC_TAPS_KEY = "__lkMicTaps";

/** A tap: true keeps the transcript (it was a command, or was shown as "not a command"). */
export type MicTap = (text: string) => boolean;

export type MicTaps = {
  /** Add a tap; the newest is asked first. Returns the removal. */
  tap(f: MicTap): () => void;
  /** Hold the mic in active mode (no wake word); returns the release. Pins count. */
  pin(): () => void;
  pinned(): boolean;
  /** Offer a final transcript to the taps: true when one kept it. A throwing tap keeps nothing. */
  offer(text: string): boolean;
  /** How many transcripts a tap has kept: a command between two lines keeps them apart. */
  kept(): number;
  /** Called when the first pin is taken (the session puts the mic back in active mode). */
  onPin(f: () => void): () => void;
  /**
   * Another listener owns the room (/vibe, docs/vibe.md): the chat's mic turns
   * off, cannot turn on, and whatever it still hands over is kept from the chat.
   * Other tabs' chat mics are turned off too. Returns the release.
   */
  block(): () => void;
  blocked(): boolean;
  /** Called when a block is taken, here or in another tab: the session turns its mic off. */
  onBlock(f: () => void): () => void;
};

/** BroadcastChannel name: a block taken in another tab. */
export const MIC_BLOCK_CHANNEL = "lk-mic-block";

export function createMicTaps(): MicTaps {
  const taps: MicTap[] = [];
  const pinListeners = new Set<() => void>();
  let pins = 0;
  let kept = 0;
  let blocks = 0;
  const blockListeners = new Set<() => void>();
  const blockedNow = () => {
    for (const f of [...blockListeners]) {
      try {
        f();
      } catch {}
    }
  };
  const channel =
    typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(MIC_BLOCK_CHANNEL);
  if (channel) {
    channel.onmessage = blockedNow;
    (channel as { unref?: () => void }).unref?.();
  }
  return {
    tap(f) {
      taps.unshift(f);
      return () => {
        const i = taps.indexOf(f);
        if (i >= 0) taps.splice(i, 1);
      };
    },
    pin() {
      pins++;
      if (pins === 1) for (const f of pinListeners) f();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pins = Math.max(0, pins - 1);
      };
    },
    pinned: () => pins > 0,
    kept: () => kept,
    offer(text) {
      // Not for the chat, and not a command: dropped here.
      if (blocks > 0) return true;
      for (const f of [...taps]) {
        try {
          if (f(text)) {
            kept++;
            return true;
          }
        } catch {
          // A broken tap never swallows speech: the chat still gets it.
        }
      }
      return false;
    },
    onPin(f) {
      pinListeners.add(f);
      return () => void pinListeners.delete(f);
    },
    block() {
      blocks++;
      blockedNow();
      channel?.postMessage(1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        blocks = Math.max(0, blocks - 1);
      };
    },
    blocked: () => blocks > 0,
    onBlock(f) {
      blockListeners.add(f);
      return () => void blockListeners.delete(f);
    },
  };
}

/** The page's registry, made once. */
export function micTaps(): MicTaps {
  const g = globalThis as unknown as Record<string, MicTaps | undefined>;
  return (g[MIC_TAPS_KEY] ??= createMicTaps());
}

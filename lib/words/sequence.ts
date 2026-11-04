/**
 * Plays a row's parts (word → example → meaning) back to back, once or on a
 * loop. A new play() or stop() interrupts: nothing of the old sequence runs
 * after it, even a part that reports done late.
 *
 * With `owner` (packages/debug-chat/src/audio-claim.ts) a sequence claims the
 * page's audio before it plays. Li speaking pauses it (the part playing is
 * cut) and, when Li's line ends, the same part is said again from its start.
 * A claim refused (Li is speaking) waits for it the same way.
 */

export type SequencerDeps<P> = {
  /**
   * Say one part; call `done(played)` once it ends, or at once with false
   * when nothing could say it — the next part goes on. A `done` that
   * comes after `cancel()` is ignored.
   */
  say: (part: P, done: (played: boolean) => void) => void;
  /** Silence what is playing now. */
  cancel: () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  /** Between parts. */
  gapMs?: number;
  /** Before a loop starts over. */
  repeatMs?: number;
  /** The page's audio owner, made once for this sequencer. */
  owner?: (h: { onYield(): void; onResume(): void }) => {
    claim(): boolean;
    release(): void;
  };
};

export type PlayOptions = {
  loop?: boolean;
  /** Wait before the first part (0: start now, inside a tap's gesture). */
  delayMs?: number;
  /** What this sequence is (e.g. "hold"), for `playing()` while it runs. */
  tag?: string;
};

export function createSequencer<P>(deps: SequencerDeps<P>) {
  const gap = deps.gapMs ?? 150;
  const repeat = deps.repeatMs ?? 1200;
  let generation = 0;
  let timer: unknown;
  /** The sequence playing now, if any: its tag, and whether it still loops. */
  let current: { tag: string; loop: boolean } | null = null;
  /** Paused for a higher sound: goes on with the part it was saying. */
  let parked: (() => void) | null = null;
  /** Set by play(): cuts the part playing and keeps the place. */
  let park: () => void = () => {};
  const owner =
    deps.owner?.({
      onYield: () => {
        if (current && !parked) park();
      },
      onResume: () => {
        const go = parked;
        parked = null;
        go?.();
      },
    }) ?? null;

  /** `keep`: a new sequence follows at once, so the page is not let go in between. */
  const halt = (keep: boolean) => {
    generation++;
    current = null;
    // Paused for Li: nothing of ours plays, and cancel() would cut Li's voice.
    const wasParked = !!parked;
    parked = null;
    deps.clearTimeout(timer);
    if (!wasParked) deps.cancel();
    if (!keep) owner?.release();
  };
  const stop = () => halt(false);

  const play = (parts: P[], opts: PlayOptions = {}) => {
    halt(parts.length > 0);
    if (!parts.length) return;
    let gen = generation;
    const cur = { tag: opts.tag ?? "", loop: !!opts.loop };
    current = cur;
    const end = () => {
      if (current !== cur) return;
      current = null;
      owner?.release();
    };
    let i = 0;
    /** Something played this round: a loop where nothing can play ends. */
    let any = false;
    const next = () => {
      if (gen !== generation) return;
      let called = false;
      deps.say(parts[i], (played) => {
        if (called || gen !== generation) return;
        called = true;
        any ||= played;
        i++;
        if (i < parts.length) return void (timer = deps.setTimeout(next, gap));
        if (!cur.loop || !any) return end();
        i = 0;
        any = false;
        timer = deps.setTimeout(next, repeat);
      });
    };
    /** Go on with part `i` when the page is ours again. */
    const resumeLater = () => {
      parked = () => {
        if (current !== cur) return;
        gen = ++generation;
        next();
      };
    };
    park = () => {
      // The part playing is cut; its late `done` is ignored (a new generation).
      generation++;
      deps.clearTimeout(timer);
      deps.cancel();
      resumeLater();
    };
    if (owner && !owner.claim()) return resumeLater();
    if (opts.delayMs) timer = deps.setTimeout(next, opts.delayMs);
    else next();
  };

  /** A loop plays the pass it is in to its end, then stops (nothing is cut). */
  const finish = () => {
    if (current) current.loop = false;
  };

  /** The tag of the sequence playing now ("" untagged), or null when silent. */
  const playing = () => current?.tag ?? null;

  return { play, stop, finish, playing };
}

/** "Read on a loop" on /words, per device (docs/prefs-sync.md): "on", or off. */
export const SOUND_LOOP_KEY = "lk:words-sound-loop";

/**
 * How a shown row is read: once per showing by default; with "Read on a
 * loop" on, again and again until it is graded or left (owner, 2026-11-04
 * 19:30 JST). A short delay so flicking through rows does not start a word per row.
 */
export const rowReading = (repeat: boolean): PlayOptions => ({ loop: repeat, delayMs: 250 });

/**
 * Plays a row's parts (word → meaning → example) back to back, once or on a
 * loop. A new play() or stop() interrupts: nothing of the old sequence runs
 * after it, even a part that reports done late.
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
};

export type PlayOptions = {
  loop?: boolean;
  /** Wait before the first part (0: start now, inside a tap's gesture). */
  delayMs?: number;
};

export function createSequencer<P>(deps: SequencerDeps<P>) {
  const gap = deps.gapMs ?? 150;
  const repeat = deps.repeatMs ?? 1200;
  let generation = 0;
  let timer: unknown;

  const stop = () => {
    generation++;
    deps.clearTimeout(timer);
    deps.cancel();
  };

  const play = (parts: P[], opts: PlayOptions = {}) => {
    stop();
    if (!parts.length) return;
    const gen = generation;
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
        if (!opts.loop || !any) return;
        i = 0;
        any = false;
        timer = deps.setTimeout(next, repeat);
      });
    };
    if (opts.delayMs) timer = deps.setTimeout(next, opts.delayMs);
    else next();
  };

  return { play, stop };
}

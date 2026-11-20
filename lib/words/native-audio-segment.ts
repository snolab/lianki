/** Play a bounded range on an element already owned by the word clip pool. */
type Clock = {
  frame: (fn: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
  timer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
};

export function startNativeSegment(
  el: HTMLAudioElement,
  range: { startMs: number; endMs: number },
  deps: {
    signal: AbortSignal;
    done: (played: boolean) => void;
    /** The range is audible: its first "playing" event. */
    started?: () => void;
    timeoutMs: number;
    clock?: Clock;
  },
): () => void {
  const clock: Clock = deps.clock ?? {
    frame: (fn) => requestAnimationFrame(fn),
    cancelFrame: (id) => cancelAnimationFrame(id),
    timer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  let stopped = false;
  let seeking = false;
  let started = false;
  let playing = false;
  let frame: number | undefined;
  let timer: unknown;
  const removers: (() => void)[] = [];
  const src = el.src;
  const active = () => !stopped && !deps.signal.aborted && el.src === src;
  const finish = (played: boolean, notify = true) => {
    if (stopped) return;
    stopped = true;
    if (frame !== undefined) clock.cancelFrame(frame);
    if (timer !== undefined) clock.clearTimer(timer);
    for (const remove of removers.splice(0)) remove();
    // A pool may have reused this element for another source already.
    if (el.src === src) el.pause();
    if (notify && el.src === src && !deps.signal.aborted) deps.done(played);
  };
  const cancel = () => finish(false, false);
  const listen = (name: string, fn: () => void) => {
    el.addEventListener(name, fn);
    removers.push(() => el.removeEventListener(name, fn));
  };
  const check = () => {
    frame = undefined;
    if (!active()) return cancel();
    if (playing && el.currentTime * 1000 >= range.endMs) return finish(true);
    frame = clock.frame(check);
  };
  const play = () => {
    if (!active() || started || el.seeking) return;
    started = true;
    try {
      void el.play().catch(() => {
        if (active()) finish(false);
      });
    } catch {
      finish(false);
    }
  };
  const metadata = () => {
    if (!active() || seeking) return;
    if (!Number.isFinite(el.duration) || el.duration <= 0 || range.endMs > el.duration * 1000)
      return finish(false);
    seeking = true;
    try {
      el.currentTime = range.startMs / 1000;
      // Seeking to zero or to an already-current time need not fire seeked.
      if (!el.seeking) play();
    } catch {
      finish(false);
    }
  };

  if (deps.signal.aborted) return cancel;
  if (
    !Number.isFinite(range.startMs) ||
    !Number.isFinite(range.endMs) ||
    range.startMs < 0 ||
    range.endMs <= range.startMs ||
    !Number.isFinite(deps.timeoutMs) ||
    deps.timeoutMs <= 0
  ) {
    finish(false);
    return cancel;
  }
  listen("loadedmetadata", metadata);
  listen("seeked", () => {
    if (seeking) play();
  });
  listen("playing", () => {
    if (!active()) return cancel();
    if (!playing) deps.started?.();
    playing = true;
    if (timer !== undefined) clock.clearTimer(timer);
    timer = clock.timer(() => finish(false), deps.timeoutMs + range.endMs - range.startMs);
    if (frame === undefined) frame = clock.frame(check);
  });
  listen("timeupdate", () => {
    if (active() && playing && el.currentTime * 1000 >= range.endMs) finish(true);
  });
  listen("ended", () => finish(playing && el.currentTime * 1000 >= range.endMs));
  listen("error", () => finish(false));
  deps.signal.addEventListener("abort", cancel, { once: true });
  removers.push(() => deps.signal.removeEventListener("abort", cancel));
  timer = clock.timer(() => finish(false), deps.timeoutMs);
  if (el.readyState >= 1) metadata();
  return cancel;
}

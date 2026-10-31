/**
 * The <audio> elements that play word clips on /words (WordsClient.tsx), reused.
 *
 * Each clip used to get a fresh `new Audio(url)`, routed through
 * `createMediaElementSource → GainNode → destination` so it could fade out
 * (iOS ignores `volume` on media elements). Those nodes stay connected to the
 * page's one AudioContext, and the graph keeps them, and with them every
 * element, alive for the life of the page: a soak run held 260 elements and
 * 260 gain nodes after two minutes of study and kept adding about 120 a minute,
 * so a phone slowed down after ten minutes until the app was restarted.
 *
 * An element can be given to createMediaElementSource only once, so each one
 * here is wired once and then reused for clip after clip: a clip takes an idle
 * element (not playing, not fading out), and only when every element is busy
 * is a new one made, up to `max`. Past that the oldest is stopped and taken.
 * The pool therefore holds at most `max` elements and as many gain nodes.
 *
 * `dispose()` (docs/hot-core.md, step 0) stops each clip, disconnects its
 * `source → gain → destination` chain and empties its element (`src` removed,
 * `load()`). After that `take` hands out a silent stand-in and `fadeOut` does
 * nothing, so a caller still holding the pool or an old clip wires nothing new.
 *
 * Disconnecting is not enough to free an element: Chromium's running
 * AudioContext keeps every element that was ever given to
 * createMediaElementSource, and its source node, until the context closes
 * (scripts/qa/clip-pool-gc.ts, 2026-10-31: 40 of 40 elements alive after 20
 * disposed pools; 0 of 40 once the context was closed). The page never closes
 * its one context. So a disposed pool leaves its wired elements, with their
 * source nodes, as spares on the AudioContext itself, and the next pool on that
 * context adopts them before making new ones. Pools that replace each other,
 * such as a hot swap, then share one set of elements: at most `max` per pool
 * alive at the same time, never one set per pool ever made.
 *
 * Pure: the browser is passed in, so the pool is unit-tested with fakes
 * (unit/words-clip-pool.test.ts).
 */

export type GainLike = {
  gain: {
    value: number;
    cancelScheduledValues(t: number): void;
    setValueAtTime(v: number, t: number): void;
    linearRampToValueAtTime(v: number, t: number): void;
  };
  connect(n: unknown): unknown;
  disconnect?(): void;
};

export type SourceLike = { connect(n: unknown): unknown; disconnect?(): void };

export type CtxLike = {
  currentTime: number;
  destination: unknown;
  createGain(): GainLike;
  createMediaElementSource?(el: unknown): SourceLike;
};

export type ElementLike = {
  src: string;
  paused: boolean;
  ended?: boolean;
  onended: unknown;
  onerror: unknown;
  onplaying?: unknown;
  pause(): void;
  play(): Promise<void>;
  removeAttribute?(name: string): void;
  load?(): void;
};

export type Clip<E extends ElementLike = ElementLike> = {
  el: E;
  /** Its fade, when Web Audio took it. */
  gain: GainLike | null;
  /** The element's one MediaElementAudioSourceNode, kept so dispose can disconnect it. */
  source: SourceLike | null;
  /** The pending stop of a fade-out: busy until then. */
  fading: ReturnType<typeof setTimeout> | null;
};

export type ClipPool<E extends ElementLike = ElementLike> = {
  /** An element ready to play `url`, at full volume. */
  take(url: string): Clip<E>;
  /** Fade a playing clip out over `seconds`, then stop it; it is idle again after. */
  fadeOut(c: Clip<E> | null, seconds: number): void;
  /** How many elements exist (for tests and the soak). */
  size(): number;
  /** Stop every clip and release its element and nodes; the pool is inert after. */
  dispose(): void;
  readonly disposed: boolean;
};

/** Where a context keeps the wired elements of disposed pools. */
const SPARES = Symbol.for("lk.clip-pool.spares");
type Spare = { el: unknown; source: SourceLike };
function sparesOf(ac: CtxLike): Spare[] {
  const o = ac as CtxLike & { [SPARES]?: Spare[] };
  return (o[SPARES] ??= []);
}

/** How many wired elements wait on `ac` for the next pool (tests and the probe). */
export const spareCount = (ac: CtxLike) => sparesOf(ac).length;

export function createClipPool<E extends ElementLike>(d: {
  element: () => E;
  ctx: () => CtxLike | null;
  max?: number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (t: ReturnType<typeof setTimeout>) => void;
}): ClipPool<E> {
  const max = d.max ?? 4;
  const st = d.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const ct = d.clearTimeout ?? ((t) => clearTimeout(t));
  const clips: Clip<E>[] = [];
  let disposed = false;

  const make = (): Clip<E> => {
    let ac: CtxLike | null = null;
    try {
      ac = d.ctx();
    } catch {}
    // An element a disposed pool wired to this context: already has its source.
    const spare = ac ? sparesOf(ac).pop() : undefined;
    if (spare && ac) {
      try {
        const g = ac.createGain();
        spare.source.connect(g);
        g.connect(ac.destination);
        return { el: spare.el as E, gain: g, source: spare.source, fading: null };
      } catch {
        // The context refused: fall through to a fresh element.
      }
    }
    const el = d.element();
    let gain: GainLike | null = null;
    let source: SourceLike | null = null;
    try {
      if (ac?.createMediaElementSource) {
        const g = ac.createGain();
        source = ac.createMediaElementSource(el);
        source.connect(g);
        g.connect(ac.destination);
        gain = g;
      }
    } catch {
      // Web Audio refused the element: it plays unfaded.
    }
    return { el, gain, source, fading: null };
  };

  const idle = (c: Clip<E>) => c.fading === null && (c.el.paused || !!c.el.ended);

  const stop = (c: Clip<E>) => {
    if (c.fading !== null) ct(c.fading);
    c.fading = null;
    c.el.onended = null;
    c.el.onerror = null;
    c.el.onplaying = null;
    c.el.pause();
  };

  const quiet = (f: () => void) => {
    try {
      f();
    } catch {}
  };

  /** What `take` hands out once the pool is disposed: plays nothing, reports "not played". */
  const silent = (url: string): Clip<E> => {
    const el = {
      src: url,
      paused: true,
      ended: false,
      onended: null as unknown,
      onerror: null as unknown,
      onplaying: null as unknown,
      pause() {},
      play() {
        // Like a clip that failed to load: the caller's onerror moves on.
        queueMicrotask(() => {
          if (typeof el.onerror === "function") (el.onerror as () => void)();
        });
        return Promise.resolve();
      },
    };
    return { el: el as unknown as E, gain: null, source: null, fading: null };
  };

  return {
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      let ac: CtxLike | null = null;
      try {
        ac = d.ctx();
      } catch {}
      for (const c of clips.splice(0)) {
        quiet(() => stop(c));
        quiet(() => c.source?.disconnect?.());
        quiet(() => c.gain?.disconnect?.());
        quiet(() => c.el.removeAttribute?.("src"));
        quiet(() => c.el.load?.());
        // Wired once, kept by the context anyway: leave it for the next pool.
        if (c.source && ac) sparesOf(ac).push({ el: c.el, source: c.source });
        c.source = null;
        c.gain = null;
      }
    },
    take(url) {
      if (disposed) return silent(url);
      let c = clips.find(idle);
      if (!c && clips.length < max) clips.push((c = make()));
      if (!c) {
        // Every element busy: take the oldest, and move it to the back.
        c = clips.shift()!;
        clips.push(c);
      }
      stop(c);
      if (c.gain) {
        const now = d.ctx()?.currentTime ?? 0;
        c.gain.gain.cancelScheduledValues(now);
        c.gain.gain.setValueAtTime(1, now);
      }
      c.el.src = url;
      return c;
    },
    fadeOut(c, seconds) {
      if (disposed || !c || c.el.paused || c.fading !== null) return;
      c.el.onended = null;
      c.el.onerror = null;
      const ac = d.ctx();
      if (!c.gain || !ac) return void c.el.pause();
      const now = ac.currentTime;
      c.gain.gain.cancelScheduledValues(now);
      c.gain.gain.setValueAtTime(c.gain.gain.value, now);
      c.gain.gain.linearRampToValueAtTime(0, now + seconds);
      c.fading = st(
        () => {
          c.fading = null;
          c.el.pause();
        },
        seconds * 1000 + 30,
      );
    },
    size: () => clips.length,
  };
}

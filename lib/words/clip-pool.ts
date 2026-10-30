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
};

export type CtxLike = {
  currentTime: number;
  destination: unknown;
  createGain(): GainLike;
  createMediaElementSource?(el: unknown): { connect(n: unknown): unknown };
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
};

export type Clip<E extends ElementLike = ElementLike> = {
  el: E;
  /** Its fade, when Web Audio took it. */
  gain: GainLike | null;
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
};

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

  const make = (): Clip<E> => {
    const el = d.element();
    let gain: GainLike | null = null;
    try {
      const ac = d.ctx();
      if (ac?.createMediaElementSource) {
        const g = ac.createGain();
        ac.createMediaElementSource(el).connect(g);
        g.connect(ac.destination);
        gain = g;
      }
    } catch {
      // Web Audio refused the element: it plays unfaded.
    }
    return { el, gain, fading: null };
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

  return {
    take(url) {
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
      if (!c || c.el.paused || c.fading !== null) return;
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

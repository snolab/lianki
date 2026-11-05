/**
 * "Keep speaker awake": a very low noise bed, played while the page speaks or
 * the mic is on, so the output device is awake when speech starts
 * (docs/voice-mode.md, "Keep speaker awake").
 *
 * Why: the owner hears the first sound of each line cut (2026-11-05), on
 * /words and outside Lianki too. The clips are whole and Chromium's graph
 * loses nothing (measured, same doc), so the suspect is the device itself: a
 * speaker amp or Bluetooth link that sleeps on digital silence and wakes only
 * on the first real sound. The recorded voices start with hundreds of ms of
 * literal zeros, so nothing wakes it early. Unproven until he has listened.
 *
 * Rules:
 * - Started only inside a user gesture. A line with no gesture just plays,
 *   with no bed and no wait; the next tap while it plays (or while the mic is
 *   on) starts the bed.
 * - Runs while a line is due or playing and LINGER_MS after, or while the mic
 *   is on. Each stop closes its AudioContext, so none is left running.
 * - PREROLL_MS: `begin()` says how long the caller waits before the first
 *   line, so the device has woken first. Never longer, even if the context is
 *   slow to run: speech is not held hostage by the bed.
 * - Its own context, connected only to that context's destination: the same
 *   device as the clips (nothing in the app sets a sinkId), and no path into
 *   the mic's graph. It never touches page-audio: no mic hold, no echo guard.
 *
 * Pure: the browser is passed in (unit/output-bed.test.ts). One bed per page,
 * on globalThis, so the app bundle and a hot-loaded widget share it. Small, so
 * /words can import it statically.
 */
import { pageAudio } from "./page-audio";

/** Device-local (docs/prefs-sync.md): the speaker and the route belong to the device. */
export const KEEP_AWAKE_KEY = "lk:voice-keep-awake";
/** The noise's peak. White, so its RMS sits about 4.8 dB under this. */
export const BED_DBFS = -72;
export const PREROLL_MS = 300;
/** After the last line: a card's thinking time, so each card does not wait out a pre-roll. */
export const LINGER_MS = 60_000;
/** Where the browser has no navigator.userActivation: how long a tap counts as "now". */
export const GESTURE_MS = 1_000;

const GESTURES = ["pointerdown", "pointerup", "touchend", "keydown"] as const;

export type BedCtx = {
  state?: string;
  sampleRate: number;
  destination: unknown;
  createBuffer(channels: number, length: number, rate: number): {
    getChannelData(c: number): Float32Array;
  };
  createBufferSource(): {
    buffer: unknown;
    loop: boolean;
    connect(n: unknown): unknown;
    start(): void;
    stop(): void;
    disconnect(): void;
  };
  resume(): Promise<void>;
  close(): Promise<void>;
};

export type BedDeps = {
  makeCtx(): BedCtx | null;
  enabled(): boolean;
  /** The mic is on (page-audio's setMic). */
  micOn(): boolean;
  /** Something is being said now (a long line outlasts LINGER_MS). */
  busy(): boolean;
  /** The page is hidden: a recent tap must not start a bed behind the lock screen. */
  hidden?(): boolean;
  /** The browser's own answer, where it has one (navigator.userActivation.isActive). */
  activation?(): boolean | undefined;
  now?(): number;
  setTimer?(f: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
  random?(): number;
};

export type OutputBed = {
  /** A line is about to be said: ms to wait before it (0: say it now). */
  begin(): number;
  /** A tap or a key press. */
  gesture(): void;
  /** The mic or the setting changed. */
  sync(): void;
  /** The page hides, or the user signs out: stop now, and wait for a new gesture. */
  exit(why: string): void;
  /** `f` runs on each exit (what else on the page should stop running). */
  onExit(f: (why: string) => void): () => void;
  running(): boolean;
};

export function createOutputBed(d: BedDeps): OutputBed {
  const now = d.now ?? (() => Date.now());
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const random = d.random ?? Math.random;
  const exits = new Set<(why: string) => void>();
  let live: { ctx: BedCtx; source: ReturnType<BedCtx["createBufferSource"]>; at: number } | null =
    null;
  let linger: unknown = null;
  let lastGesture = -Infinity;

  const inGesture = () =>
    d.activation?.() === true || now() - lastGesture < GESTURE_MS;

  const quiet = (f: () => void) => {
    try {
      f();
    } catch {}
  };

  const stop = () => {
    if (linger !== null) clearTimer(linger);
    linger = null;
    if (!live) return;
    const { ctx, source } = live;
    live = null;
    quiet(() => source.stop());
    quiet(() => source.disconnect());
    quiet(() => void ctx.close().catch(() => {}));
  };

  const start = () => {
    if (live || d.hidden?.()) return;
    let ctx: BedCtx | null = null;
    try {
      ctx = d.makeCtx();
      if (!ctx) return;
      const amp = 10 ** (BED_DBFS / 20);
      const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (random() * 2 - 1) * amp;
      const source = ctx.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      source.connect(ctx.destination);
      source.start();
      void ctx.resume().catch(() => {});
      live = { ctx, source, at: now() };
    } catch {
      // No bed on this page: speech goes on as it would without one.
      if (ctx) quiet(() => void ctx!.close().catch(() => {}));
      live = null;
    }
  };

  /** Stop after LINGER_MS, unless a line is playing or the mic came on by then. */
  const armLinger = () => {
    if (linger !== null) clearTimer(linger);
    linger = setTimer(() => {
      linger = null;
      if (!live || d.micOn()) return;
      if (d.busy()) return armLinger();
      stop();
    }, LINGER_MS);
  };

  return {
    begin() {
      if (!d.enabled()) return 0;
      if (!live) {
        if (!inGesture()) return 0;
        start();
        if (!live) return 0;
      }
      armLinger();
      return Math.max(0, PREROLL_MS - (now() - live.at));
    },
    gesture() {
      lastGesture = now();
      if (!d.enabled()) return;
      if (live) {
        // Started on a press that is no gesture here (iOS: pointerdown): this one is.
        if (live.ctx.state === "suspended") void live.ctx.resume().catch(() => {});
        return;
      }
      if (d.micOn() || d.busy()) {
        start();
        if (live && !d.micOn()) armLinger();
      }
    },
    sync() {
      if (!d.enabled()) return stop();
      if (!live) {
        if (d.micOn() && inGesture()) start();
        return;
      }
      if (d.micOn()) {
        if (linger !== null) clearTimer(linger);
        linger = null;
      } else if (linger === null) armLinger();
    },
    exit(why) {
      stop();
      lastGesture = -Infinity;
      for (const f of exits) quiet(() => f(why));
    },
    onExit(f) {
      exits.add(f);
      return () => void exits.delete(f);
    },
    running: () => !!live,
  };
}

/** The setting: on unless turned off here. */
export function keepAwakeOn(): boolean {
  try {
    return localStorage.getItem(KEEP_AWAKE_KEY) !== "0";
  } catch {
    return true;
  }
}

const KEY = "__lkOutputBed";
type Globals = Record<string, OutputBed | undefined>;

export function setKeepAwake(on: boolean) {
  try {
    if (on) localStorage.removeItem(KEEP_AWAKE_KEY);
    else localStorage.setItem(KEEP_AWAKE_KEY, "0");
  } catch {}
  (globalThis as unknown as Globals)[KEY]?.sync();
}

/** Sign-out: stop the bed if the page has one (never makes one). */
export function exitOutputBed(why: string) {
  (globalThis as unknown as Globals)[KEY]?.exit(why);
}

const INERT: OutputBed = {
  begin: () => 0,
  gesture() {},
  sync() {},
  exit() {},
  onExit: () => () => {},
  running: () => false,
};

/** The page's bed, listening for gestures and page hide from its first use. */
export function outputBed(): OutputBed {
  const g = globalThis as unknown as Globals;
  const have = g[KEY];
  if (have) return have;
  if (typeof window === "undefined" || typeof document === "undefined") return INERT;
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return INERT;
  const bed = createOutputBed({
    makeCtx: () => new AC() as unknown as BedCtx,
    enabled: keepAwakeOn,
    micOn: () => pageAudio().mic(),
    busy: () =>
      pageAudio().playing() ||
      (typeof speechSynthesis !== "undefined" && speechSynthesis.speaking),
    hidden: () => document.visibilityState === "hidden",
    activation: () =>
      (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
        ?.isActive,
  });
  g[KEY] = bed;
  const tap = () => bed.gesture();
  for (const e of GESTURES) window.addEventListener(e, tap, { capture: true, passive: true });
  window.addEventListener("pagehide", () => bed.exit("pagehide"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") bed.exit("hidden");
  });
  window.addEventListener("storage", (e) => {
    if (e.key === KEEP_AWAKE_KEY) bed.sync();
  });
  pageAudio().subscribe(() => bed.sync());
  return bed;
}

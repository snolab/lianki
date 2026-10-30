"use client";

/**
 * The swipe's headless core for React (docs/swipe-core.md): the gesture,
 * the physics and the grade, as hooks and two contexts. It is built into the
 * app and never hot-swapped; the UI around it is islands (lib/words/islands)
 * that read these contexts and nothing else.
 *
 * Interface v1 (SWIPE_CORE_IFACE), what an island may rely on:
 *
 *   useSwipeFeel(1)  → SwipeFeelValue   the list's feel: tokens, preset, prefs
 *   useSwipeRow(1)   → SwipeRowValue    one slip: phase, level, feel, card slot
 *   useFeelTune(1, tune)               a feel island publishes token overrides
 *
 * An island passes the interface version it was written for; a mismatch
 * throws, and the island's error boundary shows the built-in one. This file
 * is a shared module (lib/islands/rules.ts), so a hot-loaded island reads the
 * page's own contexts.
 */
import { useMotionOff } from "@/lib/motion-pref";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createUiStore, useUi } from "@lianki/ui-state";
import {
  DEFAULT_PREFS,
  FEEL_PREFS_KEY,
  type FeelPrefs,
  type FeelPreset,
  type FeelTweaks,
  type SwipeFeel,
  feelOverride,
  cleanPrefs,
  feelTag,
  parsePrefs,
  resolveFeel,
} from "./swipe-feel";
import {
  type GestureEffect,
  type GestureEvent,
  IDLE,
  type Release,
  type SwipePhase,
  stepGesture,
} from "./swipe-machine";
import { followSwipe, releaseTrajectory, springStep, trajectoryEasing } from "./swipe-physics";
import type { SwipeLevel, SwipeRating } from "./swipe";

/** Bump when a context value's shape or a hook's meaning changes (and the islands' contract versions). */
export const SWIPE_CORE_IFACE = 1;

function checkIface(expects: number) {
  if (expects !== SWIPE_CORE_IFACE)
    throw new Error(`swipe core interface v${SWIPE_CORE_IFACE}, the island expects v${expects}`);
}

// ── Preferences and panel state: UI-state stores (docs/ui-state.md) ───────

/**
 * The feel preset and token tweaks: a device preference that outlives the
 * tab (localStorage, `lk:pref:swipe-feel`). One instance per page, so a
 * hot-swapped island reads and writes the same one.
 */
export const feelPrefsStore = createUiStore(
  "swipe-feel",
  1,
  { preset: DEFAULT_PREFS.preset, tweaks: DEFAULT_PREFS.tweaks },
  // Synced with the account (docs/prefs-sync.md): Heavy swipe and its tuning.
  { storage: "account", clean: cleanPrefs },
);
/** The tuner panel open or not: UI state of this tab (sessionStorage, `lk:ui:swipe-tuner`). */
export const tunerStore = createUiStore("swipe-tuner", 1, { open: false }, { storage: "session" });

// #328 kept all three in `lk:swipe-feel`: carry the preference over once.
try {
  const old = typeof localStorage === "undefined" ? null : localStorage.getItem(FEEL_PREFS_KEY);
  if (old !== null) {
    const p = parsePrefs(old);
    const now = feelPrefsStore.getState();
    if (now.preset === "light" && !Object.keys(now.tweaks).length)
      feelPrefsStore.setState({ preset: p.preset, tweaks: p.tweaks });
    localStorage.removeItem(FEEL_PREFS_KEY);
  }
} catch {}

export function setFeelPrefs(next: FeelPrefs) {
  feelPrefsStore.setState({ preset: next.preset, tweaks: next.tweaks });
  tunerStore.setState({ open: next.tune });
}

/** This device's feel preference (the server and first render see the default). */
export function useFeelPrefs(): FeelPrefs {
  const preset = useUi(feelPrefsStore, (s) => s.preset);
  const tweaks = useUi(feelPrefsStore, (s) => s.tweaks);
  const tune = useUi(tunerStore, (s) => s.open);
  return useMemo(() => ({ preset, tweaks, tune }), [preset, tweaks, tune]);
}

function readPrefs(): FeelPrefs {
  const { preset, tweaks } = feelPrefsStore.getState();
  return { preset, tweaks, tune: tunerStore.getState().open };
}

/** `?feel=` for this page load, read once. */
let override: FeelPreset | null | undefined;
function pageOverride(): FeelPreset | null {
  if (override === undefined) {
    try {
      override = feelOverride(location.search);
    } catch {
      override = null;
    }
  }
  return override;
}

/** For telemetry rows: `feel=heavy` (+N tweaks), or "" on the plain light feel. */
export function feelTagNow(): string {
  try {
    const p = readPrefs();
    return feelTag(pageOverride() ?? p.preset, p.tweaks);
  } catch {
    return "";
  }
}

/** The system's reduced motion, or this device's "Turn off animations" (lib/motion-pref.ts). */
const useReducedMotion = useMotionOff;

// ── The list's feel ────────────────────────────────────────────────────────

export type SwipeFeelValue = {
  iface: 1;
  /** The tokens in force (preset → published tune → this device's tweaks). */
  feel: SwipeFeel;
  preset: FeelPreset;
  /** True while `?feel=` decides the preset for this page load. */
  overridden: boolean;
  prefs: FeelPrefs;
  setPrefs: (p: FeelPrefs) => void;
  reducedMotion: boolean;
  /** For feel islands: publish (or clear, with null) overrides per preset under a source name. */
  publish: (source: string, tune: Partial<Record<FeelPreset, FeelTweaks>> | null) => void;
};

const FeelContext = createContext<SwipeFeelValue | null>(null);

export function SwipeFeelProvider({ children }: { children: ReactNode }) {
  const prefs = useFeelPrefs();
  const reducedMotion = useReducedMotion();
  const [tunes, setTunes] = useState<Record<string, Partial<Record<FeelPreset, FeelTweaks>>>>({});
  const publish = useCallback(
    (source: string, tune: Partial<Record<FeelPreset, FeelTweaks>> | null) =>
      setTunes((t) => {
        const next = { ...t };
        if (tune) next[source] = tune;
        else delete next[source];
        return next;
      }),
    [],
  );
  // The override is read after mount, so the server and the first render agree.
  const [forced, setForced] = useState<FeelPreset | null>(null);
  useEffect(() => setForced(pageOverride()), []);
  const value = useMemo<SwipeFeelValue>(() => {
    const merged: Partial<Record<FeelPreset, FeelTweaks>> = {};
    for (const t of Object.values(tunes))
      for (const [k, v] of Object.entries(t) as [FeelPreset, FeelTweaks][])
        merged[k] = { ...merged[k], ...v };
    return {
      iface: 1,
      feel: resolveFeel(prefs, merged, forced),
      preset: forced ?? prefs.preset,
      overridden: forced !== null,
      prefs,
      setPrefs: setFeelPrefs,
      reducedMotion,
      publish,
    };
  }, [prefs, tunes, forced, reducedMotion, publish]);
  return <FeelContext.Provider value={value}>{children}</FeelContext.Provider>;
}

const LIGHT_FALLBACK: SwipeFeelValue = {
  iface: 1,
  feel: resolveFeel(DEFAULT_PREFS),
  preset: "light",
  overridden: false,
  prefs: DEFAULT_PREFS,
  setPrefs: setFeelPrefs,
  reducedMotion: false,
  publish: () => {},
};

/** The list's feel; outside a SwipeFeelProvider, the light preset. */
export function useSwipeFeel(expects: number): SwipeFeelValue {
  checkIface(expects);
  return useContext(FeelContext) ?? LIGHT_FALLBACK;
}

/** A feel island's tuning: in force while the island is mounted. */
export function useFeelTune(
  expects: number,
  source: string,
  tune: Partial<Record<FeelPreset, FeelTweaks>>,
) {
  const { publish } = useSwipeFeel(expects);
  const json = JSON.stringify(tune);
  useEffect(() => {
    publish(source, JSON.parse(json));
    return () => publish(source, null);
  }, [publish, source, json]);
}

// ── One slip ──────────────────────────────────────────────────────────────

export type CardBind = {
  ref: (el: HTMLElement | null) => void;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
};

/** What a card island renders: the element the core moves, and what goes inside it. */
export type CardSlot = {
  bind: CardBind;
  index: number;
  className: string;
  style: React.CSSProperties;
  children: ReactNode;
};

export type SwipeRowValue = {
  iface: 1;
  /** "js": the core moves the card (WordRow); "native": the browser scrolls it (NativeSlipRow). */
  variant: "js" | "native";
  phase: SwipePhase;
  feel: SwipeFeel;
  reducedMotion: boolean;
  /** The js variant's card; null for native, whose scroller is built in. */
  card: CardSlot | null;
};

const RowContext = createContext<SwipeRowValue | null>(null);

export function SwipeRowProvider({
  value,
  children,
}: {
  value: SwipeRowValue;
  children: ReactNode;
}) {
  return <RowContext.Provider value={value}>{children}</RowContext.Provider>;
}

/** The slip this island is part of. Throws outside one (the boundary falls back). */
export function useSwipeRow(expects: number): SwipeRowValue {
  checkIface(expects);
  const v = useContext(RowContext);
  if (!v) throw new Error("useSwipeRow outside a SwipeRowProvider");
  return v;
}

export type GestureOptions = {
  /** Travel unit: the row's height, px. */
  a: number;
  feel: SwipeFeel;
  reducedMotion: boolean;
  holdMs: number;
  /** The list is (or just was) scrolling: a touch now only catches it. */
  scrolling?: () => boolean;
  onTap: (at: number) => void;
  onSwipe: (r: SwipeRating) => void;
  onSwipeStart?: () => void;
  onHold?: () => void;
  onHoldEnd?: () => void;
  /** The slip starts sliding (e.g. put the grade strip under it). */
  onSlide?: (el: HTMLElement) => void;
  /** It crossed into another level. */
  onLevel?: (k: SwipeLevel) => void;
  /** Every release, graded or not (telemetry). */
  onRelease?: (r: Release) => void;
  perf?: { start: () => void; stop: (kind: string) => void };
};

/**
 * The js variant's gesture on one card: pointer events in, the card's
 * transform out — written straight to the element once a frame (a React
 * render per move dropped frames on Android). React state changes only with
 * the phase. `pos(now)` is where the card is at a moment, for its cords.
 */
export function useSwipeGesture(opts: GestureOptions) {
  const o = useRef(opts);
  o.current = opts;
  const [phase, setPhase] = useState<SwipePhase>("idle");
  const g = useRef(IDLE);
  const el = useRef<HTMLElement | null>(null);
  const pos = useRef<(now: number) => number>(() => 0);
  const shown = useRef({ x: 0, v: 0, t: 0 });
  const target = useRef(0);
  const frame = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const detach = useRef<(() => void) | null>(null);

  const write = (x: number) => {
    const node = el.current;
    if (!node) return;
    // Translate only, never a tilt (the owner, 2026-10-30).
    node.style.transform = x ? `translateX(${x}px)` : "";
  };

  const paint = (now: number) => {
    frame.current = 0;
    const { feel, reducedMotion } = o.current;
    const s = shown.current;
    if (feel.followOmega > 0 && !reducedMotion) {
      const dt = Math.min(0.05, s.t ? (now - s.t) / 1000 : 1 / 60);
      const w = feel.followOmega;
      const n = springStep(s.x, s.v, target.current, dt, {
        mass: 1,
        stiffness: w * w,
        damping: 2 * w,
      });
      shown.current = { x: n.x, v: n.v, t: now };
      if (Math.abs(n.x - target.current) > 0.1 || Math.abs(n.v) > 1)
        frame.current = requestAnimationFrame(paint);
      else shown.current = { x: target.current, v: 0, t: now };
    } else shown.current = { x: target.current, v: 0, t: now };
    write(shown.current.x);
  };

  /** Back home along the release path, run by the compositor as a CSS easing. */
  const goHome = (vPerMs: number) => {
    const node = el.current;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const x0 = shown.current.x;
    shown.current = { x: 0, v: 0, t: 0 };
    target.current = 0;
    const done = () => run({ type: "settled" });
    clearTimeout(settleTimer.current);
    if (node && x0 && !o.current.reducedMotion) {
      const tr = releaseTrajectory(x0, vPerMs * 1000, o.current.feel);
      const easing = trajectoryEasing(tr, x0);
      if (easing) {
        node.style.transition = `transform ${tr.seconds.toFixed(3)}s ${easing}`;
        const t0 = performance.now();
        pos.current = (now) => tr.at((now - t0) / 1000);
        settleTimer.current = setTimeout(done, tr.seconds * 1000);
      } else settleTimer.current = setTimeout(done, 0);
    } else {
      if (node) node.style.transition = "none";
      pos.current = () => 0;
      settleTimer.current = setTimeout(done, 0);
    }
    write(0);
    if (node) node.style.willChange = "";
  };

  const apply = (effects: GestureEffect[], at: number) => {
    const p = o.current;
    const release = effects.find((f) => f.type === "release");
    for (const f of effects) {
      switch (f.type) {
        case "armHold":
          clearTimeout(holdTimer.current);
          holdTimer.current = setTimeout(() => run({ type: "hold" }), p.holdMs);
          break;
        case "disarmHold":
          clearTimeout(holdTimer.current);
          break;
        case "slide": {
          const node = el.current;
          clearTimeout(settleTimer.current);
          if (node) {
            node.style.transition = "none";
            node.style.willChange = "transform";
            p.onSlide?.(node);
          }
          shown.current = { x: 0, v: 0, t: 0 };
          pos.current = () => shown.current.x;
          p.onSwipeStart?.();
          break;
        }
        case "level":
          p.onLevel?.(f.level);
          break;
        case "follow":
          target.current = followSwipe(f.finger, p.feel, p.a);
          frame.current ||= requestAnimationFrame(paint);
          break;
        case "holdStart":
          p.onHold?.();
          break;
        case "holdEnd":
          p.onHoldEnd?.();
          break;
        case "tap":
          p.onTap(at);
          break;
        case "return":
          goHome(release?.type === "release" ? release.release.v : 0);
          break;
        case "release":
          p.onRelease?.(f.release);
          if (f.release.rating) p.onSwipe(f.release.rating);
          break;
      }
    }
  };

  const run = (e: GestureEvent, at = 0) => {
    const r = stepGesture(g.current, e, o.current.a);
    const was = g.current.phase;
    g.current = r.state;
    apply(r.effects, at);
    if (r.state.phase !== was) setPhase(r.state.phase);
  };

  // touch-action: pan-y alone does not hold: iOS Safari still takes over a
  // sideways drag that wanders vertically. A non-passive touchmove keeps the
  // page from scrolling once the gesture is sideways — and while it is
  // undecided but leaning sideways, since a started scroll can't be stopped.
  const ref = useCallback((node: HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    el.current = node;
    if (!node) return;
    let x0 = 0;
    let y0 = 0;
    const down = (e: TouchEvent) => {
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
    };
    const move = (e: TouchEvent) => {
      const axis = g.current.axis;
      if (axis === "v" || !e.cancelable) return;
      const dx = Math.abs(e.touches[0].clientX - x0);
      const dy = Math.abs(e.touches[0].clientY - y0);
      if (axis === "h" || dx > dy) e.preventDefault();
    };
    node.addEventListener("touchstart", down, { passive: true });
    node.addEventListener("touchmove", move, { passive: false });
    detach.current = () => {
      node.removeEventListener("touchstart", down);
      node.removeEventListener("touchmove", move);
    };
  }, []);

  useEffect(
    () => () => {
      clearTimeout(holdTimer.current);
      clearTimeout(settleTimer.current);
      cancelAnimationFrame(frame.current);
    },
    [],
  );

  const kind = () => {
    const s = g.current;
    return s.phase === "dragging" ? "swipe" : s.phase === "scrolling" ? "scroll" : "tap";
  };
  const bind: CardBind = {
    ref,
    onPointerDown: (e) => {
      o.current.perf?.start();
      // Keep receiving the gesture even if the finger leaves this card.
      e.currentTarget.setPointerCapture(e.pointerId);
      run({
        type: "down",
        x: e.clientX,
        y: e.clientY,
        t: performance.now(),
        catching: o.current.scrolling?.() ?? false,
      });
    },
    onPointerMove: (e) => {
      if (g.current.phase === "idle" || g.current.phase === "settling") return;
      run({ type: "move", x: e.clientX, y: e.clientY, t: performance.now() });
    },
    onPointerUp: (e) => {
      o.current.perf?.stop(kind());
      run({ type: "up", t: performance.now() }, e.timeStamp);
    },
    onPointerCancel: () => {
      const s = g.current;
      o.current.perf?.stop(s.phase === "dragging" ? "swipe-cancel" : "scroll");
      run({ type: "cancel" });
    },
  };
  return { phase, pos, bind };
}

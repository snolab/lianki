/**
 * The touch swipe's gesture, as a pure state machine (the headless core,
 * docs/swipe-core.md). The row feeds it pointer events and acts on the
 * effects it returns; nothing here reads the DOM or a clock.
 *
 *   idle ─down→ pressed ─(sideways past the slop)→ dragging ─up→ settling ─settled→ idle
 *                  │  └─(steep)→ scrolling ─up→ idle
 *                  └─(held HOLD)→ holding ─up→ idle
 *
 * The rules are WordRow's, unchanged: one axis per gesture (lockAxis), a
 * hold never grades, a touch on a moving list only catches it, the grade is
 * releaseRating's (lib/words/swipe.ts).
 */
import {
  type Axis,
  type SwipeLevel,
  type SwipeRating,
  SWIPE_VELOCITY_MS,
  lockAxis,
  releaseLevel,
  releaseRating,
  releaseVelocity,
  swipeLevel,
} from "./swipe";

export type SwipePhase = "idle" | "pressed" | "dragging" | "scrolling" | "holding" | "settling";

export type GestureState = {
  phase: SwipePhase;
  x0: number;
  y0: number;
  axis: Axis | null;
  level: SwipeLevel;
  /** The finger's sideways travel, px. */
  finger: number;
  samples: { t: number; x: number }[];
  /** The touch landed on a list still scrolling: it stops the fling, nothing more. */
  catching: boolean;
};

export type GestureEvent =
  | { type: "down"; x: number; y: number; t: number; catching: boolean }
  | { type: "move"; x: number; y: number; t: number }
  | { type: "hold" }
  | { type: "up"; t: number }
  | { type: "cancel" }
  | { type: "settled" };

export type Release = {
  finger: number;
  /** px/ms at the lift. */
  v: number;
  /** Where the coast would put it, px (for telemetry). */
  projected: number;
  rating: SwipeRating | null;
};

export type GestureEffect =
  | { type: "armHold" }
  | { type: "disarmHold" }
  /** The gesture went sideways: the slip starts sliding. */
  | { type: "slide" }
  | { type: "level"; level: SwipeLevel }
  | { type: "follow"; finger: number }
  | { type: "holdStart" }
  | { type: "holdEnd" }
  | { type: "tap" }
  /** Back home (always after a slide, graded or not). */
  | { type: "return" }
  | { type: "release"; release: Release };

export const IDLE: GestureState = {
  phase: "idle",
  x0: 0,
  y0: 0,
  axis: null,
  level: 0,
  finger: 0,
  samples: [],
  catching: false,
};

export function stepGesture(
  s: GestureState,
  e: GestureEvent,
  a: number,
): { state: GestureState; effects: GestureEffect[] } {
  const fx: GestureEffect[] = [];
  const out = (state: GestureState) => ({ state, effects: fx });
  switch (e.type) {
    case "down":
      if (!e.catching) fx.push({ type: "armHold" });
      return out({
        ...IDLE,
        phase: "pressed",
        x0: e.x,
        y0: e.y,
        samples: [{ t: e.t, x: 0 }],
        catching: e.catching,
      });
    case "move": {
      if (s.phase !== "pressed" && s.phase !== "dragging") return out(s);
      const x = e.x - s.x0;
      let next = s;
      if (s.phase === "pressed") {
        const axis = lockAxis(x, e.y - s.y0);
        if (!axis) return out(s);
        fx.push({ type: "disarmHold" });
        if (axis === "v") return out({ ...s, axis, phase: "scrolling" });
        fx.push({ type: "slide" });
        next = { ...s, axis, phase: "dragging" };
      }
      const samples = next.samples.filter((p) => e.t - p.t <= SWIPE_VELOCITY_MS * 2);
      samples.push({ t: e.t, x });
      const level = swipeLevel(x, next.level, a);
      if (level !== next.level) fx.push({ type: "level", level });
      fx.push({ type: "follow", finger: x });
      return out({ ...next, finger: x, samples, level });
    }
    case "hold":
      if (s.phase !== "pressed") return out(s);
      fx.push({ type: "holdStart" });
      return out({ ...s, phase: "holding" });
    case "up": {
      fx.push({ type: "disarmHold" });
      if (s.phase === "holding") {
        fx.push({ type: "holdEnd" });
        return out({ ...s, phase: "idle" });
      }
      if (s.phase === "dragging") {
        const v = releaseVelocity(s.samples, e.t);
        const rating = releaseRating(s.finger, v, s.level, a);
        const projected = releaseLevel(s.finger, v, s.level, a) * a;
        fx.push({ type: "return" });
        fx.push({ type: "release", release: { finger: s.finger, v, projected, rating } });
        return out({ ...s, phase: "settling" });
      }
      if (s.phase === "pressed" && !s.catching) fx.push({ type: "tap" });
      return out({ ...s, phase: "idle" });
    }
    case "cancel":
      fx.push({ type: "disarmHold" });
      if (s.phase === "holding") fx.push({ type: "holdEnd" });
      if (s.phase === "dragging") {
        fx.push({ type: "return" });
        return out({ ...s, phase: "settling" });
      }
      return out({ ...s, phase: "idle" });
    case "settled":
      return out(s.phase === "settling" ? { ...s, phase: "idle" } : s);
  }
}

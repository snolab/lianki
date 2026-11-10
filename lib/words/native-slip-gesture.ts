"use client";

/**
 * The New swipe's gesture (variant B, lib/words/swipe-ab.ts), shared by the
 * /words slip (NativeSlipRow in app/(app)/words/WordsClient.tsx) and the
 * /read reader's items (app/(app)/reader/[id]/reader-blocks.tsx): each row is
 * its own horizontal scroller (the slip prototype, since deleted). The browser locks
 * the axis, follows the finger, coasts, snaps to the levels at 0, ±a, ±2a and
 * stops hard at ±2a — all on the compositor; script runs only as a gesture
 * starts and ends. The rest rules are lib/words/native-slip.ts; the grades
 * lib/words/swipe.ts. The scroller's parent holds the grade strip
 * (`[data-swipe-strip]`), which `showReveal` points at the level.
 */
import { type RefObject, useEffect, useRef, useState } from "react";
import type { SwipeFeel } from "./swipe-feel";
import type { SwipePhase } from "./swipe-machine";
import { releaseTrajectory } from "./swipe-physics";
import {
  type SwipeLevel,
  type SwipeRating,
  lockAxis,
  releaseLevel,
  releaseRating,
  releaseVelocity,
  restRating,
  revealShownSide,
  swipeLevel,
  SWIPE_VELOCITY_MS,
} from "./swipe";
import { GLIDE_WATCH_MS, homeStep, onDetent } from "./native-slip";
import { onPageLeave } from "@/lib/page-leave";

/** The tuning tag of the New swipe in telemetry rows. */
export const NATIVE_PARAMS = "scroll-snap";

/**
 * Point a grade-zones container (SwipeGrades) at level `k`: which grade each
 * side shows. A container marked data-mirror shows the other side's grades.
 */
export function showReveal(el: HTMLElement | null | undefined, k: number) {
  if (!el) return;
  const s = revealShownSide(k, el.dataset.mirror !== undefined);
  if (el.dataset.good !== String(s.good)) el.dataset.good = String(s.good);
  if (el.dataset.hard !== String(s.hard)) el.dataset.hard = String(s.hard);
}

/** One swipe telemetry row, as /words logs it (WordsClient logSwipe). */
export type SwipeLogRow = {
  finger: number;
  v: number;
  projected: number;
  rating: SwipeRating | null;
  a: number;
  params?: string;
};

export type NativeSlipOptions = {
  onTap: (at: number) => void;
  onSwipe: (r: SwipeRating) => void;
  onSwipeStart?: () => void;
  /** The level the reveal shows changed (−2…2, the default side's; 0: home). */
  onReveal?: (k: number) => void;
  onHold?: () => void;
  onHoldEnd?: () => void;
  /** The list is (or just was) scrolling: a touch now only catches it. */
  scrolling?: () => boolean;
  /** The row may not slide or grade ("↓ back", lib/words/requeue.ts). */
  locked?: () => boolean;
  feel: SwipeFeel;
  reducedMotion: boolean;
  holdMs: number;
  log?: (row: SwipeLogRow) => void;
  perf?: { start: () => void; stop: (kind: string) => void };
};

/**
 * Runs the New swipe on `scroller` (its track is 2a of slack, the face, 2a
 * of slack); `a` is the travel unit. Returns the gesture's phase, for the
 * lift cue: it changes only as a gesture starts and ends. The listeners are
 * attached once per `a`; they call the latest options.
 */
export function useNativeSlip(
  scroller: RefObject<HTMLElement | null>,
  a: number,
  opts: NativeSlipOptions,
): SwipePhase {
  const [phase, setPhase] = useState<SwipePhase>("idle");
  const props = useRef(opts);
  props.current = opts;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const home = 2 * a;
    /**
     * One gesture's state. `panned`: the browser took the touch over
     * (pointercancel) — a slide or a list scroll; `moved`: this slip scrolled
     * under the finger — a slide; `caught`: the touch landed on a slip
     * still gliding home.
     */
    const g = {
      touching: false,
      panned: false,
      moved: false,
      caught: false,
      /** A steep drag: a scroll, never a grade (lockAxis, as WordRow). */
      steep: false,
      returning: false,
      held: false,
      catching: false,
      x0: 0,
      y0: 0,
      finger: 0,
      hold: undefined as ReturnType<typeof setTimeout> | undefined,
      /** The level the slide is on (hysteresis, as WordRow), for the spring release. */
      level: 0 as SwipeLevel,
      /** Recent offsets while the finger is down, for the release velocity. */
      samples: [] as { t: number; x: number }[],
      /** The spring release's frame while it runs (feel.nativeRelease). */
      springing: 0,
      /** Glides home started for this rest (lib/words/native-slip.ts, homeStep). */
      glides: 0,
      /** Looks again after a glide home, in case it was cancelled with no scrollend. */
      watch: undefined as ReturnType<typeof setTimeout> | undefined,
      /** When this slip last scrolled (performance.now()). */
      scrolledAt: 0,
    };
    const hasScrollEnd = "onscrollend" in window;
    /**
     * The heavy feel's release (feel.nativeRelease): the browser's coast and
     * snap are stopped at the lift, and the slip follows the core's release
     * path instead (coast under friction, then the spring home), written to
     * scrollLeft once a frame. The grade is decided at the lift, by the same
     * tiers as WordRow's (releaseRating). Returns false when it doesn't apply.
     */
    const springRelease = () => {
      const { feel: f, reducedMotion: still } = props.current;
      if (!f.nativeRelease || !g.moved || g.steep || g.held) return false;
      const offset = home - el.scrollLeft; // + = slid right
      const v = releaseVelocity(g.samples, performance.now());
      const r = releaseRating(offset, v, g.level, a);
      g.panned = g.moved = false;
      props.current.perf?.stop(r ? "swipe" : "swipe-cancel");
      props.current.log?.({
        finger: g.finger,
        v,
        projected: releaseLevel(offset, v, g.level, a) * a,
        rating: r,
        a,
        params: `${NATIVE_PARAMS}+spring`,
      });
      // overflow hidden stops WebKit's momentum; no snap, or each write would re-snap.
      el.style.overflowX = "hidden";
      el.style.scrollSnapType = "none";
      const done = () => {
        g.springing = 0;
        el.scrollLeft = home;
        el.style.overflowX = "";
        el.style.scrollSnapType = "";
        setPhase("idle");
      };
      const tr = releaseTrajectory(offset, v * 1000, f, 2 * a);
      if (still || tr.seconds <= 0) done();
      else {
        setPhase("settling");
        const t0 = performance.now();
        const frame = (now: number) => {
          const t = (now - t0) / 1000;
          if (t >= tr.seconds) return done();
          // The track ends at ±2a: the slip meets it as a wall.
          el.scrollLeft = home - Math.max(-2 * a, Math.min(2 * a, tr.at(t)));
          g.springing = requestAnimationFrame(frame);
        };
        g.springing = requestAnimationFrame(frame);
      }
      if (r) props.current.onSwipe(r);
      return true;
    };
    const glideHome = () => {
      g.returning = true;
      g.glides++;
      el.scrollTo({ left: home, behavior: "smooth" });
      clearTimeout(g.watch);
      g.watch = setTimeout(watch, GLIDE_WATCH_MS);
    };
    /**
     * A glide home stopped (scrollend, or the watch): home, or it stopped
     * short — the browser's own snap after the lift can override the smooth
     * scroll and leave the slip on the first detent — so glide again, and in
     * the end put it home at once. Nothing else would ever move it.
     */
    const backHome = () => {
      const step = homeStep(home - el.scrollLeft, g.glides);
      if (step === "glide") return void glideHome();
      clearTimeout(g.watch);
      g.returning = false;
      g.glides = 0;
      if (step === "jump") el.scrollTo({ left: home, behavior: "instant" });
    };
    /**
     * Looks again a while after a lift or a glide home, in case the browser
     * never sent the scrollend that settles it: a slip lifted off a detent
     * is graded (or not) and sent home, a glide that stopped short goes on.
     * settle() is safe to repeat: a gesture it already took does not grade twice.
     */
    const watch = () => {
      if (g.touching || g.springing) return;
      // Still moving: its own scrollend (or the next look) decides.
      if (performance.now() - g.scrolledAt < 150) {
        g.watch = setTimeout(watch, 150);
        return;
      }
      if (g.returning) backHome();
      else settle();
    };
    /** The scroller came to rest: grade where it landed, then glide home. */
    const settle = () => {
      if (g.touching) return; // still under the finger: the gesture isn't over
      if (g.springing) return; // the spring release has it
      const offset = home - el.scrollLeft; // + = slid right
      if (g.returning) return void backHome();
      g.glides = 0;
      // Only a slide this gesture made grades (not a glide caught by a tap,
      // nor a steep drag the browser let slide anyway).
      const swiped = g.panned && g.moved && !g.steep;
      g.panned = g.moved = false;
      if (g.steep) return void glideHome();
      if (!swiped) return void (Math.abs(offset) >= 1 && glideHome());
      const r = restRating(offset, a);
      props.current.perf?.stop(r ? "swipe" : "swipe-cancel");
      props.current.log?.({
        finger: g.finger,
        v: 0,
        projected: offset,
        rating: r,
        a,
        params: NATIVE_PARAMS,
      });
      if (Math.abs(offset) >= 1) glideHome();
      if (r) props.current.onSwipe(r);
    };
    /** The first scroll under the finger: a slide (a vertical drag never scrolls this). */
    const slid = () => {
      g.moved = true;
      if (g.caught || g.steep) return;
      setPhase("dragging");
      props.current.onSwipeStart?.();
    };
    const touchstart = (e: TouchEvent) => {
      g.touching = true;
      // A slip still springing home finishes its path: this touch only catches it.
      g.caught = g.returning || !!g.springing;
      g.returning = false;
      g.glides = 0;
      clearTimeout(g.watch);
      g.panned = g.moved = false;
      g.x0 = e.touches[0].clientX;
      g.y0 = e.touches[0].clientY;
      g.finger = 0;
      // A locked slip ("↓ back", asked now: the label flips on a timer) is
      // held as a steep drag is: it can't scroll sideways, so it never slides
      // or grades (settle, springRelease); it still taps and holds.
      g.steep = props.current.locked?.() ?? false;
      if (g.steep) el.style.overflowX = "hidden";
      g.level = 0;
      g.samples = [{ t: performance.now(), x: home - el.scrollLeft }];
      if (!g.caught) setPhase("pressed");
      props.current.perf?.start();
      el.addEventListener("scroll", slid, { once: true, passive: true });
      if (!g.steep) el.addEventListener("touchmove", axis, { passive: false });
      leave?.();
      leave = onPageLeave(stolen, { blur: true });
    };
    /** Listens for the page going away while a finger is down (lib/page-leave.ts). */
    let leave: (() => void) | null = null;
    /**
     * The system took the touch: a touchcancel (Android's edge Back, the
     * shade, an app switch) or the page hidden or left mid-gesture. Not a
     * lift: wherever the slip stands, nothing is graded, and it glides home
     * (docs/design-principles.md, "Edge gestures").
     */
    const stolen = () => {
      leave?.();
      leave = null;
      if (!g.touching) return;
      g.touching = false;
      el.removeEventListener("scroll", slid);
      el.removeEventListener("touchmove", axis);
      endHold();
      el.style.overflowX = "";
      const slide = g.moved && !g.caught && !g.steep;
      // settle() grades only a slide this gesture made: there is none now.
      g.panned = g.moved = g.steep = false;
      setPhase("idle");
      props.current.perf?.stop(slide ? "swipe-cancel" : "scroll");
      if (Math.abs(home - el.scrollLeft) >= 1) glideHome();
    };
    /**
     * The browser hands a diagonal drag to this slip when it can scroll that
     * way at all; WordRow's rule is stricter (lockAxis: clearly sideways).
     * Decided once per gesture, before the browser starts scrolling (this
     * listener blocks only until then): a steep drag locks the slip, so the
     * list scrolls instead.
     */
    const axis = (e: TouchEvent) => {
      const t = e.touches[0];
      const locked = t && lockAxis(t.clientX - g.x0, t.clientY - g.y0);
      if (!locked) return;
      el.removeEventListener("touchmove", axis);
      if (locked === "v") {
        g.steep = true;
        el.style.overflowX = "hidden";
        setPhase("scrolling");
      }
    };
    const touchend = (e: TouchEvent) => {
      if (e.touches.length) return;
      leave?.();
      leave = null;
      g.touching = false;
      g.finger = (e.changedTouches[0]?.clientX ?? g.x0) - g.x0;
      el.removeEventListener("scroll", slid);
      el.removeEventListener("touchmove", axis);
      if (g.steep && !g.held) el.style.overflowX = "";
      if (!g.caught && springRelease()) return;
      if (!g.springing) setPhase("idle");
      if (!g.moved) props.current.perf?.stop(g.panned ? "scroll" : "tap");
      // Lifted while resting on a level, nothing more scrolls: no scrollend
      // follows (WebKit fires it while the finger is still down, and settle
      // waited for the lift), and without scrollend the quiet timer has
      // already run. Settle here, or the slip would stay slid off its face,
      // its grade label showing. A slip still coasting is between levels:
      // its own scrollend / quiet timer settles it.
      // On a detent within a physical pixel only: a pixel short, Chrome still
      // snaps it (~200 ms) and that snap would override the glide home; its
      // scrollend settles it instead (lib/words/native-slip.ts).
      setTimeout(() => {
        if (!g.touching && !g.returning && onDetent(el.scrollLeft, a)) settle();
      }, 50);
      clearTimeout(g.watch);
      g.watch = setTimeout(watch, GLIDE_WATCH_MS);
    };
    const pointerdown = () => {
      g.held = false;
      g.catching = props.current.scrolling?.() ?? false;
      clearTimeout(g.hold);
      if (g.catching) return;
      g.hold = setTimeout(() => {
        g.held = true;
        // A hold stays a hold: the slip no longer slides until the finger lifts.
        el.style.overflowX = "hidden";
        props.current.onHold?.();
      }, props.current.holdMs);
    };
    const endHold = () => {
      clearTimeout(g.hold);
      if (!g.held) return false;
      g.held = false;
      el.style.overflowX = "";
      props.current.onHoldEnd?.();
      return true;
    };
    const pointerup = (e: PointerEvent) => {
      if (endHold()) return;
      // The browser never took the touch over: a tap — unless it caught a fling.
      if (!g.panned && !g.catching) props.current.onTap(e.timeStamp);
    };
    const pointercancel = () => {
      // Scrolling began (this slip or the list): not a tap, not a hold.
      g.panned = true;
      if (!g.moved && !g.springing) setPhase("scrolling");
      endHold();
    };
    const snapping = () => g.touching && navigator.vibrate?.(6);
    // Older Safari has no scrollend: no scroll for 150 ms counts as settled.
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const scrolled = () => {
      clearTimeout(quiet);
      quiet = setTimeout(settle, 150);
    };
    // The reveal follows the detent the slip is nearest (the far one's grade
    // takes over the first one's spot).
    const strip = el.parentElement?.querySelector<HTMLElement>("[data-swipe-strip]");
    let shown = 0;
    const reveal = () => {
      g.scrolledAt = performance.now();
      const offset = home - el.scrollLeft;
      const k = Math.max(-2, Math.min(2, Math.round(offset / a)));
      showReveal(strip, k);
      if (k !== shown) {
        shown = k;
        props.current.onReveal?.(k);
      }
      if (!g.touching) return;
      // For the spring release: the level (with hysteresis) and the recent offsets.
      g.level = swipeLevel(offset, g.level, a);
      const t = performance.now();
      g.samples = g.samples.filter((s) => t - s.t <= SWIPE_VELOCITY_MS * 2);
      g.samples.push({ t, x: offset });
    };
    el.addEventListener("scroll", reveal, { passive: true });
    el.addEventListener("touchstart", touchstart, { passive: true });
    el.addEventListener("touchend", touchend, { passive: true });
    el.addEventListener("touchcancel", stolen, { passive: true });
    el.addEventListener("pointerdown", pointerdown);
    el.addEventListener("pointerup", pointerup);
    el.addEventListener("pointercancel", pointercancel);
    el.addEventListener("scrollsnapchanging", snapping);
    if (hasScrollEnd) el.addEventListener("scrollend", settle);
    else el.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      clearTimeout(g.hold);
      clearTimeout(g.watch);
      clearTimeout(quiet);
      cancelAnimationFrame(g.springing);
      el.removeEventListener("touchstart", touchstart);
      el.removeEventListener("touchend", touchend);
      el.removeEventListener("touchcancel", stolen);
      leave?.();
      el.removeEventListener("pointerdown", pointerdown);
      el.removeEventListener("pointerup", pointerup);
      el.removeEventListener("pointercancel", pointercancel);
      el.removeEventListener("scrollsnapchanging", snapping);
      el.removeEventListener("scrollend", settle);
      el.removeEventListener("scroll", scrolled);
      el.removeEventListener("scroll", reveal);
      el.removeEventListener("scroll", slid);
      el.removeEventListener("touchmove", axis);
    };
  }, [a]);
  return phase;
}

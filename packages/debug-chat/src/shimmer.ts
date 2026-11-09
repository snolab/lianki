/**
 * A gentle shimmer on chat text (owner, 2026-11-10), two uses:
 *
 * - **A new line**: a reply that arrived live (not the history loading in)
 *   gets one soft band sweeping across its text, for exactly as long as the
 *   minimized chat keeps a line up to be read (float-lines.ts `dwellMs`, the
 *   one reading-time source), then it is gone. The sweep's timing is fixed
 *   once per line (`createNewLines`), so a re-render never shifts it; a line
 *   drawn again part-way (the chat opened, minimized) picks the sweep up
 *   where it is, by a negative delay.
 * - **A scrub**: ↑/↓ on the mic steps through the minimized history (the mic
 *   itself is push to talk now, ptt.ts);
 *   while it moves, the lines shown pulse with the same band, ending once
 *   the scrub stops moving.
 *
 * The band is a mask (alpha only), so the text's own colour and its halo
 * stay as they are. Its own keyframes, since the hot-loaded widget has no app
 * stylesheet. Off under prefers-reduced-motion and the app's own "Turn off
 * animations" (`data-motion="off"`, lib/motion-pref.ts). Pure but for the
 * CSS: unit/chat-shimmer.test.ts.
 */
import { dwellMs } from "./float-lines";
import { HOLD_MS } from "./log-engage";

/** Set on a line that is shimmering as new. */
export const NEW_ATTR = "data-lk-new";
/** Set on the minimized lines' list while a scrub moves them. */
export const SCRUB_ATTR = "data-lk-scrub";

/**
 * One pass of a scrub's pulse, and how long after the last scrub step it
 * lasts: two of the platform's long-press (log-engage.ts HOLD_MS), so a
 * finger resting still for a long-press's time has stopped the cue.
 */
export const SCRUB_PULSE_MS = 2 * HOLD_MS;

/** The band: the text at full, dimmed to about half under the band. Alpha only. */
const BAND =
  "linear-gradient(90deg, oklch(0 0 0) 40%, oklch(0 0 0 / 0.45) 50%, oklch(0 0 0) 60%)";
const MASK = (at: string) =>
  `-webkit-mask-image:${BAND};mask-image:${BAND};-webkit-mask-size:300% 100%;mask-size:300% 100%;-webkit-mask-position:${at} 0;mask-position:${at} 0`;

/**
 * The keyframes: the band (a mask three times the line's width) from off
 * the start edge to off the end edge. Outside the animation there is no
 * mask, so a finished line is plain text.
 */
export const SHIMMER_CSS =
  `@keyframes lk-shimmer{from{${MASK("100%")}}to{${MASK("0%")}}}` +
  `[${SCRUB_ATTR}] [data-testid="debug-chat-float"]{animation:lk-shimmer ${SCRUB_PULSE_MS}ms ease-in-out infinite}` +
  `@media (prefers-reduced-motion: reduce){[${NEW_ATTR}],[${SCRUB_ATTR}] *{animation:none!important}}` +
  `html[data-motion="off"] [${NEW_ATTR}],html[data-motion="off"] [${SCRUB_ATTR}] *{animation:none!important}`;

/** What a line's element takes while new: the attribute, and its sweep. */
export type Shimmer = { [NEW_ATTR]: true; style: { animation: string } };

/**
 * A new line's shimmer at `now`, it having arrived at `arrivedAt`: one sweep
 * over its reading time, already `now - arrivedAt` along; null once over.
 */
export function newShimmer(text: string, arrivedAt: number, now: number): Shimmer | null {
  const ms = dwellMs(text);
  const elapsed = Math.max(0, now - arrivedAt);
  if (elapsed >= ms) return null;
  return {
    [NEW_ATTR]: true,
    style: { animation: `lk-shimmer ${ms}ms linear -${Math.round(elapsed)}ms 1` },
  };
}

/**
 * Which lines are new, seen at render time (idempotent: a line is recorded
 * once). The first non-empty list is the history: never new. After it, a
 * line from the agent is new from when it was first seen; the user's own
 * lines are not. `shimmer` hands back the same object for a line every
 * render, so React never changes (and so never shifts) its animation.
 */
export function createNewLines() {
  const first = new Map<string, number>();
  const cache = new Map<string, Shimmer | null>();
  let loaded = false;
  return {
    see(messages: readonly { id: string; from: string }[], now: number) {
      if (!messages.length) return;
      for (const m of messages)
        if (!first.has(m.id)) first.set(m.id, loaded && m.from === "agent" ? now : -1);
      loaded = true;
      if (first.size > 2 * messages.length + 100) {
        const ids = new Set(messages.map((m) => m.id));
        for (const id of first.keys())
          if (!ids.has(id)) {
            first.delete(id);
            cache.delete(id);
          }
      }
    },
    /** The line's shimmer (null: history, the user's own, or over). */
    shimmer(m: { id: string; text: string }, now: number): Shimmer | null {
      if (cache.has(m.id)) return cache.get(m.id)!;
      const at = first.get(m.id);
      const s = at === undefined || at < 0 ? null : newShimmer(m.text, at, now);
      // Only a line still shimmering is remembered; null is cheap to compute again.
      if (s) cache.set(m.id, s);
      return s;
    },
    /**
     * When a new line was first seen (undefined: history or the user's own),
     * for an element that fixes its sweep once at its own mount (FloatLine).
     */
    arrivedAt(id: string): number | undefined {
      const at = first.get(id);
      return at === undefined || at < 0 ? undefined : at;
    },
  };
}

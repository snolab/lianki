/**
 * The New swipe's rest rules (NativeSlipRow in app/(app)/words/WordsClient.tsx):
 * when a slip the browser scrolls counts as resting, and what a slip gliding
 * home does when it stops short of home. Pure, for unit/native-slip.test.ts.
 *
 * Why (the owner, Android 10, 2026-11-03: a card stuck "on the first slot"):
 * Chrome lifted the finger a pixel short of a detent (x 43 for 44) and then
 * snapped the last pixel itself, over ~200 ms. The lift's timer took 43 as
 * resting, graded and started the glide home; Chrome's own snap overrode the
 * glide and ended on the detent. The `scrollend` there found the slip
 * "returning" but not home, and waited for a home it was never going to
 * reach. A glide that stops short now glides again, and in the end jumps.
 */

/**
 * The lift's timer settles a slip only this close to a detent (px). Within
 * one physical pixel at Android's fractional DPRs (1 / 2.625 ≈ 0.38 px), so a
 * slip the browser still has to snap is left to the browser's scrollend.
 */
export const DETENT_TOLERANCE_PX = 0.5;

/** `scrollLeft` sits on a detent (a multiple of the row height `a`). */
export function onDetent(scrollLeft: number, a: number, tol = DETENT_TOLERANCE_PX): boolean {
  if (!(a > 0)) return false;
  return Math.abs(scrollLeft - Math.round(scrollLeft / a) * a) < tol;
}

/** Glides home a slip may start after the first, before it is put home at once. */
export const GLIDE_RETRIES = 2;

/**
 * How long after a lift or a glide home the row looks again, in case the
 * browser sent no scrollend at all (ms). Longer than Chrome's smooth scroll
 * over 2a; a slip still moving then is looked at again once it is quiet.
 */
export const GLIDE_WATCH_MS = 1000;

export type HomeStep = "home" | "glide" | "jump";

/**
 * A slip gliding home came to rest `offset` px from home, after `tries`
 * glides. Home (under a pixel): done. Short of it: glide again, or once the
 * retries are spent, put it home without animation. Never "wait": nothing
 * else is going to move it.
 */
export function homeStep(offset: number, tries: number, retries = GLIDE_RETRIES): HomeStep {
  if (Math.abs(offset) < 1) return "home";
  return tries <= retries ? "glide" : "jump";
}

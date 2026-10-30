/**
 * "Turn off animations": one device preference for the whole app
 * (docs/ui-state.md, `lk:pref:motion`). Until it is set, it follows the
 * system's `prefers-reduced-motion`.
 *
 * Off means:
 * - CSS: `<html data-motion="off">`, and app/globals.css stops every
 *   transition and animation (set before first paint: lib/motion-boot.ts).
 * - JS: `motionOff()` / `useMotionOff()` stand in for the reduced-motion
 *   media query wherever the app runs its own frames (the swipe's springs,
 *   the column glide, the slip's cords, the glance, smooth scrolls).
 *
 * The debug chat (packages/debug-chat) cannot import the app; it reads the
 * attribute.
 */
import { useSyncExternalStore } from "react";
import { createUiStore } from "@lianki/ui-state";

/** "system" until the person picks; then their choice, on this device. */
export type MotionChoice = "system" | "off" | "on";

const CHOICES: readonly MotionChoice[] = ["system", "off", "on"];

export const motionStore = createUiStore(
  "motion",
  1,
  { animations: "system" as MotionChoice },
  {
    storage: "local",
    clean: (v) => {
      const a = (v as { animations?: unknown } | null)?.animations;
      return CHOICES.includes(a as MotionChoice) ? { animations: a as MotionChoice } : {};
    },
  },
);

/** The attribute app/globals.css keys on, and the debug chat reads. */
export const MOTION_ATTR = "motion";

const QUERY = "(prefers-reduced-motion: reduce)";

/** The system asks for reduced motion. */
export function systemReducedMotion(): boolean {
  try {
    return typeof matchMedia !== "undefined" && matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/** Animations are off for this choice (pure; the default follows the system). */
export function resolveMotionOff(choice: MotionChoice, systemReduced: boolean): boolean {
  return choice === "system" ? systemReduced : choice === "off";
}

/** Animations are off on this device now. Safe anywhere, the server included (false). */
export function motionOff(): boolean {
  return resolveMotionOff(motionStore.getState().animations, systemReducedMotion());
}

/** Turn animations off (true) or on (false) on this device. */
export function setMotionOff(off: boolean) {
  motionStore.setState({ animations: off ? "off" : "on" });
}

/** The preference as `<html data-motion="off">`, for CSS and the debug chat. */
export function applyMotionAttr(root: { dataset: DOMStringMap } = document.documentElement) {
  if (motionStore.getState().animations === "off") root.dataset[MOTION_ATTR] = "off";
  else delete root.dataset[MOTION_ATTR];
}

/** Keep the attribute in step with the store. Returns the unsubscribe. */
export function installMotionAttr(root?: { dataset: DOMStringMap }) {
  applyMotionAttr(root);
  return motionStore.subscribe(() => applyMotionAttr(root));
}

if (typeof window !== "undefined") installMotionAttr();

/** Listen to the preference and to the system's setting. */
export function subscribeMotion(l: () => void) {
  const unsub = motionStore.subscribe(l);
  let m: MediaQueryList | null = null;
  try {
    m = matchMedia(QUERY);
    m.addEventListener("change", l);
  } catch {}
  return () => {
    unsub();
    m?.removeEventListener("change", l);
  };
}

/** `motionOff()` for React: follows the preference and the system. SSR: false. */
export function useMotionOff(): boolean {
  return useSyncExternalStore(subscribeMotion, motionOff, () => false);
}

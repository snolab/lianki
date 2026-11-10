/**
 * Unlock Li's voice on the page's first real tap, wherever it lands.
 *
 * iOS WebKit drops every speechSynthesis.speak() with no event at all until
 * the page has spoken once inside a user gesture (SpeechSynthesis::speak,
 * RequireUserGestureForSpeechStart), and each page load starts locked again:
 * a debug device's reload after a deploy too. The chat unlocked only on a
 * press on the chat itself, so a reader on /reader who never touched it heard
 * no reply (owner, 2026-11-10 23:48 JST). Now any tap or key on the page
 * unlocks it.
 *
 * A touch's pointerdown is not a user activation (HTML: only its pointerup,
 * touchend, click or a key is), so where the browser says so
 * (`navigator.userActivation`) an event that is not one leaves the listeners
 * in place for the next. Events only, no timers (unit/speech-unlock.test.ts).
 */

/** The events that may carry a user activation (HTML "activation triggering input event"). */
export const UNLOCK_EVENTS = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;

type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** True while this event is a user activation; undefined where the browser cannot say. */
export function activationNow(): boolean | undefined {
  const ua = (globalThis.navigator as { userActivation?: { isActive?: boolean } } | undefined)
    ?.userActivation;
  return typeof ua?.isActive === "boolean" ? ua.isActive : undefined;
}

/**
 * Call `unlock` on the page's input events until it reports done (true).
 * Returns the cleanup. `unlock` decides itself whether this event counts
 * (activationNow), so a touch's pointerdown is retried on its pointerup.
 */
export function unlockOnGesture(target: Target, unlock: () => boolean): () => void {
  let on = true;
  const off = () => {
    if (!on) return;
    on = false;
    for (const t of UNLOCK_EVENTS) target.removeEventListener(t, handle, { capture: true });
  };
  function handle() {
    if (on && unlock()) off();
  }
  for (const t of UNLOCK_EVENTS)
    target.addEventListener(t, handle, { capture: true, passive: true });
  return off;
}

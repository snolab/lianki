/**
 * Which input the person used last, so hints match what is in their hands:
 * key hints for a hardware keyboard, gesture hints for touch. A hybrid
 * (a tablet with a keyboard, a touchscreen laptop) switches with each real
 * touch or real key press. Remembered per device in `lk:input-modality`,
 * seeded from the pointer media queries until the first real input.
 *
 * Event-driven: a keydown and a pointerdown listener, nothing polled. The
 * React hook is `useInputModality()` (lib/use-input-modality.ts).
 */
export type Modality = "touch" | "keyboard";

export const MODALITY_KEY = "lk:input-modality";

type MatchMedia = (q: string) => { matches: boolean };

/** First guess, before any input: a coarse or hover-less pointer is touch. */
export function seedModality(matchMedia: MatchMedia): Modality {
  if (matchMedia("(pointer: fine)").matches) return "keyboard";
  if (matchMedia("(pointer: coarse)").matches || matchMedia("(hover: none)").matches)
    return "touch";
  return "keyboard";
}

export type KeyLike = Pick<
  KeyboardEvent,
  "isTrusted" | "key" | "keyCode" | "isComposing" | "ctrlKey" | "metaKey" | "altKey"
>;

export type KeyEnv = {
  /** A text field (input, textarea, contenteditable) has focus. */
  textFocused: boolean;
  /** visualViewport.height, where there is one. */
  viewportHeight?: number;
  innerHeight: number;
};

/** Keys an on-screen keyboard does not send: arrows, modifiers, F-keys, Escape, Tab, paging. */
const HARDWARE_ONLY =
  /^(Arrow|F\d{1,2}$|Shift$|Control$|Alt$|Meta$|Escape$|Tab$|Home$|End$|Page|CapsLock$|Insert$)/;

/**
 * A key press from a hardware keyboard. Not a script's synthetic event, not
 * an IME composing (keyCode 229), and not typing into a field while the
 * on-screen keyboard is up (it takes much of the visual viewport).
 */
export function isHardwareKey(e: KeyLike, env: KeyEnv): boolean {
  if (!e.isTrusted || e.isComposing || e.keyCode === 229) return false;
  if (HARDWARE_ONLY.test(e.key) || e.ctrlKey || e.metaKey || e.altKey) return true;
  if (!env.textFocused) return true;
  const osk = env.viewportHeight !== undefined && env.viewportHeight < env.innerHeight * 0.75;
  return !osk;
}

type Listen = (type: string, fn: (e: Event) => void, opts: AddEventListenerOptions) => void;

export type ModalityEnv = {
  matchMedia: MatchMedia;
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  addEventListener: Listen;
  removeEventListener: Listen;
  keyEnv: () => KeyEnv;
};

export function createModalityTracker(env: ModalityEnv) {
  const read = (): Modality | null => {
    try {
      const v = env.storage?.getItem(MODALITY_KEY);
      return v === "touch" || v === "keyboard" ? v : null;
    } catch {
      return null;
    }
  };
  let current: Modality = read() ?? seedModality(env.matchMedia);
  const subs = new Set<() => void>();

  const set = (m: Modality) => {
    if (m === current) return;
    current = m;
    try {
      env.storage?.setItem(MODALITY_KEY, m);
    } catch {}
    for (const fn of subs) fn();
  };
  const onKey = (e: Event) => {
    if (isHardwareKey(e as KeyboardEvent, env.keyEnv())) set("keyboard");
  };
  const onPointer = (e: Event) => {
    const p = e as PointerEvent;
    if (p.isTrusted && p.pointerType === "touch") set("touch");
  };
  const opts = { capture: true, passive: true };

  return {
    get: () => current,
    subscribe(fn: () => void) {
      if (!subs.size) {
        env.addEventListener("keydown", onKey, opts);
        env.addEventListener("pointerdown", onPointer, opts);
      }
      subs.add(fn);
      return () => {
        subs.delete(fn);
        if (subs.size) return;
        env.removeEventListener("keydown", onKey, opts);
        env.removeEventListener("pointerdown", onPointer, opts);
      };
    },
  };
}

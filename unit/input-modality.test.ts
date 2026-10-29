import { describe, expect, test } from "bun:test";
import {
  createModalityTracker,
  isHardwareKey,
  MODALITY_KEY,
  seedModality,
  type KeyEnv,
  type KeyLike,
} from "@/lib/input-modality";

const media =
  (...on: string[]) =>
  (q: string) => ({ matches: on.includes(q) });

const key = (k: Partial<KeyLike> = {}): KeyLike => ({
  isTrusted: true,
  key: "a",
  keyCode: 65,
  isComposing: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...k,
});
const noField: KeyEnv = { textFocused: false, innerHeight: 800, viewportHeight: 800 };
const fieldWithOsk: KeyEnv = { textFocused: true, innerHeight: 800, viewportHeight: 420 };
const fieldNoOsk: KeyEnv = { textFocused: true, innerHeight: 800, viewportHeight: 790 };

describe("seedModality", () => {
  test("fine pointer: keyboard; coarse or hover-less: touch", () => {
    expect(seedModality(media("(pointer: fine)"))).toBe("keyboard");
    expect(seedModality(media("(pointer: coarse)"))).toBe("touch");
    expect(seedModality(media("(hover: none)"))).toBe("touch");
    expect(seedModality(media())).toBe("keyboard");
  });
});

describe("isHardwareKey", () => {
  test("letters with no text field focused count", () => {
    expect(isHardwareKey(key(), noField)).toBe(true);
  });
  test("synthetic, IME and keyCode 229 events do not", () => {
    expect(isHardwareKey(key({ isTrusted: false }), noField)).toBe(false);
    expect(isHardwareKey(key({ isComposing: true }), noField)).toBe(false);
    expect(isHardwareKey(key({ keyCode: 229, key: "Unidentified" }), noField)).toBe(false);
  });
  test("typing into a field with the on-screen keyboard up does not", () => {
    expect(isHardwareKey(key(), fieldWithOsk)).toBe(false);
    expect(isHardwareKey(key({ key: "Enter" }), fieldWithOsk)).toBe(false);
    // No on-screen keyboard taking the screen: a real keyboard typed it.
    expect(isHardwareKey(key(), fieldNoOsk)).toBe(true);
    expect(isHardwareKey(key(), { textFocused: true, innerHeight: 800 })).toBe(true);
  });
  test("arrows, modifiers, F-keys and shortcuts count even in a field", () => {
    for (const k of ["ArrowDown", "Shift", "Meta", "F5", "Escape", "Tab", "PageDown"])
      expect(isHardwareKey(key({ key: k }), fieldWithOsk)).toBe(true);
    expect(isHardwareKey(key({ ctrlKey: true }), fieldWithOsk)).toBe(true);
  });
});

/** A fake window: event listeners, storage and media queries. */
function fakeWindow(stored: string | null, ...mediaOn: string[]) {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const store = new Map<string, string>(stored ? [[MODALITY_KEY, stored]] : []);
  const t = createModalityTracker({
    matchMedia: media(...mediaOn),
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type, fn) => void listeners.get(type)?.delete(fn),
    keyEnv: () => noField,
  });
  const fire = (type: string, e: object) => {
    for (const fn of listeners.get(type) ?? []) fn(e as Event);
  };
  return { t, store, listeners, fire };
}

describe("createModalityTracker", () => {
  test("seeds from the media queries; the last real input wins and is remembered", () => {
    const w = fakeWindow(null, "(pointer: coarse)");
    expect(w.t.get()).toBe("touch");
    let changes = 0;
    const off = w.t.subscribe(() => changes++);
    w.fire("keydown", key({ key: "ArrowDown" }));
    expect(w.t.get()).toBe("keyboard");
    expect(w.store.get(MODALITY_KEY)).toBe("keyboard");
    w.fire("keydown", key()); // no change, no notice
    w.fire("pointerdown", { isTrusted: true, pointerType: "mouse" });
    expect(w.t.get()).toBe("keyboard");
    w.fire("pointerdown", { isTrusted: false, pointerType: "touch" });
    expect(w.t.get()).toBe("keyboard");
    w.fire("pointerdown", { isTrusted: true, pointerType: "touch" });
    expect(w.t.get()).toBe("touch");
    expect(changes).toBe(2);
    off();
    expect(w.listeners.get("keydown")!.size).toBe(0);
    expect(w.listeners.get("pointerdown")!.size).toBe(0);
  });

  test("a stored modality beats the media queries", () => {
    expect(fakeWindow("keyboard", "(pointer: coarse)").t.get()).toBe("keyboard");
    expect(fakeWindow("touch", "(pointer: fine)").t.get()).toBe("touch");
    expect(fakeWindow("junk", "(pointer: fine)").t.get()).toBe("keyboard");
  });

  test("listeners are shared by subscribers and removed with the last", () => {
    const w = fakeWindow(null);
    const a = w.t.subscribe(() => {});
    const b = w.t.subscribe(() => {});
    expect(w.listeners.get("keydown")!.size).toBe(1);
    a();
    expect(w.listeners.get("keydown")!.size).toBe(1);
    b();
    expect(w.listeners.get("keydown")!.size).toBe(0);
  });

  test("storage that throws is ignored", () => {
    const t = createModalityTracker({
      matchMedia: media("(pointer: coarse)"),
      storage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      keyEnv: () => noField,
    });
    expect(t.get()).toBe("touch");
  });
});

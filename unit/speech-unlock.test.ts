import { afterEach, describe, expect, it } from "bun:test";
import {
  UNLOCK_EVENTS,
  activationNow,
  unlockOnGesture,
} from "../packages/debug-chat/src/speech-unlock";

const nav = globalThis.navigator as unknown as { userActivation?: unknown };
const had = Object.getOwnPropertyDescriptor(nav, "userActivation");
afterEach(() => {
  if (had) Object.defineProperty(nav, "userActivation", had);
  else delete nav.userActivation;
});
const setActivation = (isActive: boolean | undefined) =>
  Object.defineProperty(nav, "userActivation", {
    configurable: true,
    value: isActive === undefined ? undefined : { isActive },
  });

describe("speech-unlock: Li's voice unlocks on any tap on the page (iOS)", () => {
  it("a tap anywhere on the page unlocks, once; the listeners then come off", () => {
    const page = new EventTarget();
    let calls = 0;
    unlockOnGesture(page, () => (calls++, true));
    page.dispatchEvent(new Event("touchend"));
    page.dispatchEvent(new Event("click"));
    page.dispatchEvent(new Event("keydown"));
    expect(calls).toBe(1);
  });

  it("an event that is not an activation (a touch's pointerdown) keeps listening for the next", () => {
    const page = new EventTarget();
    const seen: string[] = [];
    unlockOnGesture(page, () => {
      seen.push("try");
      return seen.length >= 2;
    });
    page.dispatchEvent(new Event("pointerdown"));
    page.dispatchEvent(new Event("pointerup"));
    page.dispatchEvent(new Event("click"));
    expect(seen).toEqual(["try", "try"]);
  });

  it("listens to every activation-triggering event, and the cleanup removes them all", () => {
    expect([...UNLOCK_EVENTS]).toEqual([
      "pointerdown",
      "pointerup",
      "touchend",
      "click",
      "keydown",
    ]);
    const page = new EventTarget();
    let calls = 0;
    const off = unlockOnGesture(page, () => (calls++, false));
    for (const t of UNLOCK_EVENTS) page.dispatchEvent(new Event(t));
    expect(calls).toBe(UNLOCK_EVENTS.length);
    off();
    for (const t of UNLOCK_EVENTS) page.dispatchEvent(new Event(t));
    expect(calls).toBe(UNLOCK_EVENTS.length);
  });

  it("activationNow reads navigator.userActivation, undefined where there is none", () => {
    setActivation(true);
    expect(activationNow()).toBe(true);
    setActivation(false);
    expect(activationNow()).toBe(false);
    setActivation(undefined);
    expect(activationNow()).toBeUndefined();
  });
});

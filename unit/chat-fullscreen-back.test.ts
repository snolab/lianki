/**
 * Back leaves the chat's full screen first, never the page
 * (packages/debug-chat/src/full-screen.ts fullScreenBack, over
 * lib/back-to-close.ts openBackToClose).
 */
import { describe, expect, it } from "bun:test";
import { fullScreenBack } from "@lianki/debug-chat/full-screen";
import { openBackToClose } from "@/lib/back-to-close";

const URL0 = "https://lianki.com/en/words?live=https%3A%2F%2Fdev.lianki.com";

/** A history stack (back() lands on settle, as a browser's does) and the page's gesture listeners. */
function fakeWin(activated = false) {
  const entries: { state: unknown; href: string }[] = [{ state: { __NA: true }, href: URL0 }];
  let at = 0;
  const pops: (() => void)[] = [];
  const gestures = new Map<string, Set<() => void>>();
  let backs = 0;
  const go = (d: number) => {
    if (at + d < 0 || at + d >= entries.length) return;
    at += d;
    for (const fn of [...pops]) fn();
  };
  const win = {
    navigator: { userActivation: { hasBeenActive: activated } },
    history: {
      get state() {
        return entries[at].state;
      },
      get length() {
        return entries.length;
      },
      pushState(data: unknown, _: string, url?: string) {
        entries.splice(at + 1, entries.length, { state: data, href: url ?? entries[at].href });
        at++;
      },
      replaceState(data: unknown) {
        entries[at] = { ...entries[at], state: data };
      },
      back() {
        backs++;
      },
    },
    location: {
      get href() {
        return entries[at].href;
      },
    },
    addEventListener(type: string, fn: () => void) {
      if (type === "popstate") pops.push(fn);
      else (gestures.get(type) ?? gestures.set(type, new Set()).get(type)!).add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      if (type === "popstate") {
        const i = pops.indexOf(fn);
        if (i >= 0) pops.splice(i, 1);
      } else gestures.get(type)?.delete(fn);
    },
    entries,
    at: () => at,
    press: (type = "pointerdown") => {
      for (const fn of [...(gestures.get(type) ?? [])]) fn();
    },
    gestureListeners: () => [...gestures.values()].reduce((n, s) => n + s.size, 0),
    userBack: () => go(-1),
    settle: () => {
      while (backs) {
        backs--;
        go(-1);
      }
    },
  };
  return win;
}

/** Full screen as DebugChat runs it: on until Back (or `leave`) turns it off. */
function enter(win: ReturnType<typeof fakeWin>, byTap: boolean) {
  const s = { full: true };
  const leave = fullScreenBack(
    win,
    (onBack) => openBackToClose(win, onBack),
    () => (s.full = false),
    byTap,
  );
  return { s, leave };
}

describe("Back leaves full screen first", () => {
  it("entered by a tap: one entry on the same URL (?live= kept); Back leaves full screen, not the page", () => {
    const win = fakeWin();
    const { s, leave } = enter(win, true);
    expect(win.entries).toHaveLength(2);
    expect(win.entries[1].href).toBe(URL0);
    win.userBack();
    expect(s.full).toBe(false);
    expect(win.at()).toBe(0);
    leave(); // the effect's cleanup after Back: no second back
    win.settle();
    expect(win.at()).toBe(0);
    expect(win.entries[0].href).toBe(URL0);
  });

  it("left by its own button: the entry is consumed, so no orphan and no double back", () => {
    const win = fakeWin();
    const { s, leave } = enter(win, true);
    leave();
    win.settle();
    expect(s.full).toBe(true); // the button turned it off itself; Back did not fire
    expect(win.at()).toBe(0);
    // In again and Back: one press is enough.
    const again = enter(win, true);
    expect(win.at()).toBe(1);
    win.userBack();
    expect(again.s.full).toBe(false);
  });

  it("restored by a reload: no entry until the first press, then Back leaves full screen", () => {
    const win = fakeWin(false);
    const { s, leave } = enter(win, false);
    expect(win.entries).toHaveLength(1);
    win.press("pointerdown");
    expect(win.entries).toHaveLength(2);
    expect(win.gestureListeners()).toBe(0);
    win.press("keydown"); // a later key pushes no second entry
    expect(win.entries).toHaveLength(2);
    win.userBack();
    expect(s.full).toBe(false);
    leave();
    win.settle();
    expect(win.at()).toBe(0); // the page it was on, not one before it
  });

  it("left before any gesture: nothing was pushed and nothing is listening", () => {
    const win = fakeWin(false);
    const { leave } = enter(win, false);
    leave();
    win.press();
    win.settle();
    expect(win.entries).toHaveLength(1);
    expect(win.gestureListeners()).toBe(0);
  });

  it("reopened from the pill on a page that had a gesture: the entry is taken at once", () => {
    const win = fakeWin(true);
    const { s } = enter(win, false);
    expect(win.entries).toHaveLength(2);
    win.userBack();
    expect(s.full).toBe(false);
  });
});

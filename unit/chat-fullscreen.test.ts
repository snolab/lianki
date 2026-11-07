import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetUiStores } from "@lianki/ui-state";
import { readFileSync } from "node:fs";
import {
  FULL_SCREEN_STYLE,
  PANEL_RIGHT,
  PANEL_W,
  escapeLeaves,
  fullBarSpan,
  fullBottomPad,
  fullScreenAllowed,
  fullScreenBox,
  fullScreenOn,
} from "@lianki/debug-chat/full-screen";
import { CHAT_VIEW_INITIAL, chatPrefs } from "@lianki/debug-chat/ui-store";
import { CHAT_STRINGS_EN } from "@lianki/debug-chat/wire";
import { uiStrings } from "@lianki/debug-chat/ui-strings";
import { FLAGS, flagIn } from "@/lib/flags";

describe("the gate: flag || owner, never on another site", () => {
  it("is off for everyone but the owner while the flag is off", () => {
    expect(fullScreenAllowed({ flag: false, owner: false, embedded: false })).toBe(false);
    expect(fullScreenAllowed({ flag: false, owner: true, embedded: false })).toBe(true);
  });
  it("reaches every chat user once the flag is on", () => {
    expect(fullScreenAllowed({ flag: true, owner: false, embedded: false })).toBe(true);
    expect(fullScreenAllowed({ flag: true, owner: true, embedded: false })).toBe(true);
  });
  it("never runs embedded on another site, owner or flag", () => {
    expect(fullScreenAllowed({ flag: true, owner: true, embedded: true })).toBe(false);
    expect(fullScreenAllowed({ flag: false, owner: true, embedded: true })).toBe(false);
  });
  it("the flag is in the registry, off by default, reaching every user once on", () => {
    const def = FLAGS["partner.fullscreen"];
    expect(def.default).toBe(false);
    expect("audience" in def).toBe(false);
    expect(flagIn({}, "partner.fullscreen")).toBe(false);
    expect(flagIn({ "partner.fullscreen": true }, "partner.fullscreen")).toBe(true);
  });
});

describe("on: allowed, chosen and open", () => {
  it("needs all three", () => {
    expect(fullScreenOn({ allowed: true, pref: true, open: true })).toBe(true);
    expect(fullScreenOn({ allowed: false, pref: true, open: true })).toBe(false);
    expect(fullScreenOn({ allowed: true, pref: false, open: true })).toBe(false);
    // Minimized to the pill: never full screen, the choice kept for reopening.
    expect(fullScreenOn({ allowed: true, pref: true, open: false })).toBe(false);
  });
});

describe("the per-device view state (lk:pref:chat-view)", () => {
  let data: Map<string, string>;
  beforeEach(() => {
    data = new Map();
    const localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
    };
    (globalThis as { window?: unknown }).window = { localStorage, addEventListener() {} };
    resetUiStores();
  });
  afterEach(() => {
    resetUiStores();
    delete (globalThis as { window?: unknown }).window;
  });
  it("starts off, and is kept in localStorage next to compact, across a reload", () => {
    expect(CHAT_VIEW_INITIAL.full).toBe(false);
    expect(chatPrefs().getState().full).toBe(false);
    chatPrefs().setState({ full: true });
    expect(JSON.parse(data.get("lk:pref:chat-view")!).state).toEqual({
      compact: false,
      full: true,
    });
    resetUiStores();
    expect(chatPrefs().getState().full).toBe(true);
  });
  it("a value stored before `full` existed keeps compact and reads full as off", () => {
    data.set("lk:pref:chat-view", JSON.stringify({ state: { compact: true }, version: 1 }));
    expect(chatPrefs().getState()).toEqual({ compact: true, full: false });
  });
  it("a damaged value falls back to off", () => {
    data.set("lk:pref:chat-view", JSON.stringify({ state: { full: "yes" }, version: 1 }));
    expect(chatPrefs().getState().full).toBe(false);
  });
});

describe("the box follows the visible area (the keyboard)", () => {
  it("is the whole layout viewport with no keyboard", () => {
    expect(
      fullScreenBox({ innerHeight: 844, vv: { offsetTop: 0, height: 844, scale: 1 } }),
    ).toEqual({
      top: 0,
      height: 844,
      keyboard: false,
    });
    expect(fullScreenBox({ innerHeight: 844, vv: null })).toEqual({
      top: 0,
      height: 844,
      keyboard: false,
    });
  });
  it("shrinks to the visual viewport above the keyboard, panned as iOS pans it", () => {
    expect(fullScreenBox({ innerHeight: 844, vv: { offsetTop: 0, height: 508 } })).toEqual({
      top: 0,
      height: 508,
      keyboard: true,
    });
    expect(fullScreenBox({ innerHeight: 844, vv: { offsetTop: 120.4, height: 508.6 } })).toEqual({
      top: 120,
      height: 509,
      keyboard: true,
    });
  });
  it("never reaches past the layout viewport's bottom", () => {
    const b = fullScreenBox({ innerHeight: 844, vv: { offsetTop: 400, height: 600 } });
    expect(b.top + b.height).toBeLessThanOrEqual(844);
  });
  it("ignores a pinch zoom (not a keyboard)", () => {
    expect(
      fullScreenBox({ innerHeight: 844, vv: { offsetTop: 200, height: 300, scale: 2 } }),
    ).toEqual({
      top: 0,
      height: 844,
      keyboard: false,
    });
  });
  it("pads the home indicator only while no keyboard covers it", () => {
    expect(fullBottomPad(false)).toContain("safe-area-inset-bottom");
    expect(fullBottomPad(true)).not.toContain("safe-area-inset-bottom");
  });
  it("rests the bar above the bottom island's reserve, as the panel does", () => {
    expect(fullBottomPad(false)).toContain("--lk-bottom-reserve");
    expect(FULL_SCREEN_STYLE.paddingBottom).toContain("--lk-bottom-reserve");
  });
  it("keeps the bar at the panel's span, so the mic does not move", () => {
    const s = fullBarSpan(-37.5);
    expect(s.width).toBe(PANEL_W);
    expect(s.alignSelf).toBe("flex-end");
    // The panel's right inset, less full screen's own side padding.
    expect(s.marginRight).toContain(PANEL_RIGHT);
    expect(s.marginRight).toContain("48rem");
    // A dragged panel's sideways offset goes with it.
    expect(s.translate).toBe("-37.5px 0");
    expect(fullBarSpan(0).translate).toBe("0px 0");
  });
  it("names the panel's own width and inset (the section's classes)", () => {
    const src = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
    expect(src).toContain(`w-[${PANEL_W.replaceAll(" ", "")}]`);
    expect(src).toContain(`right-[${PANEL_RIGHT.replaceAll(" ", "")}]`);
  });
  it("respects the notch and the landscape sides, and caps the column", () => {
    expect(FULL_SCREEN_STYLE.paddingTop).toContain("safe-area-inset-top");
    expect(FULL_SCREEN_STYLE.paddingLeft).toContain("safe-area-inset-left");
    expect(FULL_SCREEN_STYLE.paddingRight).toContain("safe-area-inset-right");
    expect(FULL_SCREEN_STYLE.paddingLeft).toContain("48rem");
  });
});

describe("Escape", () => {
  it("leaves full screen unless a panel or the + menu takes it first", () => {
    expect(escapeLeaves({ full: true, panelOpen: false, plusMenu: false })).toBe(true);
    expect(escapeLeaves({ full: true, panelOpen: true, plusMenu: false })).toBe(false);
    expect(escapeLeaves({ full: true, panelOpen: false, plusMenu: true })).toBe(false);
    expect(escapeLeaves({ full: false, panelOpen: false, plusMenu: false })).toBe(false);
  });
});

describe("strings", () => {
  it("has English defaults and the package's fallbacks", () => {
    expect(CHAT_STRINGS_EN.fullScreen).toBe("Full screen");
    expect(CHAT_STRINGS_EN.fullScreenExit).toBe("Exit full screen");
    for (const lang of ["en", "zh", "ja"]) {
      expect(uiStrings(lang).fullScreen.length).toBeGreaterThan(0);
      expect(uiStrings(lang).fullScreenExit.length).toBeGreaterThan(0);
    }
  });
});

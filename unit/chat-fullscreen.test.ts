import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetUiStores } from "@lianki/ui-state";
import { readFileSync } from "node:fs";
import {
  FULL_SCREEN_STYLE,
  FULL_SIDEBAR_STYLE,
  PANEL_RIGHT,
  PANEL_W,
  SIDEBAR_QUERY,
  SIDEBAR_RESERVE_VAR,
  SIDEBAR_W,
  escapeLeaves,
  fullBarSpan,
  sidebarReserve,
  fullBottomPad,
  fullScreenAllowed,
  fullScreenBox,
  fullScreenOn,
  FULL_LEAVE_PX,
  dragLeavesFull,
  dropEntersFull,
  FULL_HINT_STYLE,
  fullHintStep,
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
  it("on a phone the bar spans the screen inside the safe areas, at the panel's 0.5rem gutter", () => {
    const s = fullBarSpan(false);
    expect(s.width).toBe("auto");
    expect(s.alignSelf).toBe("stretch");
    // Out of full screen's 0.75rem padding to the panel's own 0.5rem inset, and the safe areas.
    expect(s.marginLeft).toContain("0.5rem");
    expect(s.marginLeft).toContain("safe-area-inset-left");
    expect(s.marginRight).toContain("safe-area-inset-right");
    expect(PANEL_RIGHT).toContain("0.5rem");
  });
  it("in the sidebar the bar spans the sidebar, as the log does", () => {
    expect(fullBarSpan(true)).toEqual({ alignSelf: "stretch", width: "auto" });
  });
  it("is a right sidebar from the owner's 35em up, the page beside it kept clear", () => {
    expect(SIDEBAR_QUERY).toBe("(min-width: 35em)");
    expect(FULL_SIDEBAR_STYLE.left).toBe("auto");
    expect(FULL_SIDEBAR_STYLE.right).toBe(0);
    expect(FULL_SIDEBAR_STYLE.width).toBe(SIDEBAR_W);
    expect(FULL_SIDEBAR_STYLE.borderLeft).toContain("oklch");
    const style = new Map<string, string>([["padding-right", "3px"]]);
    const root = {
      style: {
        get paddingRight() {
          return style.get("padding-right") ?? "";
        },
        set paddingRight(v: string) {
          style.set("padding-right", v);
        },
        setProperty: (k: string, v: string) => void style.set(k, v),
        removeProperty: (k: string) => void style.delete(k),
      },
    } as unknown as HTMLElement;
    const back = sidebarReserve(root);
    expect(style.get(SIDEBAR_RESERVE_VAR)).toBe(SIDEBAR_W);
    expect(root.style.paddingRight).toBe(`var(${SIDEBAR_RESERVE_VAR})`);
    back();
    expect(style.has(SIDEBAR_RESERVE_VAR)).toBe(false);
    expect(root.style.paddingRight).toBe("3px");
  });
  it("names the panel's own width and inset (the section's classes)", () => {
    const src = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
    expect(src).toContain(`w-[${PANEL_W.replaceAll(" ", "")}]`);
    expect(src).toContain(`right-[${PANEL_RIGHT.replaceAll(" ", "")}]`);
  });
  it("respects the notch and the landscape sides", () => {
    expect(FULL_SCREEN_STYLE.paddingTop).toContain("safe-area-inset-top");
    expect(FULL_SCREEN_STYLE.paddingLeft).toContain("safe-area-inset-left");
    expect(FULL_SCREEN_STYLE.paddingRight).toContain("safe-area-inset-right");
    expect(FULL_SIDEBAR_STYLE.paddingRight).toContain("safe-area-inset-right");
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
    expect(CHAT_STRINGS_EN.dragGrip).toContain("drag");
    for (const lang of ["en", "zh", "ja"]) {
      expect(uiStrings(lang).fullScreen.length).toBeGreaterThan(0);
      expect(uiStrings(lang).fullScreenExit.length).toBeGreaterThan(0);
    }
  });
});

describe("by a drag: the bottom edge enters, a drag up leaves (owner, 2026-11-09 18:25 JST)", () => {
  const at = (barBottom: number, o: Partial<Parameters<typeof dropEntersFull>[0]> = {}) =>
    dropEntersFull({ allowed: true, open: true, full: false, barBottom, vh: 844, ...o });
  it("a bar dropped flush against the bottom edge enters full screen", () => {
    expect(at(844)).toBe(true);
    expect(at(843.6)).toBe(true);
  });
  it("short of the edge, even by a pixel, it stays a panel", () => {
    expect(at(843)).toBe(false);
    // The panel's own place: 0.5rem above the edge.
    expect(at(836)).toBe(false);
  });
  it("the top edge never enters (it would hide the history, 18:26 JST)", () => {
    // A bar of 44 px pushed against the top: its bottom is far from the screen's.
    expect(at(44)).toBe(false);
    expect(at(0)).toBe(false);
  });
  it("only an open chat that may go full screen, and not twice", () => {
    expect(at(844, { allowed: false })).toBe(false);
    expect(at(844, { open: false })).toBe(false);
    expect(at(844, { full: true })).toBe(false);
  });
  it("a drag up past FULL_LEAVE_PX leaves; a wobble, sideways or down stays", () => {
    expect(FULL_LEAVE_PX).toBeGreaterThan(20);
    expect(dragLeavesFull({ full: true, dy: -FULL_LEAVE_PX })).toBe(true);
    expect(dragLeavesFull({ full: true, dy: -200 })).toBe(true);
    expect(dragLeavesFull({ full: true, dy: -(FULL_LEAVE_PX - 1) })).toBe(false);
    expect(dragLeavesFull({ full: true, dy: 0 })).toBe(false);
    expect(dragLeavesFull({ full: true, dy: 120 })).toBe(false);
    expect(dragLeavesFull({ full: false, dy: -200 })).toBe(false);
  });
  it("the chat has no button to enter, only an exit button and the menu's row", () => {
    const src = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
    expect(src).not.toContain('data-testid="debug-chat-fullscreen"');
    expect(src).toContain('data-testid="debug-chat-fullscreen-exit"');
    expect(src).toContain('data-testid="debug-menu-fullscreen"');
    expect(src).toContain("dropEntersFull(");
    expect(src).toContain("dragLeavesFull(");
  });
  it("the exit button is the ✕ alone; its words are the label and tooltip (2026-11-11)", () => {
    const src = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
    const at = src.indexOf('data-testid="debug-chat-fullscreen-exit"');
    const button = src.slice(at, src.indexOf("</button>", at));
    expect(button).toContain("aria-label={t.fullScreenExit}");
    expect(button).toContain("title={t.fullScreenExit}");
    expect(button.split("\n").filter((l) => l.trim() === "{t.fullScreenExit}")).toEqual([]);
  });
});

describe("the full-screen hint while dragging (owner, 2026-11-10)", () => {
  it("steps only when the drop rule flips: in at the bottom edge, out when backing off", () => {
    const at = (barBottom: number) =>
      dropEntersFull({ allowed: true, open: true, full: false, barBottom, vh: 844 });
    let on = false;
    const steps: (string | null)[] = [];
    for (const b of [600, 800, 844, 844, 820, 844]) {
      const next = at(b);
      steps.push(fullHintStep(on, next));
      on = next;
    }
    expect(steps).toEqual([null, null, "enter", null, "leave", "enter"]);
    // The top edge never: a bar pushed to the top is no drop into full screen.
    expect(at(60)).toBe(false);
  });

  it("the preview grows from the bottom edge, behind the chat, never takes a touch", () => {
    const off = FULL_HINT_STYLE(false, false);
    const on = FULL_HINT_STYLE(true, false);
    expect(off.transform).toBe("scaleY(0)");
    expect(on.transform).toBe("scaleY(1)");
    expect(on.transformOrigin).toBe("bottom");
    expect(on.pointerEvents).toBe("none");
    expect(on.zIndex).toContain("- 1");
    expect(JSON.stringify(on)).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
    expect(FULL_HINT_STYLE(true, true).transition).toBe("none");
  });
});

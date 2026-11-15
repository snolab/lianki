/**
 * The chat menu's Full screen row and the agent's way to flip it (owner,
 * 2026-11-15: "还是做进菜单吧，只不过我要求全屏时你帮我把菜单点开…高亮全屏按钮区域"):
 * the row shows both states [ On | Off ] (the current one filled seal red),
 * a tap flips it and the choice is kept on this device (lk:pref:chat-view);
 * `{type: "ui", op: "fullscreen"}` from the hub opens the menu, pulses the
 * row for CUE_MS, then flips it and closes the menu (ui-cue.ts).
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { resetUiStores, useUi } from "@lianki/ui-state";
import { importReactDomClient, stubGlobals } from "./support/globals";
import { FullScreenMenuItem } from "@lianki/debug-chat/FullScreenMenuItem";
import { chatPrefs } from "@lianki/debug-chat/ui-store";
import { CHAT_LOCALES, EXTRA, EXTRA_CONTEXT } from "@lianki/debug-chat/chat-ui-locales";
import {
  CHAT_UI_EVENT,
  CUE_KEYFRAMES,
  CUE_MS,
  CUE_OUTLINE,
  chatUiOf,
  dispatchChatUi,
  pulseRow,
  runMenuCue,
} from "@lianki/debug-chat/ui-cue";

// Not a static import: react-dom must first load with a DOM (unit/support/globals.ts).
const { createRoot } = await importReactDomClient();

const words = { label: "Full screen", onWord: "On", offWord: "Off" };

describe("the Full screen row's markup", () => {
  const html = (on: boolean, cue = false) =>
    renderToStaticMarkup(
      createElement(FullScreenMenuItem, { ...words, on, cue, onToggle: () => {} }),
    );
  it("shows both states, the current one active (seal red via .lk-sealbox [data-active])", () => {
    const on = html(true);
    expect(on).toContain('data-testid="debug-menu-fullscreen"');
    expect(on).toContain('role="menuitemcheckbox"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('class="lk-sealbox"');
    expect(on).toContain('data-seal="on"');
    expect(on).toContain('<span data-word="on" data-active="true">On</span>');
    expect(on).toContain('<span data-word="off">Off</span>');
    const off = html(false);
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('<span data-word="on">On</span>');
    expect(off).toContain('<span data-word="off" data-active="true">Off</span>');
    expect(off).toContain(">Full screen</button>");
  });
  it("outlined only while the agent changes it", () => {
    expect(html(false)).not.toContain("data-cue");
    expect(html(false)).not.toContain("outline");
    const cued = html(false, true);
    expect(cued).toContain('data-cue="true"');
    expect(cued).toContain("outline:2px solid var(--lk-seal-on");
  });
  it("the chat's menu draws it (no ◉/○ row left) and its tap goes through setFull", () => {
    const src = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
    const at = src.indexOf("<FullScreenMenuItem");
    expect(at).toBeGreaterThan(src.indexOf('data-testid="debug-menu"'));
    const item = src.slice(at, src.indexOf("/>", at));
    expect(item).toContain("on={full}");
    expect(item).toContain("cue={fullCue}");
    expect(item).toContain("setFull(!full, true)");
    expect(item).toContain("onWord={ux.menuSwitchOn}");
    expect(src).not.toContain('data-testid="debug-menu-fullscreen"');
    // setFull writes the device's choice (ui-store.ts chatPrefs `full`).
    const set = src.slice(src.indexOf("const setFull = "), src.indexOf("leaveFull.current ="));
    expect(set).toContain("chatPrefs().setState({ full: on })");
  });
});

describe("the switch's words: 16 locales, each with its context", () => {
  it("every locale has both, and they are not the same word", () => {
    for (const l of CHAT_LOCALES) {
      expect(EXTRA[l].menuSwitchOn.length).toBeGreaterThan(0);
      expect(EXTRA[l].menuSwitchOff.length).toBeGreaterThan(0);
      expect(EXTRA[l].menuSwitchOn).not.toBe(EXTRA[l].menuSwitchOff);
    }
    expect(EXTRA.zh).toMatchObject({ menuSwitchOn: "开", menuSwitchOff: "关" });
    expect(EXTRA_CONTEXT.menuSwitchOn).toContain("ON word");
    expect(EXTRA_CONTEXT.menuSwitchOff).toContain("OFF word");
  });
});

describe("hub message → chat event", () => {
  it("reads only a known op with a boolean", () => {
    expect(chatUiOf({ type: "ui", op: "fullscreen", on: true, at: 1 })).toEqual({
      op: "fullscreen",
      on: true,
    });
    expect(chatUiOf({ op: "fullscreen", on: false })).toEqual({ op: "fullscreen", on: false });
    expect(chatUiOf({ op: "fullscreen", on: "yes" })).toBeNull();
    expect(chatUiOf({ op: "zoom", on: true })).toBeNull();
    expect(chatUiOf(null)).toBeNull();
    expect(chatUiOf("fullscreen")).toBeNull();
  });
  it("dispatches the event with the change, or nothing", () => {
    const t = new EventTarget();
    const got: unknown[] = [];
    t.addEventListener(CHAT_UI_EVENT, (e) => got.push((e as CustomEvent).detail));
    expect(dispatchChatUi(t, { type: "ui", op: "fullscreen", on: true })).toBe(true);
    expect(dispatchChatUi(t, { type: "ui", op: "nope" })).toBe(false);
    expect(got).toEqual([{ op: "fullscreen", on: true }]);
  });
  it('the page passes the hub\'s {type:"ui"} on', () => {
    const src = readFileSync("app/components/DebugEval.tsx", "utf8");
    const at = src.indexOf('msg.type === "ui"');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 200)).toContain("dispatchChatUi(window, msg)");
  });
});

describe("the highlight sequence (fake timers)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const steps = () => {
    const log: string[] = [];
    return {
      log,
      deps: {
        openMenu: () => log.push("open"),
        cue: (on: boolean) => log.push(on ? "cue" : "uncue"),
        apply: () => log.push("apply"),
        closeMenu: () => log.push("close"),
      },
    };
  };
  it("opens and highlights at once; CUE_MS later flips and closes", () => {
    expect(CUE_MS).toBe(600);
    const { log, deps } = steps();
    const cancel = runMenuCue(deps);
    expect(log).toEqual(["open", "cue"]);
    jest.advanceTimersByTime(CUE_MS - 1);
    expect(log).toEqual(["open", "cue"]);
    jest.advanceTimersByTime(1);
    expect(log).toEqual(["open", "cue", "uncue", "apply", "close"]);
    cancel(); // after the end: nothing more
    expect(log).toHaveLength(5);
  });
  it("cancelled midway: the highlight stops, nothing changes", () => {
    const { log, deps } = steps();
    const cancel = runMenuCue(deps);
    jest.advanceTimersByTime(300);
    cancel();
    cancel();
    jest.advanceTimersByTime(CUE_MS);
    expect(log).toEqual(["open", "cue", "uncue"]);
  });
  it("takes an injected timer", () => {
    const { log, deps } = steps();
    let fire = () => {};
    let stopped = false;
    runMenuCue({
      ...deps,
      later: (fn, ms) => {
        expect(ms).toBe(CUE_MS);
        fire = fn;
        return () => (stopped = true);
      },
    })();
    expect(stopped).toBe(true);
    fire();
    expect(log).toContain("apply");
  });
  it("the pulse scrolls the row into the menu's view and animates once, unless reduced motion", () => {
    const calls: unknown[][] = [];
    const el = {
      scrollIntoView: (o: unknown) => calls.push(["scroll", o]),
      animate: (k: unknown, o: unknown) => calls.push(["animate", k, o]),
    };
    pulseRow(el, false);
    expect(calls).toEqual([
      ["scroll", { block: "nearest" }],
      ["animate", CUE_KEYFRAMES, { duration: CUE_MS, easing: "ease-out" }],
    ]);
    calls.length = 0;
    pulseRow(el, true);
    expect(calls).toEqual([["scroll", { block: "nearest" }]]);
    pulseRow({}, false); // an element without either: no throw
    expect(CUE_OUTLINE.outline).toContain("oklch(");
    expect(JSON.stringify(CUE_KEYFRAMES)).not.toMatch(/rgb|#[0-9a-f]{3}/i);
  });
});

describe("the row mounted: tap, persistence, the agent's cue", () => {
  let win: Window;
  let restore: () => void;
  let root: Root;
  let host: HTMLElement;
  let animated = 0;
  let reduce = false;

  beforeEach(() => {
    win = new Window({ url: "https://lianki.com/en" });
    animated = 0;
    reduce = false;
    (win.HTMLElement.prototype as unknown as Record<string, unknown>).animate = () => {
      animated++;
    };
    restore = stubGlobals({
      window: win,
      document: win.document,
      localStorage: win.localStorage,
      matchMedia: () => ({ matches: reduce }),
      HTMLElement: win.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    resetUiStores();
    host = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(host as never);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    resetUiStores();
    restore();
    await win.happyDOM.close();
  });

  /** The chat's wiring in small: the row bound to the device's `full`, a tap and a cue flip it. */
  function Harness({ cue }: { cue: boolean }) {
    const full = useUi(chatPrefs(), (s) => s.full);
    return createElement(FullScreenMenuItem, {
      ...words,
      on: full,
      cue,
      onToggle: () => chatPrefs().setState({ full: !full }),
    });
  }
  const row = () =>
    win.document.querySelector('[data-testid="debug-menu-fullscreen"]') as unknown as HTMLElement;
  const active = () =>
    win.document.querySelector('[data-testid="debug-menu-fullscreen"] [data-active]')?.textContent;

  it("a tap flips both states and the choice is kept across a reload", async () => {
    await act(async () => root.render(createElement(Harness, { cue: false })));
    expect(row().getAttribute("aria-checked")).toBe("false");
    expect(active()).toBe("Off");
    await act(async () => row().click());
    expect(row().getAttribute("aria-checked")).toBe("true");
    expect(active()).toBe("On");
    expect(JSON.parse(win.localStorage.getItem("lk:pref:chat-view")!).state.full).toBe(true);
    // A reload: a fresh store reads it back, and the row mounts on.
    await act(async () => root.unmount());
    resetUiStores();
    expect(chatPrefs().getState().full).toBe(true);
    root = createRoot(host);
    await act(async () => root.render(createElement(Harness, { cue: false })));
    expect(active()).toBe("On");
    await act(async () => row().click());
    expect(active()).toBe("Off");
    expect(JSON.parse(win.localStorage.getItem("lk:pref:chat-view")!).state.full).toBe(false);
  });
  it("the cue pulses the row once; reduced motion keeps only the outline", async () => {
    await act(async () => root.render(createElement(Harness, { cue: true })));
    expect(row().getAttribute("data-cue")).toBe("true");
    expect(animated).toBe(1);
    await act(async () => root.render(createElement(Harness, { cue: false })));
    expect(row().hasAttribute("data-cue")).toBe(false);
    reduce = true;
    await act(async () => root.render(createElement(Harness, { cue: true })));
    expect(animated).toBe(1);
  });
});

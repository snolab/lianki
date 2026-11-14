import { afterEach, expect, it } from "bun:test";
import { resetUiStores } from "@lianki/ui-state";
import { chatDock } from "@lianki/debug-chat/ui-store";
import {
  clampDockWidth,
  dockBounds,
  dockViewport,
  resizeDockWidth,
} from "@lianki/debug-chat/dock-resize";

afterEach(() => {
  resetUiStores();
  delete (globalThis as { window?: unknown }).window;
});
it("the inner edge changes only width, anchored on the right", () => {
  const b = dockBounds(1000, 320);
  expect(resizeDockWidth(400, 600, 500, b)).toBe(500);
  expect(resizeDockWidth(400, 600, 650, b)).toBe(350);
  expect(resizeDockWidth(400, 600, 600, b)).toBe(400);
});
it("clamps both extremes and permits a viewport smaller than the composer minimum", () => {
  const b = dockBounds(900, 320);
  expect(resizeDockWidth(400, 600, 2000, b)).toBe(320);
  expect(resizeDockWidth(400, 600, -10000, b)).toBe(900);
  expect(clampDockWidth(400, dockBounds(240, 320))).toBe(240);
  expect(clampDockWidth(100, dockBounds(0, 320))).toBe(0);
});
it("ignores non-finite pointer coordinates and never produces a non-finite size", () => {
  const b = dockBounds(900, 320);
  expect(resizeDockWidth(400, NaN, 300, b)).toBe(400);
  expect(resizeDockWidth(400, 600, Infinity, b)).toBe(400);
  expect(clampDockWidth(NaN, b)).toBe(320);
  expect(clampDockWidth(Infinity, b)).toBe(320);
  expect(dockBounds(NaN, 320)).toEqual({ min: 0, max: 0 });
  expect(dockBounds(900, NaN)).toEqual({ min: 0, max: 900 });
});
it("follows the visual viewport and its pan, including pinch zoom", () => {
  expect(dockViewport(1200)).toEqual({ width: 1200, right: 0 });
  expect(dockViewport(1200, { width: 900, offsetLeft: 100, scale: 1 })).toEqual({
    width: 900,
    right: 200,
  });
  expect(dockViewport(1200, { width: 600, offsetLeft: 300, scale: 2 })).toEqual({
    width: 600,
    right: 300,
  });
  expect(dockViewport(1200, { width: 2000, offsetLeft: -20 })).toEqual({ width: 1200, right: 0 });
  expect(dockViewport(1200, { width: 900, offsetLeft: 1500 })).toEqual({ width: 0, right: 0 });
});
it("keeps the desired size while a smaller viewport temporarily clamps it", () => {
  const prefs = chatDock();
  prefs.setState({ width: 700 });
  expect(clampDockWidth(prefs.getState().width!, dockBounds(600, 320))).toBe(600);
  expect(prefs.getState().width).toBe(700);
  expect(clampDockWidth(prefs.getState().width!, dockBounds(1200, 320))).toBe(700);
});

it("persists only a valid desired width as a device preference", () => {
  const data = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  (globalThis as { window?: unknown }).window = { localStorage, addEventListener() {} };
  resetUiStores();
  chatDock().setState({ width: 512 });
  expect(JSON.parse(data.get("lk:pref:chat-dock")!).state).toEqual({ width: 512 });
  resetUiStores();
  expect(chatDock().getState().width).toBe(512);
  for (const width of ["wide", -1, 0, null]) {
    resetUiStores();
    data.set("lk:pref:chat-dock", JSON.stringify({ version: 1, state: { width } }));
    expect(chatDock().getState().width).toBeNull();
  }
});

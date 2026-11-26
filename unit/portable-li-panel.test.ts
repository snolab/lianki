import { test, expect } from "bun:test";
import { Window } from "happy-dom";
import { attachPortableStyle, PORTABLE_PANEL_CSS } from "../src/portable-li-panel";

test("static stylesheet has a safe fallback for browsers without constructed stylesheets", () => {
  const win = new Window();
  Object.defineProperty(win, "CSSStyleSheet", { value: undefined, configurable: true });
  const root = win.document.createElement("div").attachShadow({ mode: "closed" });
  attachPortableStyle(root as never, win.document as never, ":host{display:block}");
  expect(root.querySelector("style")?.textContent).toBe(":host{display:block}");
});

test("the consent prompt's colours are oklch only", () => {
  expect(PORTABLE_PANEL_CSS).not.toMatch(
    /#[0-9a-f]{3,8}\b|rgb\(|hsl\(|Canvas|ButtonFace|LinkText/i,
  );
});

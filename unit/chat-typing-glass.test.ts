import { describe, expect, it } from "bun:test";
import {
  BAR_IN_GLASS_TRANSITION,
  TYPING_EDGE,
  TYPING_FADE_MS,
  TYPING_FILTER,
  TYPING_SCRIM,
  TYPING_SOLID_ALPHA,
  barInGlass,
  GLASS_EDGE_PX,
  glassAroundLog,
  inputInUse,
  panelOpaque,
  showTypingGlass,
  typingGlassLook,
  typingGlassMotion,
} from "@lianki/debug-chat/typing-glass";
import { SHEET_SCRIM } from "@lianki/debug-chat/log-surface";

const base = { typing: true, open: true, fullLog: false };

describe("the typing glass: when it is up", () => {
  it("is up while typing in the open chat", () => {
    expect(showTypingGlass(base)).toBe(true);
  });
  it("is down when the input has no focus", () => {
    expect(showTypingGlass({ ...base, typing: false })).toBe(false);
  });
  it("is down minimized", () => {
    expect(showTypingGlass({ ...base, open: false })).toBe(false);
  });
  it("stays up, and grows with it, for the full-screen log (no sheet over the page)", () => {
    expect(showTypingGlass({ ...base, fullLog: true })).toBe(true);
    expect(showTypingGlass({ ...base, typing: false, fullLog: true })).toBe(true);
    expect(showTypingGlass({ ...base, open: false, fullLog: true })).toBe(false);
  });
  it("is up while the + menu or its file picker is up, as for the focus (owner, 2026-11-05)", () => {
    expect(showTypingGlass({ ...base, typing: false, plusMenu: true })).toBe(true);
    expect(showTypingGlass({ ...base, typing: false, plusMenu: false })).toBe(false);
    expect(showTypingGlass({ ...base, open: false, plusMenu: true })).toBe(false);
  });
  it("the panel leaves its idle look by the same condition", () => {
    const idle = { typing: false, plusMenu: false, micActive: false, fullLog: false };
    expect(panelOpaque(idle)).toBe(false);
    expect(panelOpaque({ ...idle, typing: true })).toBe(true);
    expect(panelOpaque({ ...idle, plusMenu: true })).toBe(true);
    expect(panelOpaque({ ...idle, micActive: true })).toBe(true);
    expect(panelOpaque({ ...idle, fullLog: true })).toBe(true);
    for (const typing of [false, true])
      for (const plusMenu of [false, true])
        expect(panelOpaque({ ...idle, typing, plusMenu })).toBe(inputInUse({ typing, plusMenu }));
  });
  it("around the log's own box: its box and the edge, nothing more", () => {
    const box = { left: 4, width: 300, bottom: 52, height: 700 };
    expect(glassAroundLog(box)).toEqual({
      top: "auto",
      right: "auto",
      left: 4 - GLASS_EDGE_PX,
      width: 300 + 2 * GLASS_EDGE_PX,
      bottom: 52 - GLASS_EDGE_PX,
      height: 700 + 2 * GLASS_EDGE_PX,
    });
  });
  it("depends on nothing about the page around the box", () => {
    // Box-local (owner, 2026-11-03): no embedded / page switch any more.
    expect(Object.keys(base).sort()).toEqual(["fullLog", "open", "typing"]);
  });
});

describe("the typing glass: its look", () => {
  it("frosts with blur and saturate, a light oklch tint per scheme", () => {
    const l = typingGlassLook({ blur: true, reduce: false, lightDark: true });
    expect(l.filter).toBe(TYPING_FILTER);
    expect(l.filter).toBe("blur(12px) saturate(1.4)");
    expect(l.background).toBe(
      `light-dark(oklch(98% 0.01 90 / ${TYPING_SCRIM.light.a}), oklch(18% 0.01 260 / ${TYPING_SCRIM.dark.a}))`,
    );
    expect(l.background).not.toMatch(/rgb|#/);
    expect(l.edge).toBe(`0 0 0 1px ${TYPING_EDGE}`);
    expect(l.edge).not.toMatch(/rgb|#/);
  });
  it("is lighter than the full-screen log's sheet", () => {
    expect(TYPING_SCRIM.light.a).toBeLessThan(SHEET_SCRIM.light.a);
    expect(TYPING_SCRIM.dark.a).toBeLessThan(SHEET_SCRIM.dark.a);
  });
  it("goes near-opaque without backdrop-filter", () => {
    const l = typingGlassLook({ blur: false, reduce: false, lightDark: true });
    expect(l.filter).toBe("none");
    expect(l.background).toContain(`/ ${TYPING_SOLID_ALPHA})`);
  });
  it("goes near-opaque under reduced transparency", () => {
    const l = typingGlassLook({ blur: true, reduce: true, lightDark: true });
    expect(l.filter).toBe("none");
    expect(l.background.match(new RegExp(`/ ${TYPING_SOLID_ALPHA}\\)`, "g"))?.length).toBe(2);
  });
  it("falls back to the page's colour where light-dark() is missing", () => {
    expect(typingGlassLook({ blur: true, reduce: false, lightDark: false }).background).toBe(
      `color-mix(in oklch, var(--background) ${Math.round(TYPING_SCRIM.light.a * 100)}%, transparent)`,
    );
    expect(typingGlassLook({ blur: false, reduce: false, lightDark: false }).background).toBe(
      "color-mix(in oklch, var(--background) 90%, transparent)",
    );
  });
});

describe("the typing glass: its fade", () => {
  it("shows at once and fades in quickly", () => {
    const m = typingGlassMotion(true, false);
    expect(m).toEqual({
      opacity: 1,
      visibility: "visible",
      transition: `opacity ${TYPING_FADE_MS}ms ease-out, visibility 0s linear 0ms`,
    });
    expect(TYPING_FADE_MS).toBe(150);
  });
  it("hides only after the fade out, so it is not painted afterwards", () => {
    expect(typingGlassMotion(false, false)).toEqual({
      opacity: 0,
      visibility: "hidden",
      transition: `opacity ${TYPING_FADE_MS}ms ease-out, visibility 0s linear ${TYPING_FADE_MS}ms`,
    });
  });
  it("does not animate under reduced motion", () => {
    expect(typingGlassMotion(true, true).transition).toBe("none");
    expect(typingGlassMotion(false, true)).toEqual({
      opacity: 0,
      visibility: "hidden",
      transition: "none",
    });
  });
});

describe("the typing glass: one frame (owner, 2026-11-03)", () => {
  it("inside the glass the bar's own box goes: transparent border and tint, no blur", () => {
    expect(barInGlass(true)).toEqual({
      borderColor: "transparent",
      background: "transparent",
      backdropFilter: "none",
      WebkitBackdropFilter: "none",
    });
  });
  it("keeps the border's width and the radius, so nothing moves", () => {
    const o = barInGlass(true) as Record<string, unknown>;
    for (const k of ["borderWidth", "borderStyle", "borderRadius", "padding"])
      expect(o[k]).toBeUndefined();
  });
  it("at rest overrides nothing: the resting border is back", () => {
    expect(barInGlass(false)).toEqual({});
  });
  it("fades with the glass", () => {
    expect(BAR_IN_GLASS_TRANSITION).toContain(`border-color ${TYPING_FADE_MS}ms`);
    expect(BAR_IN_GLASS_TRANSITION).toContain(`background-color ${TYPING_FADE_MS}ms`);
  });
});

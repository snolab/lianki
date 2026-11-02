import { describe, expect, it } from "bun:test";
import {
  TYPING_FADE_MS,
  TYPING_FILTER,
  TYPING_SCRIM,
  TYPING_SOLID_ALPHA,
  showTypingGlass,
  typingGlassLook,
  typingGlassMotion,
} from "@lianki/debug-chat/typing-glass";
import { SHEET_SCRIM } from "@lianki/debug-chat/log-surface";

const base = { typing: true, open: true, fullLog: false, embedded: false };

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
  it("gives way to the full-screen log's own sheet", () => {
    expect(showTypingGlass({ ...base, fullLog: true })).toBe(false);
  });
  it("leaves another site's page alone (embedded)", () => {
    expect(showTypingGlass({ ...base, embedded: true })).toBe(false);
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
  it("hides only after the fade out, so it is not painted or hit afterwards", () => {
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

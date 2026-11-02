import { describe, expect, it } from "bun:test";
import {
  applyTextSize,
  installTextSize,
  asScale,
  effectiveScale,
  setTextSize,
  stepScale,
  TEXT_STEPS,
  textSizeStore,
} from "@/lib/text-size";
import { TEXT_SIZE_BOOT_SCRIPT } from "@/lib/text-size-boot";
import { checkPref } from "@/lib/prefs/schema";

/** Text size (lib/text-size.ts): the steps, the factors, and the before-paint script. */
describe("text size", () => {
  it("steps up and down, clamped at both ends", () => {
    expect(stepScale(1, 1)).toBe(1.1);
    expect(stepScale(1, -1)).toBe(0.9);
    expect(stepScale(1.5, 1)).toBe(1.5);
    expect(stepScale(0.85, -1)).toBe(0.85);
    // Off the steps (set on another device): to the next step that way.
    expect(stepScale(1.15, 1)).toBe(1.2);
    expect(stepScale(1.15, -1)).toBe(1.1);
  });

  it("every step passes the account schema", () => {
    for (const s of TEXT_STEPS) expect(checkPref("text-size.ui", s)).toBe(s);
  });

  it("only scales in range are kept", () => {
    expect(asScale(1.2)).toBe(1.2);
    expect(asScale(2)).toBeUndefined();
    expect(asScale(Number.NaN)).toBeUndefined();
    expect(asScale("1.2")).toBeUndefined();
  });

  it("an area's factor is the app's times its own", () => {
    const s = { ui: 1.2, chat: 1.25, cards: 0.9 };
    expect(effectiveScale(s, "ui")).toBe(1.2);
    expect(effectiveScale(s, "chat")).toBeCloseTo(1.5);
    expect(effectiveScale(s, "cards")).toBeCloseTo(1.08);
  });

  it("applies the choices as custom properties, 100% as none", () => {
    const props = new Map<string, string>();
    const root = {
      style: {
        setProperty: (k: string, v: string) => void props.set(k, v),
        removeProperty: (k: string) => (props.delete(k), ""),
      },
    };
    setTextSize("ui", 1.3);
    setTextSize("chat", 9); // out of range: ignored
    applyTextSize(root);
    expect(props.get("--lk-fs-ui")).toBe("1.3");
    expect(props.has("--lk-fs-chat")).toBe(false);
    textSizeStore.setState({ ui: 1, chat: 1, cards: 1 });
    applyTextSize(root);
    expect(props.size).toBe(0);
  });

  it("follows the store once installed, until unsubscribed", () => {
    const props = new Map<string, string>();
    const root = {
      style: {
        setProperty: (k: string, v: string) => void props.set(k, v),
        removeProperty: (k: string) => (props.delete(k), ""),
      },
    };
    const off = installTextSize(root);
    setTextSize("cards", 1.4);
    expect(props.get("--lk-fs-cards")).toBe("1.4");
    off();
    setTextSize("cards", 1);
    expect(props.get("--lk-fs-cards")).toBe("1.4");
    textSizeStore.setState({ ui: 1, chat: 1, cards: 1 });
  });

  it("the before-paint script sets only valid stored values", () => {
    const run = (stored: unknown) => {
      const props = new Map<string, string>();
      const g = globalThis as unknown as Record<string, unknown>;
      const prev = { localStorage: g.localStorage, document: g.document };
      g.localStorage = { getItem: () => (stored === null ? null : JSON.stringify(stored)) };
      g.document = {
        documentElement: { style: { setProperty: (k: string, v: string) => props.set(k, v) } },
      };
      try {
        new Function(TEXT_SIZE_BOOT_SCRIPT)();
      } finally {
        g.localStorage = prev.localStorage;
        g.document = prev.document;
      }
      return Object.fromEntries(props);
    };
    expect(run({ state: { ui: 1.2, chat: 1, cards: 5 }, version: 1 })).toEqual({
      "--lk-fs-ui": "1.2",
    });
    expect(run({ state: { ui: 1.2 }, version: 2 })).toEqual({});
    expect(run(null)).toEqual({});
  });
});

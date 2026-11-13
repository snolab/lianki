/**
 * The mark after a voice line the Mac verified as his voice: its own sound-wave
 * glyph, never a ✓ (a tick reads as "read" or "done"), and its words readable
 * on a phone, not only as a hover title.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  VOICE_TIP_MS,
  VoiceMark,
  bubbleClock,
  voiceMarkHandlers,
} from "@lianki/debug-chat/VoiceMark";

const html = renderToStaticMarkup(createElement(VoiceMark, { label: "Confirmed as your voice" }));

describe("VoiceMark", () => {
  it("is a button that names itself, so a tap can show its words", () => {
    expect(html).toContain('data-testid="debug-chat-voice-verified"');
    expect(html).toMatch(/^<button[^>]*type="button"/);
    expect(html).toContain('aria-label="Confirmed as your voice"');
    expect(html).toContain('title="Confirmed as your voice"');
  });
  it("draws a sound wave, not the check mark kept for done and answered", () => {
    expect(html).not.toContain("M3.5 8.5l3 3 6-7");
    expect(html).not.toContain("✓");
    expect(html).toContain("M3 6.5v3M6 4.5v7M9 3v10M12 5.5v5");
  });
  it("shows no bubble until tapped, and the bubble does not linger", () => {
    expect(html).not.toContain('role="tooltip"');
    expect(VOICE_TIP_MS).toBeGreaterThan(500);
    expect(VOICE_TIP_MS).toBeLessThanOrEqual(3_000);
  });
});

describe("voiceMarkHandlers", () => {
  const calls = () => {
    const log: string[] = [];
    const e = {
      preventDefault: () => log.push("preventDefault"),
      stopPropagation: () => log.push("stopPropagation"),
    };
    return { log, e, h: voiceMarkHandlers(() => log.push("show")) };
  };
  it("a tap shows the words and stays off the line's own tap", () => {
    const { log, e, h } = calls();
    h.onClick(e);
    expect(log).toEqual(["stopPropagation", "show"]);
  });
  it("a long press (contextmenu) shows them, with neither the browser menu nor the line's details", () => {
    const { log, e, h } = calls();
    h.onContextMenu(e);
    expect(log).toEqual(["preventDefault", "stopPropagation", "show"]);
  });
});

describe("bubbleClock", () => {
  it("shows at once, hides after the delay, and a second tap restarts the clock", async () => {
    const seen: boolean[] = [];
    const hide = { current: undefined as ReturnType<typeof setTimeout> | undefined };
    const show = bubbleClock((on) => seen.push(on), hide, 30);
    show();
    expect(seen).toEqual([true]);
    await new Promise((r) => setTimeout(r, 20));
    show();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([true, true]); // the first clock was cancelled, not fired
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([true, true, false]);
  });
});

describe("VoiceMark, in a DOM", () => {
  it("a tap opens the centred bubble, which closes by itself", async () => {
    const { Window } = await import("happy-dom");
    const win = new Window();
    const g = globalThis as Record<string, unknown>;
    const saved = { window: g.window, document: g.document, act: g.IS_REACT_ACT_ENVIRONMENT };
    Object.assign(g, { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true });
    try {
      const { act } = await import("react");
      const { createRoot } = await import("react-dom/client");
      const host = win.document.createElement("div");
      win.document.body.appendChild(host);
      const root = createRoot(host as never);
      await act(() => root.render(createElement(VoiceMark, { label: "Mine", tipMs: 30 })));
      const button = host.querySelector("button")!;
      const bubble = () => host.querySelector('[role="tooltip"]');
      expect(bubble()).toBeNull();
      let reachedHost = 0;
      // Above the React root: React listens on the host, so stopPropagation shows one level up.
      win.document.body.addEventListener("click", () => reachedHost++);
      win.document.body.addEventListener("contextmenu", () => reachedHost++);
      await act(() => {
        button.dispatchEvent(
          new win.MouseEvent("click", { bubbles: true, cancelable: true }) as never,
        );
      });
      expect(bubble()?.textContent).toBe("Mine");
      // Centred by physical left + physical translate: the same in RTL, where a
      // logical start-1/2 would push the bubble a full width to the side.
      expect(bubble()?.className).toContain("left-1/2");
      expect(bubble()?.className).toContain("-translate-x-1/2");
      expect(bubble()?.className).not.toContain("start-1/2");
      expect(reachedHost).toBe(0);
      await act(() => {
        button.dispatchEvent(
          new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as never,
        );
      });
      expect(reachedHost).toBe(0);
      expect(bubble()).not.toBeNull();
      await act(() => new Promise<void>((r) => setTimeout(r, 60)));
      expect(bubble()).toBeNull();
      await act(() => root.unmount());
    } finally {
      Object.assign(g, {
        window: saved.window,
        document: saved.document,
        IS_REACT_ACT_ENVIRONMENT: saved.act,
      });
      await win.happyDOM.close();
    }
  });
});

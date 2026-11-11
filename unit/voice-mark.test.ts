/**
 * The mark after a voice line the Mac verified as his voice: its own sound-wave
 * glyph, never a ✓ (a tick reads as "read" or "done"), and its words readable
 * on a phone, not only as a hover title.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VOICE_TIP_MS, VoiceMark } from "@lianki/debug-chat/VoiceprintPanel";

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

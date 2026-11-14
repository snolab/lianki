import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PolishedMark, polishedEditor } from "@lianki/debug-chat/PolishedMark";
import { chatExtra, CHAT_LOCALES, EXTRA, EXTRA_CONTEXT } from "@lianki/debug-chat/chat-ui-locales";

const render = (by?: string) =>
  renderToStaticMarkup(
    createElement(PolishedMark, {
      by,
      icon: createElement("span", null, "★"),
      label: "Polished",
      showRaw: false,
      onToggle: () => {},
      rawText: "Original transcript",
    }),
  );

describe("polished mark editor identity", () => {
  it("auto has an automatic symbol and localized attribution in both labels and raw tooltip", () => {
    const words = chatExtra();
    const html = render("auto");
    const label = words.polishedBy.replace("{name}", words.polishedAuto);
    expect(html).toContain('data-editor="auto"');
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`title="${label}"`);
    expect(html).toContain(`>${label}</span>Original transcript`);
    expect(html).not.toContain("debug-chat-lane-mark");
  });
  it("lane labels and aliases use the existing lane avatar and display name", () => {
    const html = render("codex");
    expect(html).toContain('data-editor="codex"');
    expect(html).toContain('data-testid="debug-chat-lane-mark"');
    expect(html).toContain('data-lane="codex"');
    expect(html).toContain(chatExtra().polishedBy.replace("{name}", "coco"));
    expect(polishedEditor("coco", "Auto")).toMatchObject({
      name: "coco",
      lane: "codex",
      auto: false,
    });
    expect(polishedEditor("【claude】", "Auto")).toMatchObject({ name: "小克", lane: "claude" });
    expect(polishedEditor("agy", "Auto")).toMatchObject({ name: "杰咪", lane: "agy" });
  });
  it("legacy messages without by keep the old label and have no editor badge", () => {
    const html = render();
    expect(html).toContain('aria-label="Polished"');
    expect(html).not.toContain("debug-chat-polished-by");
    expect(polishedEditor("  ", "Auto")).toBeNull();
  });
  it("unknown assistant labels keep their name and get a generated avatar", () => {
    expect(render("Custom helper")).toContain('data-testid="debug-chat-auto-mark"');
    expect(polishedEditor("Custom helper", "Auto")).toMatchObject({
      name: "Custom helper",
      lane: null,
      auto: false,
    });
  });
  it("all 16 locales keep the editor placeholder and context", () => {
    for (const lang of CHAT_LOCALES) {
      expect(EXTRA[lang].polishedBy).toContain("{name}");
      expect(EXTRA[lang].polishedAuto.length).toBeGreaterThan(0);
    }
    expect(EXTRA_CONTEXT.polishedBy).toContain("WHO polished");
    expect(EXTRA_CONTEXT.polishedAuto).toContain("automatic wording cleanup");
  });
});

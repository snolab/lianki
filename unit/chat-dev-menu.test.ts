/**
 * The chat menu's Dev group (owner, 2026-11-08: no internal diagnostics in the
 * user-facing chat UI): the latency readout, the mic adaptation readout and the
 * echo-cancellation A/B live in a collapsed group shown on the owner's pages only.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DevMenuGroup } from "@lianki/debug-chat/DevMenuGroup";
import { CHAT_STRINGS_EN } from "@lianki/debug-chat/wire";

const group = (owner: boolean) =>
  renderToStaticMarkup(
    createElement(
      DevMenuGroup,
      { owner, label: CHAT_STRINGS_EN.devGroup },
      createElement("span", { "data-testid": "inside" }),
    ),
  );

describe("the chat menu's Dev group", () => {
  it("renders nothing for anyone but the owner", () => {
    expect(group(false)).toBe("");
  });

  it("is a collapsed group with its heading on the owner's pages", () => {
    const html = group(true);
    expect(html).toContain('data-testid="debug-menu-dev"');
    expect(html).toContain(`>${CHAT_STRINGS_EN.devGroup}</summary>`);
    expect(html).not.toContain("open");
    expect(html).toContain('data-testid="inside"');
  });

  it("holds the three internals, and none of them sits outside it", () => {
    const src = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
    const open = src.indexOf("<DevMenuGroup owner={owner}");
    const close = src.indexOf("</DevMenuGroup>");
    expect(open).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(open);
    for (const id of ["debug-menu-aec", "debug-menu-latency", "debug-menu-adapt"]) {
      const at = src.indexOf(`data-testid="${id}"`);
      expect(at).toBeGreaterThan(open);
      expect(at).toBeLessThan(close);
      expect(src.indexOf(`data-testid="${id}"`, at + 1)).toBe(-1);
    }
  });
});

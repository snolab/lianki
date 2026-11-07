/**
 * The state tree lives in the chat's + menu (owner, 2026-11-03: 状态树藏到加号里):
 * a "View" group with one row, and a dot on the + for the eval/preview sessions
 * the old tree button counted. Rendered on the server: markup only.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachButton, AttachMenu } from "@lianki/debug-chat/AttachMenu";
import { CHAT_STRINGS_EN } from "@lianki/debug-chat/wire";

const t = CHAT_STRINGS_EN;
const noop = () => {};
const menu = (p: Partial<Parameters<typeof AttachMenu>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(AttachMenu, {
      t,
      sel: null,
      items: [{ id: "create:link", title: "Add a link", onPick: noop }],
      tree: false,
      onTree: noop,
      onAttachSelection: noop,
      onClose: noop,
      ...p,
    }),
  );
const order = (html: string) =>
  [...html.matchAll(/data-testid="(debug-chat-attach-[a-z-]+)"/g)]
    .map((m) => m[1])
    .filter((id) => id !== "debug-chat-attach-menu");

describe("the + menu's View group", () => {
  it("comes last, after Add and Attach to message", () => {
    const html = menu();
    expect(order(html)).toEqual([
      "debug-chat-attach-add",
      "debug-chat-attach-selection",
      "debug-chat-attach-file",
      "debug-chat-attach-media",
      "debug-chat-attach-tree",
    ]);
    expect(html.indexOf(t.attachGroupMessage)).toBeLessThan(html.indexOf(t.attachGroupView));
    expect(html).toContain(t.attachTree);
  });

  it("History (docs/chat-history.md) comes before the tree, only when the host keeps it", () => {
    const html = menu({ attach: false, onHistory: noop });
    expect(order(html)).toEqual(["debug-chat-attach-history", "debug-chat-attach-tree"]);
    expect(html).toContain(`>${t.chatHistory}<`);
    expect(menu({ attach: false })).not.toContain("debug-chat-attach-history");
  });

  it("is a checkbox item, checked while the tree is open", () => {
    expect(menu()).toMatch(/role="menuitemcheckbox" aria-checked="false"/);
    expect(menu({ tree: true })).toMatch(/role="menuitemcheckbox" aria-checked="true"/);
  });

  it("shows only View without attach (cross-site iframe, chat unavailable)", () => {
    const html = menu({ attach: false });
    expect(order(html)).toEqual(["debug-chat-attach-tree"]);
    expect(html).not.toContain(`>${t.attachGroupAdd}<`);
    expect(html).not.toContain(`>${t.attachGroupMessage}<`);
    expect(html).toContain(`aria-label="${t.attachGroupView}"`);
  });

  it("counts the eval/preview sessions on the tree row", () => {
    expect(menu()).not.toContain("debug-chat-attach-tree-evals");
    const html = menu({ sessions: 2, sessionsLabel: "2 connections" });
    expect(html).toMatch(/data-testid="debug-chat-attach-tree-evals"[^>]*>2</);
    expect(html).toContain('aria-description="2 connections"');
  });
});

describe("the + button", () => {
  const button = (p: Partial<Parameters<typeof AttachButton>[0]> = {}) =>
    renderToStaticMarkup(createElement(AttachButton, { t, open: false, onToggle: noop, ...p }));
  it("has a dot while there are sessions, pulsing when code just ran", () => {
    expect(button()).not.toContain("debug-chat-evals");
    expect(button({ sessions: 1 })).toMatch(/data-testid="debug-chat-evals"/);
    expect(button({ sessions: 1 })).not.toContain("animate-pulse");
    expect(button({ sessions: 1, ran: true })).toContain("animate-pulse");
  });
});

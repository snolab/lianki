/**
 * The chat's link menu mounted in happy-dom: a tap or right-click on a chat
 * link opens it; "open" goes through the router for this origin or a plain
 * anchor elsewhere; production is offered on preview; copy reports its status;
 * the system share falls back to a plain link when sharing fails; arrows move
 * focus; closing returns focus to the link.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { stubGlobals } from "./support/globals";
import { ChatLinkMenu, openChatLink } from "@lianki/debug-chat/ChatLinkMenu";
import { ChatLink } from "@lianki/debug-chat/RichText";

let win: Window;
let restore: () => void;
let root: Root;
let host: HTMLElement;
let clipboard: string[];
let clipboardFails = false;
let share: ((d: { url: string }) => Promise<void>) | undefined;

function setup(url: string) {
  win = new Window({ url });
  const proto = win.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.showPopover = function () {};
  proto.hidePopover = function () {};
  clipboard = [];
  const nav = {
    clipboard: {
      writeText: async (t: string) => {
        if (clipboardFails) throw new Error("denied");
        clipboard.push(t);
      },
    },
    ...(share ? { share } : {}),
  };
  restore = stubGlobals({
    window: win,
    document: win.document,
    location: win.location,
    navigator: nav,
    HTMLElement: win.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  root = createRoot(host);
}

const q = (sel: string) => win.document.querySelector(sel) as unknown as HTMLElement | null;
const click = async (el: HTMLElement | null) => {
  await act(async () => {
    el!.click();
  });
};

beforeEach(() => {
  clipboardFails = false;
  share = undefined;
});
afterEach(async () => {
  await act(async () => root.unmount());
  restore();
  await win.happyDOM.close();
});

describe("chat link menu", () => {
  it("a tap opens it; open goes through the router on this origin; close refocuses the link", async () => {
    setup("https://lianki.com/en");
    const opened: string[] = [];
    await act(async () =>
      root.render(
        createElement(ChatLink, {
          href: "https://lianki.com/dev/flags#a",
          onOpenPage: (p: string) => opened.push(p),
          children: "flags",
        }),
      ),
    );
    await click(q('[data-testid="debug-chat-link"]'));
    expect(q('[data-testid="chat-link-menu"]')).not.toBeNull();
    expect(q('[data-testid="chat-link-prod"]')).toBeNull();
    await click(q('[data-testid="chat-link-open"]'));
    expect(opened).toEqual(["/dev/flags#a"]);
    expect(q('[data-testid="chat-link-menu"]')).toBeNull();

    // Right-click opens it too; the close button shuts it.
    await act(async () => {
      q('[data-testid="debug-chat-link"]')!.dispatchEvent(
        new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as never,
      );
    });
    expect(q('[data-testid="chat-link-menu"]')).not.toBeNull();
    await click(q("button[aria-label]:not([role])"));
    expect(q('[data-testid="chat-link-menu"]')).toBeNull();
    expect(win.document.activeElement?.getAttribute("data-testid")).toBe("debug-chat-link");
  });

  it("on preview: a production action; copy reports success and failure; arrows move focus", async () => {
    setup("https://preview.lianki.com/en");
    let closed = 0;
    await act(async () =>
      root.render(
        createElement(ChatLinkMenu, {
          href: "https://preview.lianki.com/my",
          prod: "https://lianki.com/my",
          forceProd: false,
          onClose: () => closed++,
        }),
      ),
    );
    expect(q('[data-testid="chat-link-prod"]')).not.toBeNull();
    await click(q('[data-testid="chat-link-copy"]'));
    expect(clipboard).toEqual(["https://preview.lianki.com/my"]);
    const ok = q('[role="status"]')!.textContent;
    clipboardFails = true;
    await click(q('[data-testid="chat-link-copy"]'));
    expect(q('[role="status"]')!.textContent).not.toBe(ok);

    const menu = q('[data-testid="chat-link-menu"]')!;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    items[0]!.focus();
    const key = async (k: string) =>
      act(async () => {
        menu.dispatchEvent(
          new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }) as never,
        );
      });
    await key("ArrowDown");
    expect(win.document.activeElement).toBe(items[1] as never);
    await key("ArrowUp");
    await key("ArrowUp");
    expect(win.document.activeElement).toBe(items.at(-1) as never);
    await key("a");
    // Pointer and context-menu events stay inside the menu.
    await act(async () => {
      for (const t of ["pointerdown", "contextmenu"])
        menu.dispatchEvent(new win.MouseEvent(t, { bubbles: true, cancelable: true }) as never);
    });

    // No navigator.share here: the system item is a plain link that opens elsewhere.
    const native = q('[data-testid="chat-link-system-native"]')!;
    let anchors = 0;
    const orig = win.HTMLAnchorElement.prototype.click;
    win.HTMLAnchorElement.prototype.click = function () {
      anchors++;
    };
    await act(async () => {
      native.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true }) as never,
      );
    });
    win.HTMLAnchorElement.prototype.click = orig;
    expect(anchors).toBe(1);
    expect(closed).toBe(1);

    await act(async () => {
      menu.dispatchEvent(Object.assign(new win.Event("toggle"), { newState: "closed" }) as never);
    });
  });

  it("system share: aborted closes, failure falls back to the plain link", async () => {
    const errors = [Object.assign(new Error("x"), { name: "AbortError" }), new Error("no")];
    const calls: string[] = [];
    share = async (d) => {
      calls.push(d.url);
      throw errors.shift();
    };
    setup("https://lianki.com/en");
    let closed = 0;
    await act(async () =>
      root.render(
        createElement(ChatLinkMenu, {
          href: "https://lianki.com/my?site=prod",
          prod: "https://lianki.com/my?site=prod",
          forceProd: true,
          onClose: () => closed++,
        }),
      ),
    );
    await click(q('[data-testid="chat-link-system"]'));
    expect(closed).toBe(1);
    await click(q('[data-testid="chat-link-system"]'));
    expect(calls).toHaveLength(2);
    expect(q('[data-testid="chat-link-system-native"]')).not.toBeNull();
  });

  it("a succeeded share closes it; openChatLink ignores non-http links", async () => {
    share = async () => {};
    setup("https://lianki.com/en");
    let closed = 0;
    await act(async () =>
      root.render(
        createElement(ChatLinkMenu, {
          href: "https://example.test/x",
          prod: null,
          forceProd: false,
          onClose: () => closed++,
        }),
      ),
    );
    await click(q('[data-testid="chat-link-system"]'));
    expect(closed).toBe(1);
    const opened: string[] = [];
    openChatLink("javascript:alert(1)", (p) => opened.push(p));
    expect(opened).toEqual([]);
  });
});

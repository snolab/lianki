/**
 * A chat line's details (MessageDetails.tsx) mounted in happy-dom: a plain
 * click on the line opens nothing; its context menu (right-click), a touch
 * long press and Enter on the focused line open them; a link keeps its own
 * context menu.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { importReactDomClient, stubGlobals } from "./support/globals";
import { useMessageDetails } from "@lianki/debug-chat/MessageDetails";
import { LONG_PRESS_MS } from "@lianki/debug-chat/long-press";
import type { ChatMessage } from "@lianki/debug-chat/wire";

const { createRoot } = await importReactDomClient();

let win: Window;
let restore: () => void;
let root: Root;

const line: ChatMessage = { id: "m1", from: "agent", label: "", text: "Hello", at: 1 };

function Line() {
  const details = useMessageDetails("Message details");
  return createElement(
    "div",
    null,
    createElement(
      "span",
      { ...details.forMessage(line, "Li"), "data-testid": "line" },
      "Hello ",
      createElement("a", { href: "https://lianki.com/", "data-testid": "link" }, "link"),
    ),
    details.popup,
  );
}

beforeEach(async () => {
  win = new Window({ url: "https://lianki.com/" });
  const proto = win.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.showPopover = function () {};
  proto.hidePopover = function () {};
  restore = stubGlobals({
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    innerWidth: 1024,
    innerHeight: 768,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(createElement(Line)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  restore();
  await win.happyDOM.close();
});

const q = (sel: string) => win.document.querySelector(sel) as unknown as HTMLElement | null;
const open = () => q('[data-testid="debug-chat-message-details"]');
const fire = async (el: HTMLElement, ev: Event) => {
  await act(async () => {
    el.dispatchEvent(ev);
  });
};
const pointer = (type: string, pointerType: string, x = 0) =>
  new win.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType,
    clientX: x,
    clientY: 0,
  }) as unknown as Event;

describe("message details", () => {
  it("a click (or a double click) on a line opens nothing", async () => {
    await act(async () => q('[data-testid="line"]')!.click());
    await fire(
      q('[data-testid="line"]')!,
      new win.MouseEvent("click", { bubbles: true, detail: 2 }) as never,
    );
    expect(open()).toBeNull();
  });

  it("the line's context menu opens them, the browser's menu stays shut", async () => {
    const ev = new win.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    }) as unknown as Event;
    await fire(q('[data-testid="line"]')!, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(open()?.textContent).toContain("Message details");
    expect(open()?.textContent).toContain('"id": "m1"');
    await fire(open()!, Object.assign(new win.Event("toggle"), { newState: "closed" }) as never);
    expect(open()).toBeNull();
  });

  it("a link keeps the browser's context menu", async () => {
    const ev = new win.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    }) as unknown as Event;
    await fire(q('[data-testid="link"]')!, ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(open()).toBeNull();
  });

  it("Enter on the focused line opens them; other keys do not", async () => {
    const el = q('[data-testid="line"]')!;
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("aria-haspopup")).toBe("dialog");
    await fire(el, new win.KeyboardEvent("keydown", { key: "a", bubbles: true }) as never);
    expect(open()).toBeNull();
    await fire(
      el,
      new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as never,
    );
    expect(open()).not.toBeNull();
  });

  it("a touch long press opens them once; the contextmenu after it is not taken twice", async () => {
    const el = q('[data-testid="line"]')!;
    await fire(el, pointer("pointerdown", "touch"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, LONG_PRESS_MS + 50));
    });
    expect(open()).not.toBeNull();
    const ev = new win.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    }) as unknown as Event;
    await fire(el, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(open()).not.toBeNull();
    await fire(el, pointer("pointerup", "touch"));
  });

  it("a short tap, a moved finger, a mouse press or a press on the link open nothing", async () => {
    const el = q('[data-testid="line"]')!;
    await fire(el, pointer("pointerdown", "touch"));
    await fire(el, pointer("pointerup", "touch"));
    await fire(el, pointer("pointerdown", "touch"));
    await fire(el, pointer("pointermove", "touch", 40));
    await fire(el, pointer("pointerdown", "mouse"));
    await fire(q('[data-testid="link"]')!, pointer("pointerdown", "touch"));
    await fire(el, pointer("pointercancel", "touch"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, LONG_PRESS_MS + 50));
    });
    expect(open()).toBeNull();
  });
});

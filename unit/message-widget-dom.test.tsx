/**
 * Message widgets in happy-dom: taps, the calculator, the slider, his form's
 * submit, and the sandboxed frame's messages (only its own count).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactElement } from "react";
import { stubGlobals } from "./support/globals";
import type { WidgetHost } from "@lianki/debug-chat/MessageWidget";

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function mount(make: (host: WidgetHost) => ReactElement) {
  const win = new Window({ url: "https://lianki.com/en" });
  const restore = stubGlobals({
    window: win,
    document: win.document,
    DOMParser: win.DOMParser,
    FormData: win.FormData,
    MessageEvent: win.MessageEvent,
    addEventListener: win.addEventListener.bind(win),
    removeEventListener: win.removeEventListener.bind(win),
    dispatchEvent: win.dispatchEvent.bind(win),
    matchMedia: win.matchMedia.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const replies: string[] = [];
  const submits: string[] = [];
  const host: WidgetHost = {
    onReply: (t) => replies.push(t),
    onSubmit: (t) => submits.push(t),
    labels: {
      use: "Use",
      invalid: "Not a calculation",
      hint: "Fills your reply",
      scriptsOff: "Scripts off",
    },
    htmlMaxHeight: 300,
  };
  const { createRoot } = await import("react-dom/client");
  const el = win.document.createElement("div");
  win.document.body.append(el);
  const root = createRoot(el as never);
  // The message around a widget, as React sees it: its taps must never reach it.
  const reached = { n: 0 };
  const bump = () => reached.n++;
  await act(async () =>
    root.render(
      createElement("div", { onClick: bump, onPointerDown: bump, onKeyDown: bump }, make(host)),
    ),
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    restore();
    await win.happyDOM.close();
  };
  const q = <T,>(s: string) => el.querySelector(s) as unknown as T;
  const all = <T,>(s: string) => [...el.querySelectorAll(s)] as unknown as T[];
  return { win, el, q, all, replies, submits, reached };
}

/** Taps, keys and presses inside a widget stay inside it (they never reach the message). */
async function poke(p: { win: Window; reached: { n: number } }, el: Element) {
  const W = p.win as unknown as {
    MouseEvent: typeof MouseEvent;
    KeyboardEvent: typeof KeyboardEvent;
    PointerEvent?: typeof Event;
    Event: typeof Event;
  };
  const before = p.reached.n;
  await act(async () => {
    el.dispatchEvent(new W.MouseEvent("click", { bubbles: true }));
    el.dispatchEvent(new (W.PointerEvent ?? W.Event)("pointerdown", { bubbles: true }));
    el.dispatchEvent(new W.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  });
  return p.reached.n - before;
}

const setValue = (input: HTMLInputElement, v: string) => {
  const proto = Object.getPrototypeOf(input) as object;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, v);
  input.dispatchEvent(
    new (input.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", {
      bubbles: true,
    }),
  );
};

describe("JSON widgets", () => {
  test("buttons, calculator and slider fill his reply", async () => {
    const { MessageWidget } = await import("@lianki/debug-chat/MessageWidget");
    const spec = (s: unknown) => JSON.stringify(s);
    const p = await mount((host) =>
      createElement(
        "div",
        null,
        createElement(MessageWidget, {
          spec: spec({ type: "buttons", options: ["复习", "新词"] }),
          host,
        }),
        createElement(MessageWidget, { spec: spec({ type: "calc", expr: "20*30" }), host }),
        createElement(MessageWidget, {
          spec: spec({
            type: "slider",
            label: "每天学习",
            min: 5,
            max: 60,
            step: 5,
            value: 20,
            unit: "分钟",
          }),
          host,
        }),
      ),
    );
    await act(async () =>
      p.all<HTMLButtonElement>("[data-testid=debug-chat-widget-option]")[1]!.click(),
    );
    expect(p.replies).toEqual(["新词"]);
    const uses = p.all<HTMLButtonElement>("[data-testid=debug-chat-widget-use]");
    await act(async () => uses[0]!.click());
    expect(p.replies.at(-1)).toBe("20*30 = 600");
    await act(async () =>
      setValue(p.q<HTMLInputElement>("[data-testid=debug-chat-widget-calc]"), "2+"),
    );
    expect(p.q<HTMLElement>("[data-testid=debug-chat-widget-result]").textContent).toBe(
      "Not a calculation",
    );
    await act(async () =>
      setValue(p.q<HTMLInputElement>("[data-testid=debug-chat-widget-slider]"), "35"),
    );
    await act(async () => uses[1]!.click());
    expect(p.replies.at(-1)).toBe("每天学习: 35 分钟");
    for (const w of p.all<Element>("[data-testid=debug-chat-widget]"))
      expect(await poke(p, w)).toBe(0);
  });

  test("a table renders its cells", async () => {
    const { MessageWidget } = await import("@lianki/debug-chat/MessageWidget");
    const p = await mount((host) =>
      createElement(MessageWidget, {
        spec: JSON.stringify({
          type: "table",
          title: "词",
          columns: ["词", "意思"],
          rows: [["复习", "review"]],
        }),
        host,
      }),
    );
    expect(p.all<HTMLElement>("td").map((t) => t.textContent)).toEqual(["复习", "review"]);
    expect(p.all<HTMLElement>("th").map((t) => t.textContent)).toEqual(["词", "意思"]);
  });
});

describe("HTML widgets", () => {
  test("his form submits as his line, never anywhere else", async () => {
    const { HtmlInline } = await import("@lianki/debug-chat/HtmlInline");
    const form = `<form action="/action_page.php" method="get">
      <label for="fname">First name:</label><input type="text" id="fname" name="fname" value="John">
      <label for="lname">Last name:</label><input type="text" id="lname" name="lname" value="Doe">
      <button type="submit">Submit</button>
      <button type="submit" formtarget="_blank">Submit to a new window</button>
    </form>`;
    const p = await mount((host) => createElement(HtmlInline, { html: form, host }));
    const f = p.q<HTMLFormElement>("form");
    expect(f.hasAttribute("action")).toBe(false);
    const W = p.win as unknown as { SubmitEvent?: typeof SubmitEvent; Event: typeof Event };
    await act(async () => {
      f.dispatchEvent(new W.Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(p.submits).toEqual(["↳ /action_page.php: fname=John, lname=Doe"]);
    expect(await poke(p, p.q<Element>("[data-testid=debug-chat-html-inline]"))).toBe(0);
  });

  test("controls keep their state: checked, selected, textarea, disabled; links go through the chat", async () => {
    const { HtmlInline } = await import("@lianki/debug-chat/HtmlInline");
    const html = `<form name="prefs">
      <input type="checkbox" name="daily" value="yes" checked>
      <select name="lang"><option value="en">English</option><option value="zh" selected>中文</option></select>
      <textarea name="note" rows="2">hi</textarea>
      <input type="text" name="ro" value="x" disabled readonly maxlength="4">
      <table><tr><td colspan="2">c</td></tr></table>
      <a href="https://lianki.com/words">words</a> <a href="javascript:void(0)">no</a>
      <button type="submit" name="go" value="1" formaction="/save">Save</button>
    </form>`;
    const p = await mount((host) => createElement(HtmlInline, { html, host }));
    // A javascript: link: never a frame; the link is dropped to its text, the note says so.
    expect(p.q<HTMLIFrameElement>("iframe")).toBeNull();
    expect(p.q<HTMLElement>("[data-testid=debug-chat-html-scripts-off]").textContent).toBe(
      "Scripts off",
    );
    expect(p.el.innerHTML).not.toContain("javascript:");
    await cleanup?.();
    cleanup = null;
    const safe = html.replace('<a href="javascript:void(0)">no</a>', "");
    const q = await mount((host) => createElement(HtmlInline, { html: safe, host }));
    expect(q.q<HTMLInputElement>("input[name=daily]").checked).toBe(true);
    expect(q.q<HTMLSelectElement>("select").value).toBe("zh");
    expect(q.q<HTMLTextAreaElement>("textarea").value).toBe("hi");
    expect(q.q<HTMLInputElement>("input[name=ro]").disabled).toBe(true);
    expect(q.q<HTMLElement>("td").getAttribute("colspan")).toBe("2");
    expect(q.q<HTMLAnchorElement>("[data-testid=debug-chat-link]").getAttribute("href")).toContain(
      "/words",
    );
    const W = q.win as unknown as { Event: typeof Event };
    await act(async () => {
      q.q<HTMLFormElement>("form").dispatchEvent(
        new W.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(q.submits[0]).toMatch(/^↳ prefs: daily=yes, lang=zh, note=hi/);
  });

  test("a script widget never produces an iframe: script stripped, a note shown", async () => {
    const { HtmlInline } = await import("@lianki/debug-chat/HtmlInline");
    const leak = `<p>hi</p><script>location.href="http://127.0.0.1:9/leak?v=1"</script>
      <button onclick="location='http://127.0.0.1:9/x'">A</button>
      <img src=x onerror="fetch('http://127.0.0.1:9/y')">`;
    const p = await mount((host) => createElement(HtmlInline, { html: leak, host }));
    expect(p.q<HTMLIFrameElement>("iframe")).toBeNull();
    expect(p.q<HTMLElement>("[data-testid=debug-chat-html-scripts-off]")).not.toBeNull();
    const html = p.el.innerHTML;
    expect(html).not.toMatch(/<script|onclick|onerror|127\.0\.0\.1/);
    expect(p.q<HTMLButtonElement>("button").textContent).toBe("A");
    expect(p.q<HTMLElement>("p").textContent).toBe("hi");
  });

  test("the frame component (kept, not rendered): only its own messages count", async () => {
    const { HtmlWidget } = await import("@lianki/debug-chat/HtmlWidget");
    const p = await mount((host) =>
      createElement(HtmlWidget, { html: `<button onclick="lianki.reply('A')">A</button>`, host }),
    );
    const frame = p.q<HTMLIFrameElement>("[data-testid=debug-chat-html-widget]");
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    const send = async (data: unknown, source: unknown) =>
      act(async () => {
        const ev = new (p.win as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent(
          "message",
          { data },
        );
        Object.defineProperty(ev, "source", { value: source });
        p.win.dispatchEvent(ev as never);
      });
    // Another window's message: ignored.
    await send({ lk: "reply", text: "spoofed" }, {});
    expect(p.replies).toEqual([]);
    const own = frame.contentWindow;
    await send({ lk: "reply", text: "A" }, own);
    await send({ lk: "action", name: "go", fields: { x: "1" } }, own);
    await send({ lk: "height", h: 9999 }, own);
    await send({ lk: "eval", code: "1" }, own);
    expect(p.replies).toEqual(["A", "go: x=1"]);
    expect(frame.style.height).toBe("300px");
    expect(await poke(p, frame)).toBe(0);
  });
});

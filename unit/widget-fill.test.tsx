/**
 * Voice fill: an agent's patch fills the named fields of his form widget,
 * never hidden or disabled ones, never submits unless his own latest line asked,
 * only in his own thread; the chip applies once and flashes on tap.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactElement } from "react";
import { globalDescriptor, restoreGlobal, stubGlobals } from "./support/globals";
import type { WidgetHost } from "@lianki/debug-chat/MessageWidget";
import {
  makeFillStore,
  parseFill,
  submitAsked,
  SUBMIT_WINDOW_MS,
} from "@lianki/debug-chat/widget-fill";
import { lineTier, richOf, widgetLine } from "@lianki/debug-chat/rich-text";

const FORM = `<form action="/action_page.php" method="get">
  <label for="fname">First name:</label><input type="text" id="fname" name="fname">
  <label for="lname">Last name:</label><input type="text" id="lname" name="lname">
  <input type="hidden" name="token" value="keep">
  <input type="text" name="locked" value="x" disabled>
  <input type="checkbox" name="daily">
  <select name="lang"><option value="en">English</option><option value="zh">中文</option></select>
  <button type="submit">Submit</button>
</form>`;

describe("patches", () => {
  test("only well-formed patches, bounded", () => {
    expect(
      parseFill(JSON.stringify({ line: "213a9a70", fields: { fname: "Taku", n: 3, ok: true } })),
    ).toEqual({
      line: "213a9a70",
      fields: { fname: "Taku", n: "3", ok: "on" },
      submit: false,
    });
    for (const bad of [
      "nope",
      "[]",
      JSON.stringify({ line: "../x", fields: { a: "1" } }),
      JSON.stringify({ line: "a", fields: {} }),
      JSON.stringify({ line: "a", fields: { "bad name!": "1" } }),
      JSON.stringify({ line: "a", fields: [] }),
      "x".repeat(9000),
    ])
      expect(parseFill(bad)).toBeNull();
    expect(parseFill(JSON.stringify({ line: "a", fields: { a: "1" }, submit: true }))?.submit).toBe(
      true,
    );
  });

  test("submit only when his own latest line, from the last minute, asked", () => {
    const now = 1_000_000;
    expect(submitAsked({ text: "提交", at: now - 1000 }, now)).toBe(true);
    expect(submitAsked({ text: "ok submit it", at: now - 1000 }, now)).toBe(true);
    expect(submitAsked({ text: "first name Taku", at: now - 1000 }, now)).toBe(false);
    expect(submitAsked({ text: "提交", at: now - SUBMIT_WINDOW_MS - 1 }, now)).toBe(false);
    expect(submitAsked({ text: "submitted?", at: now }, now)).toBe(false);
    expect(submitAsked(null, now)).toBe(false);
  });

  test("a patch only rides on an agent line in his own thread", async () => {
    const g = globalThis as { DOMParser?: unknown };
    const had = globalDescriptor("DOMParser");
    const win = new Window();
    g.DOMParser = win.DOMParser;
    const spec =
      "```lianki-fill\n" + JSON.stringify({ line: "a1", fields: { fname: "T" } }) + "\n```";
    const has = (m: { from: string; thread?: string }) =>
      JSON.stringify(richOf(spec, lineTier(m), widgetLine(m)).nodes).includes("data-fill");
    expect(has({ from: "agent", thread: "owner" })).toBe(true);
    expect(has({ from: "agent", thread: "t:friend-account" })).toBe(false);
    expect(has({ from: "owner", thread: "owner" })).toBe(false);
    restoreGlobal("DOMParser", had);
    await win.happyDOM.close();
  });

  test("the store applies a patch once, replays it to a late form, and flashes on demand", () => {
    const s = makeFillStore();
    const seen: [string, boolean][] = [];
    const p = { line: "L", fields: { a: "1" }, submit: false };
    expect(s.apply("P1", p)).toBe(true);
    expect(s.apply("P1", p)).toBe(false);
    const off = s.on("L", (q, flashOnly) => seen.push([q.fields.a!, flashOnly]));
    s.flash("L");
    s.flash("other");
    off();
    s.flash("L");
    expect(seen).toEqual([
      ["1", false],
      ["1", true],
    ]);
  });
});

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function mount(
  make: (host: WidgetHost) => ReactElement,
  own: { text?: string; at?: number } | null = null,
) {
  const win = new Window({ url: "https://lianki.com/en" });
  const restore = stubGlobals({
    window: win,
    document: win.document,
    DOMParser: win.DOMParser,
    FormData: win.FormData,
    Event: win.Event,
    CSS: win.CSS ?? { escape: (s: string) => s.replace(/["\\]/g, "\\$&") },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const submits: string[] = [];
  const host: WidgetHost = {
    onReply: () => {},
    onSubmit: (t) => submits.push(t),
    labels: {
      use: "Use",
      invalid: "x",
      hint: "h",
      scriptsOff: "Scripts off",
      filled: "Filled {n} · show form",
    },
    lastOwn: () => own,
  };
  const { createRoot } = await import("react-dom/client");
  const el = win.document.createElement("div");
  win.document.body.append(el);
  const root = createRoot(el as never);
  await act(async () => root.render(make(host)));
  cleanup = async () => {
    await act(async () => root.unmount());
    restore();
    await win.happyDOM.close();
  };
  const q = <T,>(s: string) => el.querySelector(s) as unknown as T;
  return { win, el, q, submits, root, host };
}

describe("filling his form", () => {
  test("named fields filled and flashed; hidden and disabled ones untouched; no submit", async () => {
    const { HtmlInline } = await import("@lianki/debug-chat/HtmlInline");
    const { FillChip } = await import("@lianki/debug-chat/FillChip");
    const store = makeFillStore();
    const patch = JSON.stringify({
      line: "form1",
      fields: {
        fname: "Taku",
        lname: "Miao",
        token: "evil",
        locked: "y",
        daily: "yes",
        lang: "zh",
        nope: "1",
      },
      submit: true,
    });
    const p = await mount(
      (host) =>
        createElement(
          "div",
          null,
          createElement(HtmlInline, { html: FORM, host, lineId: "form1", store }),
          createElement(FillChip, { spec: patch, patchId: "fill1", host, store }),
        ),
      // His latest line did not ask to submit.
      { text: "first name Taku, last name Miao", at: Date.now() },
    );
    await act(async () => {});
    expect(p.q<HTMLInputElement>("input[name=fname]").value).toBe("Taku");
    expect(p.q<HTMLInputElement>("input[name=lname]").value).toBe("Miao");
    expect(p.q<HTMLInputElement>("input[name=token]").value).toBe("keep");
    expect(p.q<HTMLInputElement>("input[name=locked]").value).toBe("x");
    expect(p.q<HTMLInputElement>("input[name=daily]").checked).toBe(true);
    expect(p.q<HTMLSelectElement>("select[name=lang]").value).toBe("zh");
    expect(p.q<HTMLInputElement>("input[name=fname]").hasAttribute("data-filled")).toBe(true);
    expect(p.submits).toEqual([]);
    const chip = p.q<HTMLButtonElement>("[data-testid=debug-chat-fill-chip]");
    expect(chip.textContent).toBe("Filled 7 · show form");
    expect(p.q<HTMLElement>("[data-widget-line=form1]")).not.toBeNull();
    // His own edit after the fill stays: a re-render does not fill again.
    const fname = p.q<HTMLInputElement>("input[name=fname]");
    fname.value = "Taku M.";
    await act(async () => chip.click());
    expect(fname.value).toBe("Taku M.");
    // The chip keeps its presses and keys from the message around it.
    const W = p.win as unknown as { Event: typeof Event; KeyboardEvent: typeof KeyboardEvent };
    await act(async () => {
      chip.dispatchEvent(new W.Event("pointerdown", { bubbles: true }));
      chip.dispatchEvent(new W.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
  });

  test("submits only when his own latest line said submit", async () => {
    const { HtmlInline } = await import("@lianki/debug-chat/HtmlInline");
    const { FillChip } = await import("@lianki/debug-chat/FillChip");
    const store = makeFillStore();
    const patch = JSON.stringify({
      line: "form2",
      fields: { fname: "Taku", lname: "Miao" },
      submit: true,
    });
    const p = await mount(
      (host) =>
        createElement(
          "div",
          null,
          createElement(HtmlInline, { html: FORM, host, lineId: "form2", store }),
          createElement(FillChip, { spec: patch, patchId: "fill2", host, store }),
        ),
      { text: "first name Taku, last name Miao, 提交", at: Date.now() },
    );
    await act(async () => {});
    expect(p.submits).toHaveLength(1);
    expect(p.submits[0]).toMatch(/^↳ \/action_page\.php: fname=Taku, lname=Miao/);
  });

  test("a patch for another line fills nothing", async () => {
    const { HtmlInline } = await import("@lianki/debug-chat/HtmlInline");
    const { FillChip } = await import("@lianki/debug-chat/FillChip");
    const store = makeFillStore();
    const p = await mount((host) =>
      createElement(
        "div",
        null,
        createElement(HtmlInline, { html: FORM, host, lineId: "mine", store }),
        createElement(FillChip, {
          spec: JSON.stringify({ line: "other", fields: { fname: "X" } }),
          patchId: "f3",
          host,
          store,
        }),
        createElement(FillChip, { spec: "not json", patchId: "f4", host, store }),
      ),
    );
    await act(async () => {});
    expect(p.q<HTMLInputElement>("input[name=fname]").value).toBe("");
    expect(p.el.querySelectorAll("[data-testid=debug-chat-fill-chip]").length).toBe(1);
  });
});

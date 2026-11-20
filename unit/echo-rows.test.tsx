/**
 * Read-aloud echoes in the chat (docs/echo-suppression.md, "UI"): the hub's
 * echo frames applied to the page's list, where each row goes between the
 * runs, and the collapsed row itself in happy-dom: label, first words, expand,
 * the link to the echoed line, the dev note, and "This was me".
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { importReactDomClient, stubGlobals } from "./support/globals";
import {
  ECHO_ROWS_MAX,
  applyEchoFrame,
  echoDevNote,
  echoHead,
  echoSlots,
} from "@lianki/debug-chat/echo-rows";
import { EchoRow, jumpToLine } from "../packages/debug-chat/src/EchoRows";
import { CHAT_LOCALES, EXTRA, EXTRA_CONTEXT } from "@lianki/debug-chat/chat-ui-locales";
import type { ChatMessage } from "@lianki/debug-chat/wire";

const { createRoot } = await importReactDomClient();

const echo = (
  id: string,
  at: number,
  extra: Partial<NonNullable<ChatMessage["echo"]>> = {},
): ChatMessage => ({
  id,
  from: "owner",
  label: "mac",
  text: `先放一个占位首页，通过给他不爱可信自动部署 ${id}`,
  at,
  source: "stt",
  echo: {
    at,
    by: "auto",
    reason: "echo",
    kind: "read-aloud",
    of: "d3c3",
    sim: 0.632,
    layer: "report",
    voice: "device",
    overlapMs: 4000,
    shown: true,
    ...extra,
  },
});

describe("echo frames", () => {
  it("adds, replaces by id, keeps time order, and caps the list", () => {
    let list = applyEchoFrame([], { type: "echo", line: echo("b", 20) })!;
    list = applyEchoFrame(list, { type: "echo", line: echo("a", 10) })!;
    list = applyEchoFrame(list, { type: "echo", line: { ...echo("b", 20), text: "new" } })!;
    expect(list.map((m) => [m.id, m.text])).toEqual([
      ["a", echo("a", 10).text],
      ["b", "new"],
    ]);
    const many = Array.from({ length: ECHO_ROWS_MAX + 5 }, (_, i) => echo(`e${i}`, i));
    expect(applyEchoFrame([], { type: "echoes", lines: many })!).toHaveLength(ECHO_ROWS_MAX);
  });

  it("a snapshot replaces the list; gone removes; bad lines are ignored", () => {
    const list = [echo("a", 1), echo("b", 2)];
    expect(
      applyEchoFrame(list, { type: "echoes", lines: [echo("c", 3), echo("c", 3), { id: 1 }] })!.map(
        (m) => m.id,
      ),
    ).toEqual(["c"]);
    expect(applyEchoFrame(list, { type: "echoes" })).toEqual([]);
    expect(applyEchoFrame(list, { type: "echo-gone", ids: ["a", 7] })!.map((m) => m.id)).toEqual([
      "b",
    ]);
    expect(applyEchoFrame(list, { type: "echo-gone" })!.map((m) => m.id)).toEqual(["a", "b"]);
    // An echo not marked shown (a hidden one), or not a line at all: nothing changes.
    expect(
      applyEchoFrame(list, {
        type: "echo",
        line: { ...echo("x", 3), echo: { ...echo("x", 3).echo!, shown: undefined } },
      }),
    ).toEqual(list);
    expect(applyEchoFrame(list, { type: "echo", line: null })).toEqual(list);
    expect(
      applyEchoFrame(list, { type: "echo", line: { ...echo("x", 3), at: Number.NaN } }),
    ).toEqual(list);
    expect(applyEchoFrame(list, { type: "chat" })).toBeNull();
    expect(applyEchoFrame(list, null)).toBeNull();
  });
});

describe("where rows go", () => {
  it("after the last run that started at or before it; several in one slot fold", () => {
    const slots = echoSlots(
      [100, 200, 300],
      [echo("x", 250), echo("w", 50), echo("y", 260), echo("z", 999)],
    );
    expect([...slots.entries()].map(([k, v]) => [k, v.map((m) => m.id)])).toEqual([
      [-1, ["w"]],
      [1, ["x", "y"]],
      [2, ["z"]],
    ]);
    expect(
      echoSlots([], [echo("a", 1)])
        .get(-1)!
        .map((m) => m.id),
    ).toEqual(["a"]);
  });

  it("the first words, and a dev note of numbers only", () => {
    expect(echoHead("  hello   world  ")).toBe("hello world");
    expect(echoHead("一二三四五", 3)).toBe("一二三…");
    expect(echoDevNote(echo("a", 1))).toBe("report · 0.63 · device · 4000 ms");
    expect(
      echoDevNote({
        ...echo("a", 1),
        echo: { ...echo("a", 1).echo!, layer: undefined, voice: undefined, overlapMs: undefined },
      }),
    ).toBe("landed · 0.63");
    expect(echoDevNote({ id: "a", from: "owner", label: "", text: "", at: 0 })).toBe("");
  });
});

describe("its strings", () => {
  it("are in every locale, with a context line, {n} kept", () => {
    for (const k of ["echoHeard", "echoMany", "echoMine", "echoOf"] as const) {
      expect(EXTRA_CONTEXT[k].length).toBeGreaterThan(40);
      for (const l of CHAT_LOCALES) expect(EXTRA[l][k].trim().length).toBeGreaterThan(0);
    }
    for (const l of CHAT_LOCALES) expect(EXTRA[l].echoMany).toContain("{n}");
  });
});

describe("the row", () => {
  let win: Window;
  let restore: () => void;
  let root: Root;
  const setup = () => {
    win = new Window({ url: "https://lianki.com/en" });
    restore = stubGlobals({
      window: win,
      document: win.document,
      HTMLElement: win.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const host = win.document.createElement("ol");
    win.document.body.appendChild(host);
    root = createRoot(host as unknown as HTMLElement);
  };
  afterEach(async () => {
    await act(async () => root.unmount());
    restore();
    await win.happyDOM.close();
  });
  const q = (s: string) => win.document.querySelector(s) as unknown as HTMLElement | null;
  const qa = (s: string) => [...win.document.querySelectorAll(s)] as unknown as HTMLElement[];
  const click = (el: HTMLElement | null) => act(async () => el!.click());

  it("collapsed: label and first words; expanded: text, the link, the dev note, This was me", async () => {
    setup();
    const mine: string[] = [];
    const jumps: string[] = [];
    await act(async () =>
      root.render(
        createElement(EchoRow, {
          lines: [echo("a", 1)],
          t: EXTRA.en,
          dev: true,
          onMine: (id: string) => mine.push(id),
          onJump: (id: string) => jumps.push(id),
        }),
      ),
    );
    expect(q('[data-testid="debug-chat-echo-toggle"]')!.textContent).toContain(
      "Read aloud, heard back",
    );
    expect(q('[data-testid="debug-chat-echo-head"]')!.textContent).toContain("先放一个占位首页");
    expect(q('[data-testid="debug-chat-echo-line"]')).toBeNull();
    await click(q('[data-testid="debug-chat-echo-toggle"]'));
    expect(q('[data-testid="debug-chat-echo-head"]')).toBeNull();
    expect(q('[data-testid="debug-chat-echo-line"]')!.textContent).toContain(
      "通过给他不爱可信自动部署",
    );
    expect(q('[data-testid="debug-chat-echo-dev"]')!.textContent).toBe(
      "report · 0.63 · device · 4000 ms",
    );
    await click(q('[data-testid="debug-chat-echo-of"]'));
    expect(jumps).toEqual(["d3c3"]);
    await click(q('[data-testid="debug-chat-echo-mine"]'));
    expect(mine).toEqual(["a"]);
    await click(q('[data-testid="debug-chat-echo-toggle"]'));
    expect(q('[data-testid="debug-chat-echo-line"]')).toBeNull();
  });

  it("several fold into one counted row; no dev note, no link without a line, no button without a handler", async () => {
    setup();
    await act(async () =>
      root.render(
        createElement(EchoRow, {
          lines: [echo("a", 1, { of: "" }), echo("b", 2)],
          t: EXTRA.zh,
        }),
      ),
    );
    expect(q('[data-testid="debug-chat-echo"]')!.getAttribute("data-count")).toBe("2");
    expect(q('[data-testid="debug-chat-echo-toggle"]')!.textContent).toContain("2 条朗读回声");
    await click(q('[data-testid="debug-chat-echo-toggle"]'));
    expect(qa('[data-testid="debug-chat-echo-line"]')).toHaveLength(2);
    expect(qa('[data-testid="debug-chat-echo-of"]')).toHaveLength(1);
    expect(q('[data-testid="debug-chat-echo-dev"]')).toBeNull();
    expect(q('[data-testid="debug-chat-echo-mine"]')).toBeNull();
  });

  it("no lines: nothing; the default link scrolls to the line when it is shown", async () => {
    setup();
    await act(async () => root.render(createElement(EchoRow, { lines: [], t: EXTRA.en })));
    expect(q('[data-testid="debug-chat-echo"]')).toBeNull();
    const line = win.document.createElement("span");
    line.setAttribute("data-testid", "debug-chat-line");
    line.setAttribute("data-msg", "d3c3");
    let scrolled = 0;
    (line as unknown as { scrollIntoView: () => void }).scrollIntoView = () => void scrolled++;
    win.document.body.appendChild(line);
    await act(async () =>
      root.render(createElement(EchoRow, { lines: [echo("a", 1)], t: EXTRA.en })),
    );
    await click(q('[data-testid="debug-chat-echo-toggle"]'));
    await click(q('[data-testid="debug-chat-echo-of"]'));
    expect(scrolled).toBe(1);
    expect(jumpToLine("missing", win.document as unknown as ParentNode)).toBe(false);
    expect(jumpToLine("d3c3", null)).toBe(false);
    expect(jumpToLine('we"ird', win.document as unknown as ParentNode)).toBe(false);
  });
});

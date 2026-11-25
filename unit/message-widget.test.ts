import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { globalDescriptor, restoreGlobal } from "./support/globals";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { richOf, spokenOf } from "@lianki/debug-chat/rich-text";
import { RichBody } from "@lianki/debug-chat/RichText";
import { MessageWidget, type WidgetHost } from "@lianki/debug-chat/MessageWidget";
import { calc, calcShown, parseWidget, sliderReply } from "@lianki/debug-chat/message-widget";
import { CHAT_LOCALES, EXTRA, EXTRA_CONTEXT } from "@lianki/debug-chat/chat-ui-locales";

const g = globalThis as { DOMParser?: unknown };
const had = globalDescriptor("DOMParser");
beforeAll(() => {
  g.DOMParser = new Window().DOMParser;
});
afterAll(() => restoreGlobal("DOMParser", had));

const host: WidgetHost = {
  onReply: () => {},
  labels: { use: "Use", invalid: "Not a calculation", hint: "Fills your reply" },
};
const block = (spec: unknown) =>
  `Pick one:\n\n\`\`\`lianki-widget\n${typeof spec === "string" ? spec : JSON.stringify(spec)}\n\`\`\``;
const BUTTONS = { type: "buttons", title: "Which first?", options: ["Review", "New words"] };

describe("calc", () => {
  it("reads arithmetic with precedence, powers and parentheses", () => {
    expect(calc("12*3")).toBe(36);
    expect(calc("1 + 2 * 3")).toBe(7);
    expect(calc("(1 + 2) * 3")).toBe(9);
    expect(calc("2^3^2")).toBe(512);
    expect(calc("-2^2")).toBe(-4);
    expect(calc("7 % 4")).toBe(3);
    expect(calc("6 ÷ 4 × 2")).toBe(3);
    expect(calc("1,200 / 3")).toBe(400);
    expect(calc(".5e1")).toBe(5);
  });
  it("refuses what is not arithmetic, and never evaluates code", () => {
    for (const bad of ["", "1 +", "(1", "1)", "alert(1)", "2**", "1/0", "Math.PI", "1;2", "x"])
      expect(calc(bad)).toBeNull();
    expect(calc("(".repeat(40) + "1" + ")".repeat(40))).toBeNull();
  });
  it("shows a result without float noise", () => {
    expect(calcShown(0.1 + 0.2)).toBe("0.3");
    expect(calcShown(1 / 3)).toBe("0.3333333333");
  });
});

describe("parseWidget", () => {
  it("keeps only the known shapes, bounded", () => {
    expect(parseWidget(JSON.stringify(BUTTONS))).toEqual(BUTTONS as never);
    expect(
      parseWidget(
        JSON.stringify({ type: "buttons", options: Array.from({ length: 20 }, (_, i) => `o${i}`) }),
      ),
    ).toMatchObject({ options: { length: 8 } });
    expect(parseWidget(JSON.stringify({ type: "buttons", options: [] }))).toBeNull();
    expect(parseWidget(JSON.stringify({ type: "script", src: "x" }))).toBeNull();
    expect(parseWidget("not json")).toBeNull();
    expect(parseWidget("[1,2]")).toBeNull();
    expect(parseWidget("x".repeat(5000))).toBeNull();
  });
  it("clamps a slider into its range and needs a label and min < max", () => {
    const s = parseWidget(
      JSON.stringify({
        type: "slider",
        label: "Minutes",
        min: 5,
        max: 60,
        step: 5,
        value: 99,
        unit: "min",
      }),
    );
    expect(s).toEqual({
      type: "slider",
      label: "Minutes",
      min: 5,
      max: 60,
      step: 5,
      value: 60,
      unit: "min",
    });
    expect(sliderReply(s as never, 20)).toBe("Minutes: 20 min");
    expect(parseWidget(JSON.stringify({ type: "slider", label: "x", min: 3, max: 3 }))).toBeNull();
    expect(parseWidget(JSON.stringify({ type: "slider", min: 0, max: 3 }))).toBeNull();
  });
  it("pads a table's rows to its columns", () => {
    expect(
      parseWidget(
        JSON.stringify({ type: "table", columns: ["a", "b"], rows: [["1"], [2, 3, 4], "x"] }),
      ),
    ).toEqual({
      type: "table",
      columns: ["a", "b"],
      rows: [
        ["1", ""],
        ["2", "3"],
      ],
    });
  });
});

describe("in a chat line", () => {
  it("a paired agent's block becomes a widget; everyone else's stays code", () => {
    const html = richOf(block(BUTTONS), "html");
    const pre = html.nodes.find((n) => "tag" in n && n.tag === "pre");
    expect(pre && "attrs" in pre ? pre.attrs?.["data-widget"] : undefined).toBe(
      JSON.stringify(BUTTONS),
    );
    const md = richOf(block(BUTTONS), "markdown");
    expect(JSON.stringify(md.nodes)).not.toContain("data-widget");
  });
  it("an invalid spec stays code, even from a paired agent", () => {
    expect(JSON.stringify(richOf(block("{nope"), "html").nodes)).not.toContain("data-widget");
  });
  it("renders with a host, and as the code block without one", () => {
    const rich = richOf(block(BUTTONS), "html");
    const on = renderToStaticMarkup(createElement(RichBody, { rich, widgets: host }));
    expect(on).toContain('data-testid="debug-chat-widget"');
    expect(on).toContain("New words");
    expect(on).not.toContain("<pre");
    const off = renderToStaticMarkup(createElement(RichBody, { rich }));
    expect(off).toContain("<pre");
    expect(off).not.toContain("debug-chat-widget");
    expect(off).not.toContain("data-widget");
  });
  it("is not read aloud", () => {
    expect(
      spokenOf({ from: "agent", ownerGrant: true, thread: "owner", text: block(BUTTONS) }),
    ).toBe("Pick one:");
  });
  it("each kind renders", () => {
    const render = (spec: unknown) =>
      renderToStaticMarkup(createElement(MessageWidget, { spec: JSON.stringify(spec), host }));
    expect(render({ type: "calc", expr: "12*3" })).toContain("= 36");
    expect(render({ type: "calc", expr: "12*" })).toContain("Not a calculation");
    expect(render({ type: "slider", label: "Minutes", min: 0, max: 10, value: 4 })).toContain(
      'type="range"',
    );
    expect(render({ type: "table", columns: ["Word"], rows: [["chat"]] })).toContain("<td");
    expect(render({ type: "nope" })).toBe("");
  });
});

it("every widget string has its context and all 16 locales", () => {
  for (const k of ["widgetUse", "widgetCalcInvalid", "widgetReplyHint"] as const) {
    expect(EXTRA_CONTEXT[k].length).toBeGreaterThan(40);
    for (const l of CHAT_LOCALES) expect(EXTRA[l][k].trim().length).toBeGreaterThan(0);
  }
});

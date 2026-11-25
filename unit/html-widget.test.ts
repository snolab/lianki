import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { globalDescriptor, restoreGlobal } from "./support/globals";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { lineTier, richOf, widgetLine } from "@lianki/debug-chat/rich-text";
import { RichBody } from "@lianki/debug-chat/RichText";
import {
  formLine,
  inlineHtml,
  scriptedHtml,
  type InlineNode,
} from "@lianki/debug-chat/html-inline";
import {
  HTML_CSP,
  HTML_SANDBOX,
  actionReply,
  htmlWidgetDoc,
  htmlWidgetEvent,
} from "@lianki/debug-chat/html-widget";
import { HtmlWidget } from "@lianki/debug-chat/HtmlWidget";
import type { WidgetHost } from "@lianki/debug-chat/MessageWidget";

const g = globalThis as { DOMParser?: unknown };
const had = globalDescriptor("DOMParser");
beforeAll(() => {
  g.DOMParser = new Window().DOMParser;
});
afterAll(() => restoreGlobal("DOMParser", had));

const host: WidgetHost = {
  onReply: () => {},
  onSubmit: () => {},
  labels: {
    use: "Use",
    invalid: "Not a calculation",
    hint: "Widget",
    scriptsOff: "Scripts off",
    filled: "Filled {n}",
  },
};

/** The owner's own example (2026-11-25), as written. */
const OWNER_FORM = `<form action="/action_page.php" method="get">
  <label for="fname">First name:</label>
  <input type="text" id="fname" name="fname"><br><br>
  <label for="lname">Last name:</label>
  <input type="text" id="lname" name="lname"><br><br>
  <button type="submit">Submit</button>
  <button type="submit" formtarget="_blank">Submit to a new window</button>
</form>`;

const flat = (nodes: InlineNode[]): string => JSON.stringify(nodes);
const fence = (html: string) => `Try it:\n\n\`\`\`lianki-html\n${html}\n\`\`\``;

describe("inline HTML (no script)", () => {
  it("keeps his form as written, ids scoped, and nothing submits anywhere", () => {
    const nodes = inlineHtml(OWNER_FORM, "w1-");
    const s = flat(nodes);
    expect(s).toContain('"action":"/action_page.php"');
    expect(s).toContain('"id":"w1-fname"');
    expect(s).toContain('"for":"w1-fname"');
    expect(s).toContain('"formtarget":"_blank"');
    const html = renderToStaticMarkup(
      createElement(RichBody, {
        rich: richOf(fence(OWNER_FORM), "markdown", true),
        widgets: host,
      }),
    );
    expect(html).toContain('data-testid="debug-chat-html-inline"');
    // The real attributes never reach the DOM: no action, no target, no formtarget.
    expect(html).not.toMatch(/\saction=|\starget=|\sformtarget=/);
    expect(html).toContain('data-action="/action_page.php"');
    expect(html).toContain('data-formtarget="_blank"');
    expect(html).toMatch(/id="lkw[\w-]*-fname"/);
    expect(html).toContain("Submit to a new window");
  });

  it("a submit becomes his line, keyed by the action", () => {
    expect(
      formLine("/action_page.php", [
        ["fname", "John"],
        ["lname", "Doe"],
      ]),
    ).toBe("↳ /action_page.php: fname=John, lname=Doe");
    expect(formLine("", [])).toBe("↳ submit");
  });

  it("drops the usual XSS vectors", () => {
    const vectors = [
      `<img src=x onerror=alert(1)>`,
      `<svg onload=alert(1)><circle/></svg>`,
      `<a href="javascript:alert(1)">x</a>`,
      `<iframe src="https://evil.example"></iframe>`,
      `<object data="x"></object><embed src="x">`,
      `<style>body{display:none}</style><p>hi</p>`,
      `<link rel=stylesheet href=//evil.example/x.css>`,
      `<meta http-equiv=refresh content="0;url=//evil.example">`,
      `<base href="//evil.example/">`,
      `<form action="javascript:alert(1)"><button>go</button></form>`,
      `<math><mi xlink:href="javascript:alert(1)">x</mi></math>`,
      `<details open ontoggle=alert(1)>x</details>`,
      `<input autofocus onfocus=alert(1)>`,
    ];
    for (const v of vectors) {
      const nodes = inlineHtml(v, "w-");
      // Script in any form is stripped (script widgets are off); what is left is safe.
      const s = flat(nodes);
      expect(s).not.toMatch(
        /onerror|onload|ontoggle|onfocus|javascript:|"iframe"|"object"|"embed"|"style":\{"display":"none"|"link"|"meta"|"base"|"svg"|"math"/,
      );
    }
    // These had script: flagged, and nothing of it is left.
    for (const v of [
      `<img src=x onerror=alert(1)>`,
      `<a href="javascript:alert(1)">x</a>`,
      `<script>alert(1)</script>`,
    ]) {
      expect(scriptedHtml(v)).toBe(true);
      expect(flat(inlineHtml(v, "w-"))).not.toMatch(/onerror|javascript:|alert|"script"/);
    }
    expect(scriptedHtml(OWNER_FORM)).toBe(false);
    // These are inline, with the dangerous part gone:
    expect(flat(inlineHtml(`<style>body{display:none}</style><p>hi</p>`, "w-"))).toBe(
      '[{"tag":"p","attrs":{},"children":[{"text":"hi"}]}]',
    );
  });

  it("keeps only harmless style: nothing that moves over the page or loads", () => {
    const s = flat(
      inlineHtml(
        `<div style="position:fixed;inset:0;z-index:9999;color:red;background:url(//x/y.png);transform:scale(9);padding:4px">x</div>`,
        "w-",
      ),
    );
    expect(s).toContain('"color":"red"');
    expect(s).toContain('"paddingTop":"4px"');
    expect(s).not.toMatch(/position|zIndex|inset|transform|url\(/);
  });

  it("no class (the page's own utility classes could cover the chat), no remote images", () => {
    const s = flat(
      inlineHtml(
        `<div class="fixed inset-0">x</div><img src="https://x.example/p.png" alt="pic">`,
        "w-",
      ),
    );
    expect(s).not.toContain("class");
    expect(s).not.toContain("https://x.example");
    expect(s).toContain('"text":"pic"');
  });
});

describe("sandboxed frame (script)", () => {
  it("is scripts and forms in an opaque origin, nothing more", () => {
    expect(HTML_SANDBOX).toBe("allow-scripts allow-forms");
    for (const bad of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-modals"])
      expect(HTML_SANDBOX).not.toContain(bad);
    const html = renderToStaticMarkup(
      createElement(HtmlWidget, { html: "<script>1</script>", host }),
    );
    expect(html).toContain('sandbox="allow-scripts allow-forms"');
    expect(html).toContain("srcDoc=");
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toMatch(/\ssrc="/);
  });

  it("its document has no network and no form target", () => {
    for (const d of [
      "connect-src 'none'",
      "form-action 'none'",
      "frame-src 'none'",
      "default-src 'none'",
      "base-uri 'none'",
    ])
      expect(HTML_CSP).toContain(d);
    const doc = htmlWidgetDoc("<p>x</p>", false);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<p>x</p>"));
  });

  it("only well-formed messages from the frame count", () => {
    expect(htmlWidgetEvent({ lk: "height", h: 120 })).toEqual({ lk: "height", h: 120 });
    expect(htmlWidgetEvent({ lk: "reply", text: "A" })).toEqual({ lk: "reply", text: "A" });
    const a = htmlWidgetEvent({
      lk: "action",
      name: "/action_page.php",
      fields: { fname: "J", x: 1 },
    });
    expect(a).toEqual({ lk: "action", name: "/action_page.php", fields: { fname: "J" } });
    expect(actionReply(a as never)).toBe("/action_page.php: fname=J");
    for (const bad of [
      null,
      "x",
      { lk: "eval", code: "1" },
      { lk: "height", h: "9" },
      { lk: "reply", text: " " },
    ])
      expect(htmlWidgetEvent(bad)).toBeNull();
  });
});

it("a script widget in a chat line renders no iframe at all", () => {
  const rich = richOf(
    fence(`<script>location.href="http://127.0.0.1:9/leak"</script><p>x</p>`),
    "markdown",
    true,
  );
  const html = renderToStaticMarkup(createElement(RichBody, { rich, widgets: host }));
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain("127.0.0.1");
  expect(html).toContain("Scripts off");
});

describe("the boundary", () => {
  it("HTML widgets only for agent lines in his own thread", () => {
    const own = { from: "agent", thread: "owner" };
    const friend = { from: "agent", thread: "t:friend-account" };
    const household = { from: "agent", ownerGrant: true, thread: "t:household" };
    const has = (m: typeof own) =>
      JSON.stringify(richOf(fence(OWNER_FORM), lineTier(m), widgetLine(m)).nodes).includes(
        "data-html-widget",
      );
    expect(has(own)).toBe(true);
    expect(has(friend)).toBe(false);
    expect(has(household)).toBe(false);
    expect(has({ from: "user", thread: "owner" })).toBe(false);
    expect(widgetLine(own, { embedded: true })).toBe(false);
  });
});

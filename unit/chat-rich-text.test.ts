import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { globalDescriptor, restoreGlobal } from "./support/globals";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement, type ReactNode } from "react";
import { lineTier, type Rich, type RichNode, richOf, spokenOf } from "@lianki/debug-chat/rich-text";
import { ChatLink, RichBody, RichLine } from "@lianki/debug-chat/RichText";
import { sentenceRanges } from "@lianki/debug-chat/read-progress";

const g = globalThis as { DOMParser?: unknown; location?: unknown };
const had = { parser: globalDescriptor("DOMParser"), location: globalDescriptor("location") };
beforeAll(() => {
  g.DOMParser = new Window().DOMParser;
});
afterAll(() => {
  restoreGlobal("DOMParser", had.parser);
  restoreGlobal("location", had.location);
});

const html = (rich: Rich, read?: Parameters<typeof RichBody>[0]["read"]) =>
  renderToStaticMarkup(createElement(RichBody, { rich, read }));

const tags = (nodes: RichNode[]): string[] =>
  nodes.flatMap((n) => ("tag" in n ? [n.tag, ...tags(n.children)] : []));
const attrNames = (nodes: RichNode[]): string[] =>
  nodes.flatMap((n) =>
    "tag" in n ? [...Object.keys(n.attrs ?? {}), ...attrNames(n.children)] : [],
  );

describe("markdown", () => {
  const md = (t: string) => richOf(t, "markdown");

  it("a plain line is that line: no wrapper, same text, same words read", () => {
    for (const t of [
      "Hello there. How are you?",
      "你好。今天怎么样？",
      "snake_case_name and 3.14 and #537",
      "a  b",
    ]) {
      const r = md(t);
      expect(r.nodes).toEqual([{ text: t, at: 0 }]);
      expect(r.spoken).toBe(t);
      expect(r.shown).toBe(t);
      expect(html(r)).toBe(t.replace(/&/g, "&amp;"));
    }
  });

  it("bold, italic, strike, inline code, breaks", () => {
    const r = md("**b** *i* ~~s~~ `c<d>`\nnext");
    expect(tags(r.nodes)).toEqual(["strong", "em", "del", "code", "br"]);
    expect(r.spoken).toBe("b i s c<d>\nnext");
    expect(html(r)).toContain("c&lt;d&gt;");
  });

  it('a single ~ is a character, never a strike ("15~20 分钟 … 0:05~")', () => {
    for (const t of ["只需要 15~20 分钟，凌晨 0:05~0:10 完成", "主人喵~ 好的~", "a ~b~ c"]) {
      const r = md(t);
      expect(tags(r.nodes)).not.toContain("del");
      expect(r.shown).toBe(t);
    }
    expect(tags(md("~~gone~~ and 1~2").nodes)).toEqual(["del"]);
  });

  it("lists, a heading as a bold line, a quote, a rule, a task box as a character", () => {
    expect(tags(md("- a\n- b").nodes)).toEqual(["ul", "li", "li"]);
    expect(md("- a\n- b").spoken).toBe("a\nb");
    expect(tags(md("3. a\n4. b").nodes)).toEqual(["ol", "li", "li"]);
    expect(md("3. a\n4. b").nodes[0]).toMatchObject({ attrs: { start: "3" } });
    expect(tags(md("# T").nodes)).toEqual(["strong"]);
    expect(tags(md("> q\n\n---\n\nend").nodes)).toEqual(["blockquote", "p", "hr", "p"]);
    const task = md("- [x] done\n- [ ] todo");
    expect(tags(task.nodes)).not.toContain("input");
    expect(task.shown).toContain("☑");
    expect(task.shown).toContain("☐");
  });

  it("indented lines stay lines; a dash under a line is no heading", () => {
    expect(tags(md("    indented").nodes)).toEqual([]);
    expect(tags(md("title\n---").nodes)).toContain("hr");
    expect(tags(md("title\n---").nodes)).not.toContain("strong");
  });

  it("tables: cells read with commas, the table scrolls in its own box", () => {
    const r = md("| a | b |\n|:-|-:|\n| 1 | 2 |");
    expect(tags(r.nodes)).toEqual(["table", "thead", "tr", "th", "th", "tbody", "tr", "td", "td"]);
    expect(r.spoken).toBe("a, b\n1, 2");
    const out = html(r);
    expect(out).toContain('data-testid="debug-chat-table"');
    expect(out).toContain("overflow-x-auto");
    expect(out).toContain("text-align:right");
  });

  it("code blocks: shown, kept as written, scrolling, not read", () => {
    const r = md("Run this:\n\n```js\nconst a = '<b>*x*</b>';\n  b();\n```\n\nThen stop.");
    expect(tags(r.nodes)).toEqual(["p", "pre", "code", "p"]);
    expect(r.spoken).toBe("Run this:\nThen stop.");
    expect(r.shown).toContain("const a = '<b>*x*</b>';\n  b();");
    const out = html(r);
    expect(out).toContain("overflow-x-auto");
    expect(out).toContain("&lt;b&gt;*x*&lt;/b&gt;");
    expect(md("```\nonly code\n```").spoken).toBe("");
  });

  it("bare URLs link, CJK beside them; not inside code or a link's label", () => {
    const r = md("打开https://lianki.com/dev/flags#words.voice-mode。然后 lianki.com/en");
    expect(tags(r.nodes)).toEqual(["a", "a"]);
    expect(r.shown).toBe("打开https://lianki.com/dev/flags#words.voice-mode。然后 lianki.com/en");
    expect(tags(md("`https://a.example/`").nodes)).toEqual(["code"]);
    // Markdown's emphasis leaves a URL alone.
    expect(md("https://a.example/_x_/*y*").shown).toBe("https://a.example/_x_/*y*");
    expect(tags(md("https://a.example/_x_/*y*").nodes)).toEqual(["a"]);
  });

  it("a labelled link shows the real URL as the anchor; only the label is read", () => {
    const r = md("Go [here](https://evil.example/x) now");
    expect(r.spoken).toBe("Go here now");
    expect(r.shown).toBe("Go here (https://evil.example/x) now");
    const out = html(r);
    expect(out).toContain(">https://evil.example/x</a>");
    expect(out).not.toContain(">here</a>");
    // Its text its URL: one anchor.
    const same = md("[https://a.example/](https://a.example/)");
    expect(tags(same.nodes)).toEqual(["a"]);
    const auto = md("<https://a.example/>");
    expect(tags(auto.nodes)).toEqual(["a"]);
    // A label dressed as another address: both are shown.
    expect(md("[https://lianki.com/](https://evil.example/)").shown).toBe(
      "https://lianki.com/ (https://evil.example/)",
    );
    // An empty label shows the URL.
    expect(md("[](https://a.example/)").shown).toBe("https://a.example/");
    // A path is resolved on lianki.com.
    expect(html(md("[f](/dev/flags)"))).toContain('href="https://lianki.com/dev/flags"');
  });

  it("no raw HTML and no images, as text", () => {
    const r = md("<b>x</b> <img src=x onerror=alert(1)> ![alt](https://lianki.com/a.png)");
    expect(tags(r.nodes)).toEqual([]);
    expect(r.shown).toContain("<b>x</b>");
    expect(r.shown).toContain("<img src=x onerror=alert(1)>");
    expect(r.shown).toContain("alt");
    expect(r.shown).not.toContain("a.png");
    const block = md('<div onclick="x()">\nhi\n</div>\n\nafter');
    expect(tags(block.nodes)).toEqual(["p"]);
    expect(block.shown).toContain('<div onclick="x()">');
  });

  it("falls back to the plain text when there is no parser, or the line is huge", () => {
    const big = `${"x ".repeat(11_000)}https://a.example/`;
    expect(tags(md(big).nodes)).toEqual(["a"]);
    const p = g.DOMParser;
    g.DOMParser = undefined;
    const t = "**no parser** https://b.example/";
    expect(md(t).spoken).toBe(t);
    expect(tags(md(t).nodes)).toEqual(["a"]);
    g.DOMParser = class {
      parseFromString() {
        throw new Error("no");
      }
    };
    expect(md("**it threw**").spoken).toBe("**it threw**");
    g.DOMParser = p;
  });

  it("remembers lines, and forgets them all when full", () => {
    const a = md("remember me");
    expect(md("remember me")).toBe(a);
    for (let i = 0; i < 401; i++) md(`line ${i}`);
    expect(md("remember me")).not.toBe(a);
  });
});

/** Attempts, each run in the HTML tier: the strongest one a line can have. */
const CORPUS = [
  "<script>alert(1)</script>",
  "<SCRIPT SRC=https://evil.example/x.js></SCRIPT>",
  "<scr<script>ipt>alert(1)</scr</script>ipt>",
  "<style>*{display:none}</style>",
  "<iframe src=https://evil.example></iframe>",
  "<iframe srcdoc='<script>alert(1)</script>'></iframe>",
  "<object data=https://evil.example></object>",
  "<embed src=https://evil.example>",
  "<form action=https://evil.example><input name=pw><button>go</button></form>",
  "<textarea>x</textarea><select><option>o</option></select>",
  "<svg onload=alert(1)><a href='javascript:alert(1)'><text>x</text></a></svg>",
  "<svg><script>alert(1)</script></svg>",
  "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
  "<template><script>alert(1)</script></template>",
  "<noscript><img src=x onerror=alert(1)></noscript>",
  "<link rel=stylesheet href=https://evil.example/x.css>",
  "<meta http-equiv=refresh content='0;url=https://evil.example'>",
  "<base href=https://evil.example/>",
  "<video src=x onerror=alert(1)></video><audio src=x></audio>",
  "<frameset><frame src=https://evil.example></frameset>",
  "<div onclick=alert(1) onmouseover='alert(2)' style='position:fixed;inset:0' id=x name=y class=z data-x=1>t</div>",
  "<span style='background:url(javascript:alert(1))' title=x>t</span>",
  "<a href='https://a.example/' onclick=alert(1) target=_self rel=opener style='color:red'>t</a>",
  "<b onfocus=alert(1) autofocus tabindex=1>t</b>",
  "<table background=javascript:alert(1)><tr><td onclick=x() style=x colspan=999 rowspan=abc>t</td></tr></table>",
];

/** Tags and attributes that may never appear, whatever the line. */
const FORBIDDEN_TAGS =
  /^(script|style|iframe|object|embed|form|input|button|textarea|select|option|svg|math|template|noscript|link|meta|base|video|audio|frameset|frame)$/;
const ALLOWED_ATTRS = new Set([
  "href",
  "src",
  "alt",
  "width",
  "height",
  "colspan",
  "rowspan",
  "align",
  "start",
]);

describe("the sanitizer", () => {
  it.each(CORPUS)("%s", (attempt) => {
    for (const tier of ["html", "markdown"] as const) {
      const r = richOf(attempt, tier);
      for (const t of tags(r.nodes)) expect(t).not.toMatch(FORBIDDEN_TAGS);
      for (const a of attrNames(r.nodes)) expect(ALLOWED_ATTRS.has(a)).toBe(true);
      const out = html(r);
      // In the markup, not the text: what's escaped as text may say anything.
      expect(out).not.toMatch(
        /<(script|style|iframe|object|embed|form|input|svg|math|link|meta|base)\b/i,
      );
      expect(out).not.toMatch(/<[^>]*\son\w+\s*=/i);
      expect(out).not.toMatch(/href="(?!https?:)/i);
      expect(out).not.toMatch(/src="(?!https:\/\/lianki\.com\/)/i);
    }
  });

  const hrefs = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java&#x09;script:alert(1)",
    "java&#10;script:alert(1)",
    "&#106;avascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:x",
    "//evil.example/x",
  ];
  it.each(hrefs)("no link to %s", (href) => {
    for (const line of [`<a href="${href}">t</a>`, `[t](${href})`]) {
      const r = richOf(line, "html");
      expect(tags(r.nodes)).not.toContain("a");
      expect(r.shown).toContain("t");
    }
  });

  it("a backslash can't turn a path into another host", () => {
    const line = "/\\evil.example/x";
    // Raw, the URL parser would make it a host: refused. Through markdown it is encoded: a path here.
    expect(tags(richOf(`<a href="${line}">t</a>`, "html").nodes)).not.toContain("a");
    expect(html(richOf(`[t](${line})`, "html"))).not.toContain('href="https://evil');
  });

  it("the HTML tier keeps what's allowed", () => {
    const r = richOf(
      '<div><b>b</b> <u>u</u> <span>s</span> <kbd>k</kbd><sub>1</sub></div>\n\n<a href="/dev/flags">f</a>',
      "html",
    );
    expect(tags(r.nodes)).toEqual(expect.arrayContaining(["div", "b", "u", "span", "kbd", "sub"]));
    expect(html(r)).toContain('href="https://lianki.com/dev/flags"');
  });

  it("an unknown tag gives way to its text", () => {
    const r = richOf("<marquee>x</marquee>", "html");
    expect(tags(r.nodes)).not.toContain("marquee");
    expect(r.shown).toBe("x");
  });

  it("images: from the allowed origin only, in the HTML tier only", () => {
    const ok = richOf('<img src="/a.png" alt="A" width="10" height="abc" onerror="x()">', "html");
    expect(html(ok)).toContain('src="https://lianki.com/a.png"');
    expect(html(ok)).toContain('width="10"');
    expect(html(ok)).not.toContain("height");
    expect(html(ok)).not.toContain("onerror");
    expect(html(ok)).toContain('referrerPolicy="no-referrer"');
    expect(ok.spoken).toBe("A");
    expect(ok.shown).toBe("A");
    for (const bad of [
      '<img src="https://evil.example/a.png" alt="A">',
      '<img src="data:image/png;base64,AAAA" alt="A">',
      '<img src="javascript:alert(1)" alt="A">',
      '<img src="http://lianki.com/a.png" alt="A">',
      "![A](https://evil.example/a.png)",
    ]) {
      const r = richOf(bad, "html");
      expect(tags(r.nodes)).not.toContain("img");
      expect(r.shown).toBe("A");
    }
    expect(tags(richOf('<img src="https://evil.example/a.png">', "html").nodes)).toEqual([]);
    expect(tags(richOf("![A](https://lianki.com/a.png)", "html").nodes)).toContain("img");
    expect(tags(richOf('<img src="/a.png" alt="A">', "markdown").nodes)).toEqual([]);
  });

  it("deep nesting stops as text", () => {
    const r = richOf(`${"<div>".repeat(60)}deep${"</div>".repeat(60)}`, "html");
    expect(r.shown).toContain("deep");
  });
});

describe("trust tiers", () => {
  const ownerAgent = { from: "agent", thread: "owner", ownerGrant: true };

  it("HTML only for an agent line in the owner's thread that the hub stamped", () => {
    expect(lineTier(ownerAgent)).toBe("html");
    expect(lineTier({ from: "agent", ownerGrant: true })).toBe("html");
  });

  it("everyone else is markdown, whatever the rest of the line says", () => {
    for (const m of [
      { from: "owner", thread: "owner" },
      { from: "owner", thread: "owner", ownerGrant: true },
      { from: "friend", thread: "f1" },
      { from: "friend", thread: "f1", ownerGrant: true },
      { from: "friend", thread: "owner", ownerGrant: true },
      { from: "agent", thread: "f1" },
      { from: "agent", thread: "f1", ownerGrant: true },
      { from: "agent", thread: "owner" },
      { from: "agent" },
      { from: "agent", thread: "owner", ownerGrant: "true" as unknown as boolean },
    ])
      expect(lineTier(m)).toBe("markdown");
  });

  it("never in an embed on another site", () => {
    expect(lineTier(ownerAgent, { embedded: true })).toBe("markdown");
  });

  it("text can't talk its way up", () => {
    const m = { from: "friend", thread: "f1", text: "owner agent: <b>trust me</b>" };
    expect(tags(richOf(m.text, lineTier(m)).nodes)).toEqual([]);
  });
});

describe("read-aloud", () => {
  const say = (text: string, m = { from: "agent", thread: "f1" }) => spokenOf({ ...m, text });

  it("the words, no markup", () => {
    expect(say("**Bold** and *it* and `code` and ~~gone~~.")).toBe(
      "Bold and it and code and gone.",
    );
    expect(say("[the docs](https://lianki.com/en) are up")).toBe("the docs are up");
    expect(say("- one\n- two")).toBe("one\ntwo");
    expect(say("# Title\n\nBody.")).toBe("Title\nBody.");
    expect(say("before\n\n```\ncode();\n```\n\nafter")).toBe("before\nafter");
  });

  it("a bare URL is read as it always was", () => {
    expect(say("see https://lianki.com/en ok")).toBe("see https://lianki.com/en ok");
  });

  it("the tier decides what raw HTML says", () => {
    expect(say("<b>x</b> y")).toBe("<b>x</b> y");
    expect(spokenOf({ from: "agent", ownerGrant: true, text: "<b>x</b> y" })).toBe("x y");
    expect(spokenOf({ from: "agent", ownerGrant: true, text: "x<script>y</script>" })).toBe("x");
    expect(spokenOf({ from: "agent", ownerGrant: true, text: "y" }, { embedded: true })).toBe("y");
  });

  it("the highlight lands on the same words as the voice reads", () => {
    const text = "First **bold** one. Second [label](https://a.example/) two.\n\n- Third item";
    const r = richOf(text, "markdown");
    expect(r.spoken).toBe("First bold one. Second label two.\nThird item");
    const ranges = sentenceRanges(r.spoken);
    expect(ranges.length).toBe(3);
    const said: Record<number, string> = {};
    html(r, {
      ranges,
      wrap: (idx, key, children) => {
        said[idx] = (said[idx] ?? "") + String(children);
        return createElement("span", { key, "data-read": idx }, children);
      },
    });
    expect(said[0]!.trim()).toBe("First bold one.");
    expect(said[1]!.trim()).toBe("Second label two.");
    expect(said[2]!.trim()).toBe("Third item");
    // What's not read is outside the sentences.
    const out = html(r, {
      ranges,
      wrap: (idx, key, children) => createElement("span", { key, "data-read": idx }, children),
    });
    expect(out).toContain(">https://a.example/</a>");
  });

  it("with no sentences left, the text still shows", () => {
    const r = richOf("plain", "markdown");
    expect(html(r, { ranges: [], wrap: () => null })).toBe("plain");
  });
});

describe("rendering links", () => {
  /** The anchor's element out of a ChatLink's render (hooks: through a tiny stand-in). */
  const anchorProps = (
    href: string,
    onOpenPage?: (p: string) => void,
  ): { props: Record<string, (...a: never[]) => unknown> & { href: string } } => {
    let found: unknown;
    const walk = (n: ReactNode) => {
      const el = n as ReactElement<{ children?: ReactNode }>;
      if (el?.type === "a") found = el;
      else if (Array.isArray(n)) n.forEach(walk);
      else if (el?.props?.children) walk(el.props.children);
    };
    function Probe() {
      const out = (ChatLink as (p: unknown) => ReactNode)({ href, children: "x", onOpenPage });
      walk(out);
      return out;
    }
    renderToStaticMarkup(createElement(Probe));
    return found as never;
  };

  it("another site: a new tab, no opener, no referrer; the text is the URL", () => {
    g.location = { hostname: "lianki.com" };
    const out = html(richOf("friend says https://evil.example/x", "markdown"));
    expect(out).toContain('href="https://evil.example/x"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain(">https://evil.example/x</a>");
    expect(out).toContain("pointer-events-auto");
    expect(out).toContain('draggable="false"');
    expect(out).toContain("oklch(");
    expect(out).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  });

  it("ours on lianki.com: this tab; elsewhere, or with no location, a new one", () => {
    g.location = { hostname: "lianki.com" };
    const ours = html(richOf("lianki.com/en", "markdown"));
    expect(ours).toContain('href="https://lianki.com/en"');
    expect(ours).toContain(">lianki.com/en</a>");
    expect(ours).not.toContain("target=");
    g.location = { hostname: "example.com" };
    expect(html(richOf("lianki.com/en", "markdown"))).toContain('target="_blank"');
    g.location = undefined;
    expect(html(richOf("lianki.com/en", "markdown"))).toContain('target="_blank"');
  });

  it("a click is reserved for its action menu, never the line or router; drag opens nothing", () => {
    g.location = { hostname: "lianki.com" };
    const opened: string[] = [];
    const a = anchorProps("https://lianki.com/dev/flags#a.b", (p) => opened.push(p));
    const ev = (o: object = {}) => {
      const e = {
        stops: 0,
        prevented: 0,
        clientX: 0,
        clientY: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        key: "Enter",
        stopPropagation() {
          e.stops++;
        },
        preventDefault() {
          e.prevented++;
        },
        ...o,
      };
      return e;
    };
    const { onClick, onPointerDown, onKeyDown } = a.props as unknown as Record<
      string,
      (e: ReturnType<typeof ev>) => void
    >;
    const tap = ev();
    onClick!(tap);
    expect(opened).toEqual([]);
    expect([tap.stops, tap.prevented]).toEqual([1, 1]);

    onPointerDown!(ev({ clientX: 0, clientY: 0 }));
    const dragged = ev({ clientX: 50, clientY: 0 });
    onClick!(dragged);
    expect(opened.length).toBe(0);
    expect(dragged.prevented).toBe(1);

    const meta = ev({ metaKey: true });
    onClick!(meta);
    expect([meta.stops, meta.prevented]).toEqual([1, 1]);

    const enter = ev();
    onKeyDown!(enter);
    expect(enter.stops).toBe(1);
    const other = ev({ key: "a" });
    onKeyDown!(other);
    expect(other.stops).toBe(0);
  });

  it("the one-line view: its words, with their links, no blocks", () => {
    g.location = { hostname: "lianki.com" };
    const r = richOf("**Hi** see https://a.example/\n\n- item\n\n```\ncode\n```", "markdown");
    const out = renderToStaticMarkup(createElement(RichLine, { rich: r }));
    expect(out).not.toMatch(/<(ul|li|pre|strong)\b/);
    expect(out).toContain(">https://a.example/</a>");
    expect(out).toContain("item");
    expect(out).toContain("code");
  });

  it("elements of every kind render, without an unsafe attribute", () => {
    const r = richOf(
      '<a href="https://a.example/">https://a.example/</a><hr>\n\nx<br>y\n\n| a |\n|---|\n| <b>c</b> |',
      "html",
    );
    const out = html(r);
    expect(out).toContain("<hr");
    expect(out).toContain("<br");
    expect(out).toContain("<table");
  });
});

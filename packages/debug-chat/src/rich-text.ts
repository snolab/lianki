/**
 * Markdown and a safe HTML subset in the chat's lines (owner, 2026-11-06
 * 00:05 JST). Every line goes the same way: `marked` to an HTML string, the
 * browser's inert DOMParser to a tree, and an allowlist walk of that tree to
 * a plain data tree, RichNode. RichText.tsx turns that into React elements, so
 * no string of HTML ever reaches the page and no dangerouslySetInnerHTML
 * exists: only an allowed tag with allowed attributes can come out, whatever
 * the parser or the input does.
 *
 * Tiers (lineTier), from what the hub stamped, never from the text:
 *   html      an agent line the hub marked `ownerGrant`: said in the owner's
 *             thread by a pairing he approved. Raw HTML from the allowlist,
 *             images from IMAGE_ORIGINS.
 *   markdown  everyone else: friends, the partner AI, his own agents in a
 *             friend's thread, and his own typed text (pasted code must not
 *             become page content). Raw HTML shows as the text it is; an
 *             image shows its alt text.
 *
 * `spoken` is what read-aloud says and `at` is each text's place in it, so the
 * sentence highlight (sentenceRanges over `spoken`) lands on the right words:
 * no markup, a link's label not its URL, table cells with commas, code blocks
 * left out. A bare URL in the text is read as it always was.
 */
import { Marked } from "marked";
import { linkAtStart, parseLinks, safeHref, safeImageSrc } from "./chat-links";

export type RichTier = "html" | "markdown";

/** Text; `at` is its offset in `spoken`, absent when it is not read out. */
export type RichString = { text: string; at?: number };
export type RichElement = {
  tag: string;
  attrs?: Record<string, string>;
  children: RichNode[];
  /** A block of code, or the URL shown after a link's label: shown, not read. */
  silent?: boolean;
};
export type RichNode = RichString | RichElement;
export type Rich = {
  nodes: RichNode[];
  /** What read-aloud says. */
  spoken: string;
  /** All of its text with no markup, code included: the one-line views. */
  shown: string;
};

/** The hub's mark and who said it. Only the hub sets `ownerGrant` (workers/push/src/debug.ts say). */
export type TierLine = { from: string; thread?: string; ownerGrant?: boolean };
type View = { embedded?: boolean };

/** lib/dev-eval.ts DISPATCH_THREAD, the `dev` holders' thread (this package imports nothing from the app). */
const DISPATCH_THREAD = "owner";

export function lineTier(m: TierLine, view: View = {}): RichTier {
  const dispatch = (m.thread ?? DISPATCH_THREAD) === DISPATCH_THREAD;
  return m.from === "agent" && m.ownerGrant === true && dispatch && !view.embedded
    ? "html"
    : "markdown";
}

/** Longer than any line the hub keeps (MAX_CHAT): kept as plain text, not parsed. */
const MAX_RICH = 20_000;
const MAX_DEPTH = 24;
const MAX_SPAN = 20;

const MARKDOWN_TAGS = new Set(
  "p br strong em del code pre ul ol li blockquote hr a table thead tbody tr th td".split(" "),
);
const HTML_TAGS = new Set([
  ...MARKDOWN_TAGS,
  ..."b i u s sub sup small mark kbd span div tfoot caption img".split(" "),
]);
/** Dropped with all that is inside; any other unknown tag gives way to its text. */
const DROP =
  /^(script|style|iframe|frame|frameset|object|embed|applet|form|input|button|textarea|select|option|svg|math|template|noscript|noembed|noframes|link|meta|base|title|head|audio|video|canvas|map|area|xmp|plaintext|listing|portal|dialog)$/;
const XHTML = "http://www.w3.org/1999/xhtml";
const HEADING = /^h[1-6]$/;
/** Blocks: in these, the newlines marked leaves between tags are not text. */
const BLOCK = new Set(
  "root p ul ol li blockquote table thead tbody tfoot tr th td div caption".split(" "),
);

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const makeParser = (tier: RichTier) =>
  new Marked({
    gfm: true,
    breaks: true,
    async: false,
    tokenizer: {
      // Bare URLs are parseLinks' (CJK next to them, the punctuation after);
      // here only so that markdown leaves their * and _ alone.
      url(src: string) {
        const raw = linkAtStart(src);
        return raw ? ({ type: "text", raw, text: raw, escaped: false } as never) : undefined;
      },
      // An indented line in a chat is a line, and "a\n---" is not a heading.
      code: () => undefined,
      lheading: () => undefined,
      // Only ~~double~~ strikes through: GFM's single ~ turned "15~20 分钟 … 0:05~"
      // into a struck-out span (owner, 2026-11-13). A lone ~ stays a character.
      del(src: string) {
        const m = /^~~(?=\S)([\s\S]*?\S)~~(?!~)/.exec(src);
        if (!m) return undefined;
        return { type: "del", raw: m[0], text: m[1]!, tokens: this.lexer.inlineTokens(m[1]!) } as never;
      },
    },
    renderer: {
      // No form controls: a task list's box is a character.
      checkbox: ({ checked }) => (checked ? "☑ " : "☐ "),
      ...(tier === "markdown"
        ? {
            html: ({ text }: { text: string }) => escapeHtml(text),
            image: ({ text }: { text: string }) => escapeHtml(text),
          }
        : {}),
    },
  });

const parsers: Partial<Record<RichTier, Marked>> = {};
const parserFor = (tier: RichTier) => (parsers[tier] ??= makeParser(tier));

/** A number attribute within its bound, else nothing. */
function numberAttr(el: Element, name: string, max: number): Record<string, string> {
  const v = el.getAttribute(name);
  if (!v || !/^\d{1,4}$/.test(v) || Number(v) < 1 || Number(v) > max) return {};
  return { [name]: String(Number(v)) };
}

const textOf = (nodes: RichNode[]): string =>
  nodes.map((n) => ("text" in n ? n.text : textOf(n.children))).join("");

/** Text with the URLs in it as links, unless it is already in a link or in code. */
function textNodes(t: string, literal: boolean): RichNode[] {
  if (literal) return [{ text: t }];
  return parseLinks(t).map((s) =>
    s.href ? { tag: "a", attrs: { href: s.href }, children: [{ text: s.text }] } : { text: s.text },
  );
}

/**
 * A link whose text is its URL is one anchor. Any other shows its label, then
 * the real URL as the anchor: a line can't dress one address as another. The
 * URL is shown, not read.
 */
function linkNodes(href: string, label: RichNode[]): RichNode[] {
  const said = textOf(label).trim();
  if (!said) return [{ tag: "a", attrs: { href }, children: [{ text: href }] }];
  const segs = parseLinks(said);
  if (segs.length === 1 && segs[0]!.href === href)
    return [{ tag: "a", attrs: { href }, children: [{ text: said }] }];
  return [
    ...label,
    {
      tag: "span",
      silent: true,
      children: [
        { text: " (" },
        { tag: "a", attrs: { href }, children: [{ text: href }] },
        { text: ")" },
      ],
    },
  ];
}

type Ctx = { tag: string; literal: boolean; pre: boolean; depth: number };

function walkChildren(parent: Node, tier: RichTier, ctx: Ctx): RichNode[] {
  const out: RichNode[] = [];
  for (const n of Array.from(parent.childNodes)) {
    if (n.nodeType === 3) {
      let t = n.nodeValue ?? "";
      if (ctx.pre) t = n === parent.lastChild ? t.replace(/\n$/, "") : t;
      // The newlines between tags; a line break inside text is a <br> by now.
      else if (BLOCK.has(ctx.tag)) t = t.replace(/^\n+|\n+$/g, "");
      if (t) out.push(...textNodes(t, ctx.literal));
    } else if (n.nodeType === 1) out.push(...walkElement(n as Element, tier, ctx));
  }
  return out;
}

function walkElement(el: Element, tier: RichTier, ctx: Ctx): RichNode[] {
  const raw = el.tagName.toLowerCase();
  if (el.namespaceURI !== XHTML || DROP.test(raw)) return [];
  const depth = ctx.depth + 1;
  if (depth > MAX_DEPTH) return [{ text: el.textContent ?? "" }];
  const inner = (tag: string, over: { literal?: boolean; pre?: boolean } = {}) =>
    walkChildren(el, tier, {
      tag,
      depth,
      literal: over.literal ?? ctx.literal,
      pre: over.pre ?? ctx.pre,
    });
  // A heading is a bold line, not a page's title.
  if (HEADING.test(raw)) return [{ tag: "p", children: [{ tag: "strong", children: inner("p") }] }];
  const alt = el.getAttribute("alt") ?? "";
  if (raw === "img") {
    const src = tier === "html" ? safeImageSrc(el.getAttribute("src") ?? "") : null;
    if (!src) return alt ? [{ text: alt }] : [];
    return [
      {
        tag: "img",
        attrs: { src, alt, ...numberAttr(el, "width", 2000), ...numberAttr(el, "height", 2000) },
        children: [],
      },
    ];
  }
  if (!(tier === "html" ? HTML_TAGS : MARKDOWN_TAGS).has(raw)) return inner(ctx.tag);
  if (raw === "a") {
    const href = safeHref(el.getAttribute("href") ?? "");
    const label = inner("a", { literal: true });
    return href ? linkNodes(href, label) : label;
  }
  if (raw === "code") return [{ tag: "code", children: inner("code", { literal: true }) }];
  if (raw === "pre")
    return [{ tag: "pre", silent: true, children: inner("pre", { literal: true, pre: true }) }];
  const attrs: Record<string, string> = {};
  if (raw === "td" || raw === "th") {
    Object.assign(attrs, numberAttr(el, "colspan", MAX_SPAN), numberAttr(el, "rowspan", MAX_SPAN));
    const align = el.getAttribute("align");
    if (align === "left" || align === "center" || align === "right") attrs.align = align;
  }
  if (raw === "ol") Object.assign(attrs, numberAttr(el, "start", 9999));
  return [{ tag: raw, ...(Object.keys(attrs).length ? { attrs } : {}), children: inner(raw) }];
}

const LINE_BLOCK = new Set("p ul ol li blockquote table tr caption div pre hr".split(" "));

/** The nodes as one string: `spoken` (each text's `at` set) or `shown`. */
function flatten(nodes: RichNode[], speak: boolean): string {
  let out = "";
  const line = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const visit = (list: RichNode[]) =>
    list.forEach((n, i) => {
      if ("text" in n) {
        if (speak) n.at = out.length;
        out += n.text;
      } else if (speak && n.silent) {
        return;
      } else if (n.tag === "br") {
        out += "\n";
      } else if (n.tag === "img") {
        out += n.attrs?.alt ?? "";
      } else {
        const block = LINE_BLOCK.has(n.tag);
        if (block) line();
        if ((n.tag === "td" || n.tag === "th") && i > 0) out += ", ";
        visit(n.children);
        if (block) line();
      }
    });
  visit(nodes);
  return out.trimEnd();
}

function plain(text: string): Rich {
  const nodes = textNodes(text, false);
  return { nodes, spoken: flatten(nodes, true), shown: text };
}

function build(text: string, tier: RichTier): Rich {
  const P = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
  if (!P || text.length > MAX_RICH) return plain(text);
  try {
    const html = parserFor(tier).parse(text, { async: false }) as string;
    const body = new P().parseFromString(html, "text/html").body;
    const top = walkChildren(body, tier, { tag: "root", literal: false, pre: false, depth: 0 });
    // One paragraph flows inline, as a plain line always has (a run of lines is one paragraph).
    const only = top.length === 1 ? top[0]! : null;
    const nodes = only && "tag" in only && only.tag === "p" ? only.children : top;
    return { nodes, spoken: flatten(nodes, true), shown: flatten(nodes, false) };
  } catch {
    // A line is never lost to its markup.
    return plain(text);
  }
}

const CACHE_MAX = 400;
const cache = new Map<string, Rich>();

/** A line's tree (read-only), remembered: every render and read-aloud ask for it again. */
export function richOf(text: string, tier: RichTier): Rich {
  const key = `${tier}\0${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const made = build(text, tier);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, made);
  return made;
}

/** What read-aloud says for a line (the line's words, without markup). */
export const spokenOf = (m: TierLine & { text: string }, view?: View) =>
  richOf(m.text, lineTier(m, view)).spoken;

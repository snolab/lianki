/**
 * An interim state tree for the chat's tree panel, until the host passes
 * `renderTree`: an HTML fragment fetched from a dev URL the owner sets in
 * localStorage (`lk:tree-src`). The fragment is never put into the page as
 * HTML. It is parsed here into a small tree of allowed elements with plain
 * text, which React renders as elements and text nodes. No DOM needed, so
 * this is unit-tested as is.
 */

/** localStorage key: the tree fragment's URL. */
export const TREE_SRC_KEY = "lk:tree-src";
/** A fragment larger than this is refused (a debug tree is a few KB). */
export const TREE_MAX_BYTES = 512 * 1024;

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The tree URL, if allowed: https on a tailnet host (*.ts.net), or localhost. */
export function treeSrc(raw: string | null | undefined): URL | null {
  if (!raw?.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:" && u.hostname.endsWith(".ts.net")) return u;
  if ((u.protocol === "https:" || u.protocol === "http:") && LOCAL.has(u.hostname)) return u;
  return null;
}

export const TREE_TAGS = [
  "details",
  "summary",
  "ul",
  "li",
  "div",
  "span",
  "p",
  "b",
  "i",
  "code",
] as const;
export type TreeTag = (typeof TREE_TAGS)[number];
/** A sanitized node: text, or an allowed element with only a class. */
export type TreeNode = string | { tag: TreeTag; cls?: string; children: TreeNode[] };

const ALLOWED = new Set<string>(TREE_TAGS);
/** Dropped with everything inside them, not just the tags. */
const DROP_WHOLE = new Set([
  "script",
  "style",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "noscript",
  "textarea",
  "title",
  "head",
]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "wbr", "source", "area", "col"]);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
/** Character references in text; anything unknown is left as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, ref: string) => {
    if (ref[0] === "#") {
      const n = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[ref.toLowerCase()] ?? all;
  });
}

/** A class attribute's value, reduced to class-name characters. */
function cleanClass(attrs: string): string | undefined {
  const m = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  if (!m) return undefined;
  const v = (m[1] ?? m[2] ?? m[3] ?? "")
    .split(/\s+/)
    .filter((c) => /^[A-Za-z_-][\w-]*$/.test(c))
    .join(" ");
  return v || undefined;
}

const TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<\/\s*([A-Za-z][\w-]*)\s*>|<([A-Za-z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|[^<]+|</g;

/**
 * Parse an HTML fragment into allowed nodes only: details, summary, ul, li,
 * div, span, p, b, i and code, each with at most a `class`. Every other
 * attribute (event handlers, style, href…) is dropped; scripts, styles and
 * the like go with their contents; any other tag (a link, an image) is
 * dropped and its text kept. Text comes back decoded, to be rendered as text.
 */
export function sanitizeTree(html: string): TreeNode[] {
  const root: { children: TreeNode[] } = { children: [] };
  /** Open elements; `null` for a disallowed tag whose text is kept. */
  const stack: { name: string; node: { children: TreeNode[] } }[] = [{ name: "", node: root }];
  const top = () => stack[stack.length - 1].node;
  let skip: string | null = null;
  for (const m of html.matchAll(TOKEN)) {
    const [tok, close, open, attrs = "", selfClose] = m;
    if (skip) {
      if (close?.toLowerCase() === skip) skip = null;
      continue;
    }
    if (open) {
      const name = open.toLowerCase();
      if (DROP_WHOLE.has(name)) {
        if (!selfClose) skip = name;
        continue;
      }
      if (VOID.has(name) || selfClose) continue;
      if (ALLOWED.has(name)) {
        const el = { tag: name as TreeTag, cls: cleanClass(attrs), children: [] as TreeNode[] };
        if (!el.cls) delete el.cls;
        top().children.push(el);
        stack.push({ name, node: el });
      } else stack.push({ name, node: top() }); // its text joins the parent
      continue;
    }
    if (close) {
      const name = close.toLowerCase();
      for (let i = stack.length - 1; i > 0; i--)
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      continue;
    }
    if (tok.startsWith("<!") || tok.startsWith("<?")) continue; // comments, doctypes
    const text = decodeEntities(tok);
    const kids = top().children;
    if (typeof kids.at(-1) === "string") kids[kids.length - 1] = (kids.at(-1) as string) + text;
    else kids.push(text);
  }
  return root.children;
}

/** How a fragment's classes show: waiting on the owner, doing, done, the frontier. */
export function treeClassStyle(cls: string | undefined): Record<string, string | number> {
  const has = new Set((cls ?? "").split(" "));
  const s: Record<string, string | number> = {};
  if (has.has("w")) {
    s.color = "oklch(0.62 0.17 35)";
    s.fontWeight = 700;
  }
  if (has.has("d")) s.color = "oklch(0.62 0.14 250)";
  if (has.has("ok")) s.opacity = 0.6;
  if (has.has("f")) {
    s.marginBlockEnd = "0.375rem";
    s.paddingInlineStart = "0.25rem";
  }
  return s;
}

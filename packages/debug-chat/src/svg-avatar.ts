/**
 * Agents' avatars (docs/dev-debug-widget.md, "Agent avatars"), the pure part:
 * the strict SVG sanitizer the hub runs on an avatar an agent (or the owner)
 * sets, and the page runs again on what it fetches; and the generated mark an
 * agent without one gets from its name. No DOM, no React: the Worker, the page
 * and the unit tests share it.
 *
 * The sanitizer never repairs markup in place: it tokenizes the input, keeps
 * only allowlisted elements and attributes whose values match a strict shape,
 * and writes a fresh document from what it kept. Anything that could reach
 * outside the picture (href, url(), var(), style, event handlers, <use>,
 * <image>, <foreignObject>, <script>, entities, DOCTYPE) is not in the output.
 */
import type { LaneMark } from "./voices";

/** The most an avatar's SVG may be, in UTF-8 bytes, before and after sanitizing. */
export const AVATAR_MAX_BYTES = 4096;
const MAX_ELEMENTS = 200;
const MAX_DEPTH = 16;
export const SVG_NS = "http://www.w3.org/2000/svg";

/** The elements kept. Any other element is dropped with everything inside it. */
export const AVATAR_ELEMENTS = [
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
] as const;
const ELEMENTS = new Set<string>(AVATAR_ELEMENTS);
/** Elements whose text is kept (escaped). */
const TEXT_ELEMENTS = new Set(["text", "tspan", "title"]);

const NUM = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?(px|%)?$/;
const NUMS = /^[0-9eE.,+\-\s]*$/;
const PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/;
/** One transform function, matched in place (sticky): name, numbers, separators after it. */
const TRANSFORM_STEP = /(matrix|translate|scale|rotate|skewX|skewY)\s*\([0-9eE.,+\-\s]*\)[\s,]*/y;
/**
 * A transform list of plain number functions. Parsed one function at a time,
 * so the time is linear in its length (a single nested pattern can backtrack
 * exponentially on "scale(scale(…").
 */
function transformList(v: string): boolean {
  let i = 0;
  while (i < v.length && /\s/.test(v[i]!)) i++;
  while (i < v.length) {
    TRANSFORM_STEP.lastIndex = i;
    if (!TRANSFORM_STEP.test(v)) return false;
    i = TRANSFORM_STEP.lastIndex;
  }
  return true;
}
/** A plain colour: a keyword, a hex, or a colour function of numbers. Never url() or var(). */
const COLOR =
  /^(none|currentColor|transparent|[a-zA-Z]{3,20}|#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(\s*[0-9eE.,%+\-\s/]*(deg|turn|rad)?[0-9eE.,%+\-\s/]*\))$/;
const NOT_COLOR_WORDS = new Set(["url", "var", "inherit", "expression", "attr", "env"]);

type Check = (v: string) => boolean;
const num: Check = (v) => v.length <= 32 && NUM.test(v.trim());
const nums: Check = (v) => v.length <= 1024 && NUMS.test(v);
const color: Check = (v) =>
  v.length <= 64 && COLOR.test(v.trim()) && !NOT_COLOR_WORDS.has(v.trim().toLowerCase());
const oneOf =
  (...xs: string[]): Check =>
  (v) =>
    xs.includes(v.trim());

/** The attributes kept, each with the only shape its value may have. */
export const AVATAR_ATTRIBUTES: Readonly<Record<string, Check>> = {
  viewBox: nums,
  width: num,
  height: num,
  x: num,
  y: num,
  dx: num,
  dy: num,
  cx: num,
  cy: num,
  r: num,
  rx: num,
  ry: num,
  x1: num,
  y1: num,
  x2: num,
  y2: num,
  d: (v) => v.length <= AVATAR_MAX_BYTES && PATH.test(v),
  points: nums,
  transform: (v) => v.length <= 512 && transformList(v),
  fill: color,
  stroke: color,
  "stroke-width": num,
  "stroke-linecap": oneOf("butt", "round", "square"),
  "stroke-linejoin": oneOf("miter", "round", "bevel"),
  "fill-rule": oneOf("nonzero", "evenodd"),
  opacity: num,
  "fill-opacity": num,
  "stroke-opacity": num,
  "font-size": num,
  "font-weight": oneOf("normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"),
  "text-anchor": oneOf("start", "middle", "end"),
  "dominant-baseline": oneOf("auto", "middle", "central", "hanging", "alphabetic"),
};

export type SanitizeResult =
  | { ok: true; svg: string; dropped: string[] }
  | { ok: false; error: string };

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");
const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Text with only the five XML entities and numeric ones; null when another entity is in it. */
function decodeText(s: string): string | null {
  let bad = /&(?!(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{1,8});)/.test(s);
  const out = s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{1,8});/g, (_, e: string) => {
    if (e.startsWith("#")) {
      const n = e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n < 32 || n > 0x10ffff) return ((bad = true), "");
      return String.fromCodePoint(n);
    }
    if (ENTITY[e] === undefined) bad = true;
    return ENTITY[e] ?? "";
  });
  return bad ? null : out;
}

type Node = { name: string; attrs: [string, string][]; kids: (Node | string)[] };

/**
 * An avatar SVG made safe, or why not. Refused outright: not a string, over
 * AVATAR_MAX_BYTES, a DOCTYPE/ENTITY/CDATA/processing instruction (an XML
 * declaration at the start is allowed), broken nesting, a root that is not
 * <svg>, too many elements or too deep. Dropped (named in `dropped`): any
 * element outside AVATAR_ELEMENTS with its subtree, any attribute outside
 * AVATAR_ATTRIBUTES or whose value fails its shape, text outside text, tspan
 * and title. The output is written fresh: `xmlns` set, every value escaped.
 */
export function sanitizeAvatarSvg(raw: unknown): SanitizeResult {
  if (typeof raw !== "string") return { ok: false, error: "svg must be a string" };
  if (utf8Bytes(raw) > AVATAR_MAX_BYTES)
    return { ok: false, error: `svg over ${AVATAR_MAX_BYTES} bytes` };
  let s = raw.replace(/^﻿/, "").trim();
  s = s.replace(/^<\?xml[^?]{0,200}\?>\s*/, "");
  // Comments go, again until none is left ("<<!--!-->!--…-->" leaves a new one
  // after one pass); anything else that starts with <! or <? is refused.
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/<!--[\s\S]*?-->/g, "");
  }
  if (/<!|<\?/.test(s)) return { ok: false, error: "no DOCTYPE, ENTITY, CDATA or <? … ?>" };
  const dropped = new Set<string>();
  const root: Node = { name: "#root", attrs: [], kids: [] };
  const stack: Node[] = [root];
  /** Inside a dropped element: how deep, so its subtree goes with it. */
  let skip = 0;
  let count = 0;
  const TAG = /<(\/?)([A-Za-z][\w:.-]{0,40})((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/y;
  const ATTR = /\s+([^\s=>/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/y;
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const text = s.slice(i, lt < 0 ? s.length : lt);
    if (text) {
      const top = stack[stack.length - 1]!;
      if (!skip && text.trim()) {
        if (!TEXT_ELEMENTS.has(top.name)) dropped.add("text outside text/tspan/title");
        else {
          const t = decodeText(text);
          if (t === null) return { ok: false, error: "only the five XML entities are allowed" };
          top.kids.push(t);
        }
      }
    }
    if (lt < 0) break;
    TAG.lastIndex = lt;
    const m = TAG.exec(s);
    if (!m) return { ok: false, error: "malformed tag" };
    i = TAG.lastIndex;
    const [, close, name, attrText, selfClose] = m;
    if (close) {
      if (attrText!.trim() || selfClose) return { ok: false, error: "malformed end tag" };
      if (skip) {
        skip--;
        continue;
      }
      const top = stack.pop()!;
      if (top.name !== name || stack.length === 0)
        return { ok: false, error: `mismatched </${name}>` };
      continue;
    }
    if (skip || !ELEMENTS.has(name!) || (name === "svg" && stack.length > 1)) {
      if (!skip) dropped.add(`<${name}>`);
      if (!selfClose) skip++;
      continue;
    }
    if (++count > MAX_ELEMENTS) return { ok: false, error: `over ${MAX_ELEMENTS} elements` };
    if (stack.length > MAX_DEPTH) return { ok: false, error: `nested over ${MAX_DEPTH} deep` };
    const node: Node = { name: name!, attrs: [], kids: [] };
    ATTR.lastIndex = 0;
    let a: RegExpExecArray | null;
    const rest = attrText ?? "";
    let at = 0;
    while (at < rest.length) {
      ATTR.lastIndex = at;
      a = ATTR.exec(rest);
      if (!a) break;
      at = ATTR.lastIndex;
      const key = a[1]!;
      const value = a[3] ?? a[4];
      if (key === "xmlns" && name === "svg" && value === SVG_NS) continue;
      const check = Object.hasOwn(AVATAR_ATTRIBUTES, key) ? AVATAR_ATTRIBUTES[key] : undefined;
      if (!check || value === undefined || value.includes("&") || !check(value)) {
        dropped.add(`@${key.slice(0, 40)}`);
        continue;
      }
      if (node.attrs.some(([k]) => k === key)) continue;
      node.attrs.push([key, value.trim()]);
    }
    if (at < rest.trim().length && rest.slice(at).trim())
      return { ok: false, error: "malformed attributes" };
    stack[stack.length - 1]!.kids.push(node);
    if (!selfClose) stack.push(node);
  }
  if (skip || stack.length !== 1) return { ok: false, error: "unclosed element" };
  const svgs = root.kids.filter((k): k is Node => typeof k !== "string");
  if (svgs.length !== 1 || svgs[0]!.name !== "svg" || root.kids.length !== 1)
    return { ok: false, error: "expected one <svg> root" };
  const top = svgs[0]!;
  if (!top.attrs.some(([k]) => k === "viewBox")) {
    const w = top.attrs.find(([k]) => k === "width")?.[1];
    const h = top.attrs.find(([k]) => k === "height")?.[1];
    const nw = Number.parseFloat(w ?? "");
    const nh = Number.parseFloat(h ?? "");
    top.attrs.unshift([
      "viewBox",
      Number.isFinite(nw) && Number.isFinite(nh) && nw > 0 && nh > 0 && !/%/.test(`${w}${h}`)
        ? `0 0 ${nw} ${nh}`
        : "0 0 24 24",
    ]);
  }
  const write = (n: Node): string => {
    const attrs = (n.name === "svg" ? [["xmlns", SVG_NS] as [string, string], ...n.attrs] : n.attrs)
      .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
      .join("");
    const kids = n.kids.map((k) => (typeof k === "string" ? escText(k) : write(k))).join("");
    return kids ? `<${n.name}${attrs}>${kids}</${n.name}>` : `<${n.name}${attrs}/>`;
  };
  const svg = write(top);
  if (utf8Bytes(svg) > AVATAR_MAX_BYTES)
    return { ok: false, error: `svg over ${AVATAR_MAX_BYTES} bytes` };
  return { ok: true, svg, dropped: [...dropped] };
}

/** An avatar's reference on a line: the SHA-256 (hex) of its sanitized SVG. */
export const AVATAR_REF = /^[0-9a-f]{64}$/;
export const isAvatarRef = (v: unknown): v is string => typeof v === "string" && AVATAR_REF.test(v);

/** Where a page fetches an avatar by its reference (lianki-push, content-addressed). */
export const AVATAR_PATH = "/api/version/chat-avatar/";

// --- The generated mark -------------------------------------------------------

/** FNV-1a, 32 bits: the same name gives the same number on every device. */
export function nameHash(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name.trim().toLowerCase()) {
    const c = ch.codePointAt(0)!;
    h ^= c & 0xff;
    h = Math.imul(h, 0x01000193);
    if (c > 0xff) {
      h ^= c >>> 8;
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

/** The glyphs a generated mark draws (24×24, as LaneMark's). */
export const AUTO_GLYPHS: readonly LaneMark["paths"][] = [
  [{ d: "M12 5.5l6.5 11.5h-13Z", fill: true }],
  [{ d: "M7 7h10v10H7Z", fill: true }],
  [{ d: "M7 12a5 5 0 1 0 10 0a5 5 0 1 0-10 0" }],
  [{ d: "M12 6v12M6 12h12" }],
  [{ d: "M12 5l7 7-7 7-7-7Z", fill: true }],
  [{ d: "M7 8v8M12 6v12M17 9v6" }],
  [{ d: "M12 5l6 3.5v7L12 19l-6-3.5v-7Z", fill: true }],
  [{ d: "M7 10l5 5 5-5" }],
  [{ d: "M7.5 7.5l9 9M16.5 7.5l-9 9" }],
];

/**
 * The mark of an agent with none of its own: an oklch disc whose hue comes
 * from its name's hash, and one of AUTO_GLYPHS. Mid lightness, so it reads on
 * the light and the dark log alike (as LANES' marks).
 */
export function autoMark(name: string): LaneMark {
  const h = nameHash(name || "agent");
  const hue = h % 360;
  return {
    bg: `oklch(0.6 0.13 ${hue})`,
    fg: `oklch(0.98 0.02 ${hue})`,
    paths: AUTO_GLYPHS[(h >>> 9) % AUTO_GLYPHS.length]!,
  };
}

/** A sanitized SVG as an image URL (an <img> never runs script or loads anything else). */
export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

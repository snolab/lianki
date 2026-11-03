// A tiny, tolerant XML/XHTML reader for EPUB files — no DOM, no DTD.
//
// Why our own: the parser must run in the browser and in `bun test` alike, and
// it must never expand entities. DOCTYPE declarations (and any internal
// subset) are skipped whole, so "billion laughs" and external entities (XXE)
// have nothing to act on; only the five XML entities, numeric references and
// a short list of common HTML names are decoded, one pass, no recursion.

export type XmlNode = XmlElement | string;

export interface XmlElement {
  /** Local name, lower-cased, namespace prefix dropped (`dc:title` → `title`). */
  name: string;
  /** Attribute names keep their prefix, lower-cased (`epub:type`, `xml:lang`). */
  attrs: Record<string, string>;
  children: XmlNode[];
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  shy: "",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  middot: "·",
  bull: "•",
  thinsp: " ",
  ensp: " ",
  emsp: " ",
  zwnj: "‌",
  zwj: "‍",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  acirc: "â",
  ccedil: "ç",
  ocirc: "ô",
  ucirc: "û",
  ugrave: "ù",
  icirc: "î",
  iuml: "ï",
  euml: "ë",
  oelig: "œ",
  aelig: "æ",
  Eacute: "É",
  Egrave: "È",
  Agrave: "À",
  Ccedil: "Ç",
  OElig: "Œ",
};

/** Decode entity references once. Unknown names are left as written. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, ref) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return "�";
      }
      return String.fromCodePoint(code);
    }
    return NAMED[ref] ?? NAMED[ref.toLowerCase()] ?? m;
  });
}

const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
// Elements that never have content in XHTML served as HTML.
const VOID = new Set([
  "br",
  "hr",
  "img",
  "meta",
  "link",
  "input",
  "col",
  "area",
  "base",
  "wbr",
  "source",
]);
const RAW = new Set(["script", "style"]);

function localName(qname: string): string {
  const lower = qname.toLowerCase();
  const i = lower.indexOf(":");
  return i >= 0 ? lower.slice(i + 1) : lower;
}

/** Parse markup into a tree. Malformed input yields a best-effort tree, never throws. */
export function parseXml(src: string): XmlElement {
  const root: XmlElement = { name: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = src.length;
  const top = () => stack[stack.length - 1];

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      top().children.push(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) top().children.push(decodeEntities(src.slice(i, lt)));

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      top().children.push(src.slice(lt + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[lt + 1] === "!") {
      // <!DOCTYPE …> possibly with an internal subset [ … ]: skipped, never interpreted.
      let j = lt + 2;
      let depth = 0;
      while (j < n) {
        const c = src[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (src[lt + 1] === "?") {
      const end = src.indexOf("?>", lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }

    const gt = findTagEnd(src, lt + 1);
    if (gt < 0) {
      // A bare "<" in text: keep it as text and go on.
      top().children.push("<");
      i = lt + 1;
      continue;
    }
    const inner = src.slice(lt + 1, gt);
    i = gt + 1;

    if (inner[0] === "/") {
      const name = localName(inner.slice(1).trim());
      // Pop to the matching open element; ignore a stray close tag.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const m = /^\s*([^\s/>]+)/.exec(body);
    if (!m) {
      top().children.push(decodeEntities("<" + inner + ">"));
      continue;
    }
    const name = localName(m[1]);
    const attrs: Record<string, string> = {};
    ATTR.lastIndex = m[0].length;
    for (let a = ATTR.exec(body); a; a = ATTR.exec(body)) {
      attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
    }
    const el: XmlElement = { name, attrs, children: [] };
    top().children.push(el);
    if (selfClosing || VOID.has(name)) continue;
    if (RAW.has(name)) {
      // Raw text: skip to the close tag without parsing what is inside.
      const close = src.toLowerCase().indexOf(`</${m[1].toLowerCase()}`, i);
      const end = close < 0 ? n : src.indexOf(">", close);
      i = end < 0 ? n : end + 1;
      continue;
    }
    stack.push(el);
  }
  return root;
}

function findTagEnd(src: string, from: number): number {
  let quote = "";
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return j;
    else if (c === "<") return -1;
  }
  return -1;
}

export function* walk(el: XmlElement): Generator<XmlElement> {
  for (const c of el.children) {
    if (typeof c === "string") continue;
    yield c;
    yield* walk(c);
  }
}

export function find(el: XmlElement, name: string): XmlElement | undefined {
  for (const e of walk(el)) if (e.name === name) return e;
  return undefined;
}

export function findAll(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const e of walk(el)) if (e.name === name) out.push(e);
  return out;
}

export function textOf(el: XmlNode): string {
  if (typeof el === "string") return el;
  return el.children.map(textOf).join("");
}

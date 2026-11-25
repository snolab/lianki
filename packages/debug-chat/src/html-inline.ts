/**
 * Script-free HTML widgets, drawn inline (owner, 2026-11-25: "它本身可以
 * self-contained"). An agent's ```lianki-html block with no script goes through
 * this allowlist walk, like rich-text.ts: the browser's inert DOMParser to a
 * tree, then only allowed tags, attributes and style properties come out, as
 * data (InlineNode) that HtmlInline.tsx turns into React elements. No string of
 * HTML ever reaches the page.
 *
 * Dropped: script, style, iframe, object, embed, link, meta, base, svg, math,
 * template, every on* attribute, class, javascript:/data: links, remote images
 * (they would tell a server he looked), and any style property that could move
 * the widget over the page (position, z-index, transform, …) or load
 * something (url(), image-set, @import). ids are prefixed per widget so a
 * label's `for` still works and nothing collides with the page.
 *
 * Forms are kept as written (action, method, formtarget, formaction): the page
 * never submits them anywhere. A submit becomes his line in his own thread,
 * "↳ <action>: name=value, …", so the agent that posted the widget gets it with
 * the action string as its routing key (HtmlInline.tsx). formtarget=_blank opens
 * nothing: there is no other window to send his session to.
 *
 * HTML that does contain script (a <script>, an on* handler, a javascript: URL)
 * is not drawn inline: it runs in the sandboxed frame instead (html-widget.ts).
 */
import { safeHref } from "./chat-links";

export type InlineNode =
  | { text: string }
  | { tag: string; attrs: Record<string, string>; style?: Record<string, string>; children: InlineNode[] };

const TAGS = new Set(
  (
    "div span p br hr b i u s strong em small mark sub sup code pre kbd blockquote " +
    "ul ol li dl dt dd table thead tbody tfoot tr th td caption details summary " +
    "label form fieldset legend input select option optgroup textarea button output progress meter " +
    "figure figcaption img a"
  ).split(" "),
);
/** Dropped with everything inside. */
const DROP =
  /^(script|style|iframe|frame|frameset|object|embed|applet|link|meta|base|title|head|svg|math|template|noscript|noembed|noframes|audio|video|canvas|map|area|xmp|plaintext|listing|portal|dialog|slot)$/;
const HEADING = /^h[1-6]$/;
const XHTML = "http://www.w3.org/1999/xhtml";

/** Attributes by tag; "*" for every allowed tag. */
const ATTRS: Record<string, readonly string[]> = {
  "*": ["title", "lang", "dir", "id"],
  a: ["href"],
  img: ["src", "alt", "width", "height"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  ol: ["start"],
  label: ["for"],
  form: ["action", "method", "name", "target"],
  input: [
    "type", "name", "value", "placeholder", "min", "max", "step", "checked", "disabled",
    "required", "readonly", "maxlength", "size", "multiple", "list", "formaction", "formtarget",
  ],
  select: ["name", "multiple", "required", "disabled", "size"],
  option: ["value", "selected", "disabled", "label"],
  optgroup: ["label", "disabled"],
  textarea: ["name", "rows", "cols", "placeholder", "maxlength", "required", "readonly", "disabled"],
  button: ["type", "name", "value", "disabled", "formaction", "formtarget", "formmethod"],
  output: ["for", "name"],
  progress: ["value", "max"],
  meter: ["value", "min", "max", "low", "high", "optimum"],
  details: ["open"],
  fieldset: ["disabled", "name"],
};
const INPUT_TYPES = new Set(
  "text number email tel url date time datetime-local month week color range checkbox radio search hidden submit reset button".split(
    " ",
  ),
);
/** Style properties that only change how the widget's own box looks. */
const STYLE_PROPS = new Set(
  (
    "color background-color font-weight font-style font-size font-family text-align text-decoration " +
    "text-transform line-height letter-spacing white-space word-break vertical-align list-style-type " +
    "padding padding-top padding-right padding-bottom padding-left padding-inline padding-block " +
    "margin margin-top margin-right margin-bottom margin-left margin-inline margin-block " +
    "border border-top border-right border-bottom border-left border-color border-width border-style " +
    "border-radius border-collapse border-spacing width min-width max-width height min-height max-height " +
    "display flex flex-direction flex-wrap flex-grow flex-shrink flex-basis gap row-gap column-gap " +
    "align-items align-self justify-content grid-template-columns grid-column grid-row opacity " +
    "box-sizing overflow overflow-x overflow-y accent-color cursor"
  ).split(" "),
);
const DISPLAY = /^(block|inline|inline-block|flex|inline-flex|grid|inline-grid|none|list-item|table|table-row|table-cell)$/;
/** Anything that loads, runs or escapes. */
const BAD_VALUE = /url\s*\(|image-set|expression|javascript:|@import|\\|attr\s*\(|var\s*\(|env\s*\(|fixed|sticky/i;

const MAX_NODES = 2000;
const MAX_DEPTH = 32;

/** Does this HTML need the sandboxed frame (it has script in some form)? */
export function needsFrame(doc: Document): boolean {
  if (doc.querySelector("script, iframe, object, embed")) return true;
  for (const el of Array.from(doc.querySelectorAll("*")))
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name)) return true;
      if (/^\s*javascript:/i.test(a.value)) return true;
    }
  return false;
}

const camel = (p: string) => p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function styleOf(el: Element): Record<string, string> | undefined {
  const st = (el as HTMLElement).style;
  if (!st || !st.length) return undefined;
  const out: Record<string, string> = {};
  for (let i = 0; i < st.length; i++) {
    const prop = st.item(i);
    if (!STYLE_PROPS.has(prop)) continue;
    const v = st.getPropertyValue(prop).trim();
    if (!v || v.length > 200 || BAD_VALUE.test(v)) continue;
    if (prop === "display" && !DISPLAY.test(v)) continue;
    out[camel(prop)] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function attrsOf(el: Element, tag: string, idPrefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  const allowed = new Set([...(ATTRS["*"] ?? []), ...(ATTRS[tag] ?? [])]);
  for (const a of Array.from(el.attributes)) {
    const name = a.name.toLowerCase();
    if (!allowed.has(name)) continue;
    let v = a.value.slice(0, 500);
    if (name === "id" || name === "for" || name === "list")
      v = v.replace(/[^\w-]/g, "").slice(0, 40) ? `${idPrefix}${v.replace(/[^\w-]/g, "").slice(0, 40)}` : "";
    else if (name === "href") v = safeHref(v) ?? "";
    else if (name === "src") v = /^data:image\/(png|gif|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(v) ? v : "";
    else if (tag === "input" && name === "type") v = INPUT_TYPES.has(v.toLowerCase()) ? v.toLowerCase() : "text";
    if (v === "" && (name === "href" || name === "src" || name === "id" || name === "for")) continue;
    out[name] = v;
  }
  return out;
}

/**
 * The widget's tree, or null when it has script (then it runs in the frame).
 * `idPrefix` keeps its ids its own (one per widget on the page).
 */
export function inlineHtml(html: string, idPrefix: string): InlineNode[] | null {
  const P = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
  if (!P) return [{ text: html }];
  const doc = new P().parseFromString(html, "text/html");
  if (needsFrame(doc)) return null;
  let count = 0;
  const walk = (parent: Node, depth: number, pre: boolean): InlineNode[] => {
    const out: InlineNode[] = [];
    for (const n of Array.from(parent.childNodes)) {
      if (++count > MAX_NODES) break;
      if (n.nodeType === 3) {
        const t = n.nodeValue ?? "";
        if (pre ? t : t.trim() || / /.test(t)) out.push({ text: pre ? t : t.replace(/\s+/g, " ") });
        continue;
      }
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      const raw = el.tagName.toLowerCase();
      if (el.namespaceURI !== XHTML || DROP.test(raw)) continue;
      if (depth > MAX_DEPTH) {
        out.push({ text: el.textContent ?? "" });
        continue;
      }
      if (HEADING.test(raw)) {
        out.push({ tag: "p", attrs: {}, children: [{ tag: "strong", attrs: {}, children: walk(el, depth + 1, pre) }] });
        continue;
      }
      if (!TAGS.has(raw)) {
        out.push(...walk(el, depth + 1, pre));
        continue;
      }
      if (raw === "img" && !el.getAttribute("src")?.startsWith("data:image/")) {
        const alt = el.getAttribute("alt");
        if (alt) out.push({ text: alt });
        continue;
      }
      const style = styleOf(el);
      out.push({
        tag: raw,
        attrs: attrsOf(el, raw, idPrefix),
        ...(style ? { style } : {}),
        children: raw === "textarea" ? [{ text: el.textContent ?? "" }] : walk(el, depth + 1, pre || raw === "pre"),
      });
    }
    return out;
  };
  return walk(doc.body, 0, false);
}

/** The line a submit becomes: "↳ /action_page.php: fname=John, lname=Doe". */
export function formLine(action: string, fields: [string, string][]): string {
  const kv = fields
    .filter(([k]) => k)
    .slice(0, 30)
    .map(([k, v]) => `${k.slice(0, 40)}=${v.slice(0, 300)}`)
    .join(", ");
  const key = action.trim().slice(0, 200) || "submit";
  return kv ? `↳ ${key}: ${kv}` : `↳ ${key}`;
}

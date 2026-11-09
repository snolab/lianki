/**
 * The mail template engine (docs/mail-templates.md): validate a template
 * source and render it with variables. Pure and client-safe — the /dev/templates
 * editor runs the same code for its live preview that a send runs.
 *
 * A source is `{subject, html, text}` with `{name}` placeholders.
 *
 * Validation (on save, and again at send time):
 * - every placeholder is a declared variable of that template (or a global one,
 *   `{brand}` `{brandLong}`); an unknown or malformed one is refused, and so is
 *   a stray `{` or `}`;
 * - every REQUIRED variable appears in the HTML and in the text; a link
 *   variable must be a link in the HTML (`href="{url}"`);
 * - the HTML is a fragment of allow-listed tags and attributes only: no script,
 *   style, iframe, form, svg…, no `on*` handler, links only https/http/mailto or
 *   a link variable, images only from https, inline styles without url(),
 *   expression() or escapes. Refused, never silently stripped — what is saved
 *   is what is sent;
 * - a variable inside a tag only as a whole `href="{linkVar}"`.
 *
 * Rendering escapes every value in the HTML (& < > " '); the subject gets no
 * line breaks; the text part takes values as they are.
 */

export type VarKind = "url" | "text";
export type VarSpec = { kind: VarKind; required: boolean };
export type VarSpecs = Record<string, VarSpec>;
export type TemplateSource = { subject: string; html: string; text: string };
export type TemplateField = keyof TemplateSource;

/** Variables every template may use; filled at every send (brand.ts). */
export const GLOBAL_VARS: VarSpecs = {
  brand: { kind: "text", required: false },
  brandLong: { kind: "text", required: false },
};

export const LIMITS = { subject: 300, html: 60_000, text: 30_000 } as const;

export type TemplateErrorCode =
  | "empty"
  | "too-long"
  | "subject-newline"
  | "malformed-placeholder"
  | "unknown-var"
  | "missing-var"
  | "link-var-not-link"
  | "html-syntax"
  | "html-comment"
  | "html-tag"
  | "html-event-handler"
  | "html-attr"
  | "html-href"
  | "html-src"
  | "html-style"
  | "var-in-attr";

export type TemplateError = { field: TemplateField; code: TemplateErrorCode; detail?: string };

const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "center",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const COMMON_ATTRS = new Set([
  "style",
  "dir",
  "lang",
  "align",
  "valign",
  "width",
  "height",
  "title",
  "class",
  "role",
]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
  img: new Set(["src", "alt"]),
  table: new Set(["border", "cellpadding", "cellspacing", "bgcolor"]),
  td: new Set(["colspan", "rowspan", "bgcolor", "nowrap"]),
  th: new Set(["colspan", "rowspan", "bgcolor", "nowrap", "scope"]),
  tr: new Set(["bgcolor"]),
};

const NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;
const STATIC_HREF = /^(https?:\/\/|mailto:)[^\s"'<>{}`\\]+$/i;
const STATIC_SRC = /^https:\/\/[^\s"'<>{}`\\]+$/i;
const BAD_STYLE =
  /url\s*\(|expression|javascript|vbscript|@import|behaviou?r|-moz-binding|[\\<>{}`]|&#|position\s*:\s*(fixed|absolute)/i;

const TAG_RE =
  /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** The placeholders of a string, and whether its braces balance. */
export function placeholders(s: string): { names: string[]; malformed: string[] } {
  const names: string[] = [];
  const malformed: string[] = [];
  const rest = s.replace(/\{([^{}]*)\}/g, (_m, inner: string) => {
    if (NAME.test(inner)) names.push(inner);
    else malformed.push(`{${inner}}`);
    return "";
  });
  if (/[{}]/.test(rest)) malformed.push(rest.includes("{") ? "{" : "}");
  return { names, malformed };
}

function checkHtml(html: string, vars: VarSpecs, errors: TemplateError[]) {
  const err = (code: TemplateErrorCode, detail?: string) =>
    errors.push({ field: "html", code, detail });
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      err("html-comment");
      return;
    }
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(html);
    if (!m) {
      err("html-syntax", html.slice(lt, lt + 30));
      return;
    }
    i = TAG_RE.lastIndex;
    const tag = m[2].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      err("html-tag", tag);
      continue;
    }
    if (m[1]) continue; // closing tag: no attributes to check
    ATTR_RE.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR_RE.exec(m[3]))) {
      const name = a[1].toLowerCase();
      const value = a[2] ?? a[3] ?? a[4] ?? "";
      if (name.startsWith("on")) {
        err("html-event-handler", name);
        continue;
      }
      if (!COMMON_ATTRS.has(name) && !TAG_ATTRS[tag]?.has(name)) {
        err("html-attr", `${tag} ${name}`);
        continue;
      }
      const whole = value.match(/^\{([a-zA-Z][a-zA-Z0-9]*)\}$/);
      if (name === "href") {
        if (whole) {
          if (vars[whole[1]]?.kind !== "url") err("var-in-attr", `href {${whole[1]}}`);
        } else if (/[{}]/.test(value)) err("var-in-attr", "href");
        else if (!STATIC_HREF.test(value.trim())) err("html-href", value.slice(0, 60));
        continue;
      }
      if (/[{}]/.test(value)) {
        err(name === "style" ? "html-style" : "var-in-attr", name);
        continue;
      }
      if (name === "src" && !STATIC_SRC.test(value.trim())) err("html-src", value.slice(0, 60));
      if (name === "style" && BAD_STYLE.test(value)) err("html-style", value.slice(0, 60));
    }
  }
}

/** Every reason this source cannot be saved or sent; empty when it is fine. */
export function validateSource(source: TemplateSource, templateVars: VarSpecs): TemplateError[] {
  const vars = { ...GLOBAL_VARS, ...templateVars };
  const errors: TemplateError[] = [];
  const fields: TemplateField[] = ["subject", "html", "text"];
  const seen: Record<TemplateField, Set<string>> = {
    subject: new Set(),
    html: new Set(),
    text: new Set(),
  };
  for (const f of fields) {
    const s = source[f];
    if (typeof s !== "string" || !s.trim()) {
      errors.push({ field: f, code: "empty" });
      continue;
    }
    if (s.length > LIMITS[f])
      errors.push({ field: f, code: "too-long", detail: String(LIMITS[f]) });
    const { names, malformed } = placeholders(s);
    for (const bad of malformed)
      errors.push({ field: f, code: "malformed-placeholder", detail: bad });
    for (const n of names) {
      if (!(n in vars)) errors.push({ field: f, code: "unknown-var", detail: n });
      seen[f].add(n);
    }
  }
  if (typeof source.subject === "string" && /[\r\n]/.test(source.subject))
    errors.push({ field: "subject", code: "subject-newline" });
  if (typeof source.html === "string" && source.html.trim()) checkHtml(source.html, vars, errors);

  for (const [name, spec] of Object.entries(templateVars)) {
    if (!spec.required) continue;
    for (const f of ["html", "text"] as const)
      if (typeof source[f] === "string" && source[f].trim() && !seen[f].has(name))
        errors.push({ field: f, code: "missing-var", detail: name });
    if (
      spec.kind === "url" &&
      typeof source.html === "string" &&
      seen.html.has(name) &&
      !new RegExp(`href\\s*=\\s*(["']?)\\{${name}\\}\\1`).test(source.html)
    )
      errors.push({ field: "html", code: "link-var-not-link", detail: name });
  }
  return errors;
}

const ENTITY: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITY[c]);

/** Escape copy text for an HTML source, leaving its `{placeholders}` intact. */
export const escapeCopy = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class TemplateRenderError extends Error {
  constructor(
    public reason: string,
    public errors: TemplateError[] = [],
  ) {
    super(`template: ${reason}${errors.length ? ` (${errors.map((e) => e.code).join(",")})` : ""}`);
  }
}

const SAFE_URL = /^https?:\/\/[^\s<>"]+$/i;

/**
 * Render a source with values. Throws TemplateRenderError when the source does
 * not validate, a required value is missing, or a link value is not http(s).
 */
export function renderSource(
  source: TemplateSource,
  templateVars: VarSpecs,
  values: Record<string, string | number | null | undefined>,
): TemplateSource {
  const errors = validateSource(source, templateVars);
  if (errors.length) throw new TemplateRenderError("invalid source", errors);
  const vars = { ...GLOBAL_VARS, ...templateVars };
  const v: Record<string, string> = {};
  for (const [name, spec] of Object.entries(vars)) {
    const raw = values[name];
    const s = raw === null || raw === undefined ? "" : String(raw);
    if (spec.required && !s) throw new TemplateRenderError(`missing value: ${name}`);
    if (spec.kind === "url" && s && !SAFE_URL.test(s))
      throw new TemplateRenderError(`unsafe link: ${name}`);
    v[name] = s;
  }
  const fill = (s: string, f: (x: string) => string) =>
    s.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_m, k: string) => f(v[k] ?? ""));
  return {
    subject: fill(source.subject, (x) => x.replace(/[\r\n]+/g, " ")).trim(),
    html: fill(source.html, escapeHtml),
    text: fill(source.text, (x) => x),
  };
}

/**
 * The scans behind unit/ui-guards.test.ts (the UI audit of 2026-11-10, docs/i18n.md):
 * hardcoded UI literals and raw error text in UI files, sentences instead of
 * codes in API error bodies, and the health of the user dictionaries. Each
 * returns counts per file (or a list of findings), which the test holds to a
 * checked-in baseline that may only shrink.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

/** Text with words in it (Latin, kana, CJK): a candidate UI string. */
const WORDS = /[A-Za-z\u3040-\u30ff\u4e00-\u9fff]{2,}/;
/** Names and tokens that read the same in every language. */
const ALLOWED = new Set([
  "Lianki",
  "LiCards",
  "Li",
  "Anki",
  "AnkiWeb",
  "YouTube",
  "Google",
  "GitHub",
  "OK",
  // Key-cap names and the text-size sample on a button: the same in every language.
  "Esc",
  "ESC",
  "Aa",
]);
const ATTRS = new Set(["aria-label", "placeholder", "title", "alt", "label"]);
const CALLS = new Set([
  "alert",
  "confirm",
  "prompt",
  "toast",
  "setError",
  "setMessage",
  "setWarning",
]);

const isLiteral = (
  n: ts.Node,
): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);

function words(text: string): boolean {
  // HTML entities (&rarr;, &middot;) are glyphs, not words.
  const t = text
    .replace(/\$\{[^}]*\}/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .trim();
  if (!WORDS.test(t)) return false;
  return !t
    .split(/\s+/)
    .every(
      (w) =>
        ALLOWED.has(w.replace(/[^\w]/g, "")) ||
        URL_LIKE.test(w) ||
        DOMAIN_LIKE.test(w) ||
        KEY_LIKE.test(w) ||
        !WORDS.test(w),
    );
}

/** An example web address (a placeholder like https://example.com/a.txt) reads the same in every language. */
const URL_LIKE = /^["'`]?https?:\/\/\S+$/;
/** A bare domain or its ending (example.com, .com): the same in every language. */
const DOMAIN_LIKE = /^["'`]?[\w-]*(\.[a-z]{2,})+["'`]?$/;
/**
 * A dictionary key or code passed around as a value (setError("wrongType"),
 * "yaml-failed"): camelCase or kebab-case, one token; the text is looked up.
 */
const KEY_LIKE = /^["'`]?[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*|-[a-z0-9]+)+["'`]?$/;

const RAW_ERROR = /\.message\b|String\((e|err|error)\)|statusText|\.digest\b/;

export type UiCounts = { literals: number; rawErrors: number };

/** Hardcoded UI text and raw error passthrough in one TS/TSX file. */
export function scanUiFile(path: string, src = readFileSync(path, "utf8")): UiCounts {
  const sf = ts.createSourceFile(
    path,
    src,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const counts: UiCounts = { literals: 0, rawErrors: 0 };
  const text = (n: ts.Node) => n.getText(sf);
  const inJsxChildren = (n: ts.Node) =>
    !!n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent));
  const inStyle = (n: ts.Node) =>
    !!n.parent &&
    ts.isJsxElement(n.parent) &&
    n.parent.openingElement.tagName.getText(sf) === "style";
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      if (words(n.getText(sf))) counts.literals++;
    } else if (ts.isJsxAttribute(n) && ATTRS.has(n.name.getText(sf)) && n.initializer) {
      const init = n.initializer;
      const lit = ts.isStringLiteral(init)
        ? init
        : ts.isJsxExpression(init) && init.expression && isLiteral(init.expression)
          ? init.expression
          : null;
      if (lit && words(text(lit))) counts.literals++;
    } else if (ts.isCallExpression(n)) {
      const name = text(n.expression).split(".").pop() ?? "";
      const arg = n.arguments[0];
      if (CALLS.has(name) && arg) {
        if (isLiteral(arg) && words(text(arg))) counts.literals++;
        else if (!ts.isStringLiteral(arg) && RAW_ERROR.test(text(arg))) counts.rawErrors++;
      }
    } else if (ts.isJsxExpression(n) && inStyle(n)) {
      // CSS inside a <style> element is not text.
    } else if (ts.isJsxExpression(n) && n.expression && inJsxChildren(n)) {
      const t = text(n.expression);
      if (isLiteral(n.expression) && words(t)) counts.literals++;
      else if (RAW_ERROR.test(t) && !/\bt\.|content\.|text\.|strings\./.test(t)) counts.rawErrors++;
    } else if (ts.isTemplateExpression(n) && text(n).startsWith("`HTTP ${")) {
      counts.rawErrors++;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return counts;
}

const scanGlob = (pattern: string) => [...new Glob(pattern).scanSync(".")].sort();

/** The UI files the guard holds: user pages and components, not /dev, /lab or the API. */
export function uiFiles(): string[] {
  const files = [
    ...scanGlob("app/**/*.tsx"),
    ...scanGlob("lib/**/islands/*.tsx"),
    ...scanGlob("packages/debug-chat/src/*.tsx"),
  ];
  return files.filter((f) => !/^app\/(\(app\)\/)?(dev|lab|api)\//.test(f) && !f.includes("/dev/"));
}

/** Error bodies in API routes that are not a kebab-case code. */
export function scanApiFile(path: string, src = readFileSync(path, "utf8")): number {
  let n = 0;
  for (const m of src.matchAll(/\berror:\s*("([^"\\]*)"|`[^`]*`|[\w.]*\.message\b|String\()/g)) {
    const body = m[1];
    if (body.startsWith('"') && /^[a-z0-9-]*$/.test(m[2] ?? "")) continue;
    n++;
  }
  return n;
}

export const apiFiles = () =>
  scanGlob("app/api/**/route.ts").filter((f) => !f.startsWith("app/api/dev/"));

/** Every dictionary file a user can see (not /dev or /lab pages, not mails' dev samples). */
export const userDictionaryFiles = () =>
  [...scanGlob("app/**/*.content.ts"), ...scanGlob("lib/**/*.content.ts")].filter(
    (f) => !/\/(dev|lab)\//.test(f),
  );

type Leaf = { translation: Record<string, string> };
const isLeaf = (v: unknown): v is Leaf =>
  !!v && typeof v === "object" && "translation" in v && typeof (v as Leaf).translation === "object";

/** Every translated leaf of a dictionary's content, as `group.key` → translations. */
export function leaves(content: unknown, prefix = ""): [string, Record<string, string>][] {
  if (isLeaf(content)) return [[prefix, content.translation]];
  if (!content || typeof content !== "object") return [];
  return Object.entries(content).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

/**
 * Words developers use that a learner should never read (BYOK/API-key wording is the feature, so allowed).
 * "Cloudflare Workers AI" is the named sub-processor in the privacy notes and the chat's AI disclosure,
 * a product name like any other, so only a bare "Workers AI" counts.
 */
export const JARGON =
  /\b(D1|(?<!Cloudflare )Workers? AI|eval|lane|codex|payload|IndexedDB|GM storage|HTTP \d{3}|stack trace|JSON)\b/;

/**
 * Dictionaries written for a developer or an AI assistant, where HTTP, JSON and
 * headers are the subject: agent-guide is the prompt a user copies into their
 * own AI app (lib/agent-guide.ts), read by the assistant, not by the learner.
 */
export const JARGON_EXEMPT = new Set(["agent-guide"]);

/**
 * Sharing the host page from the pill's Li frame (docs/userscript-li-chat.md,
 * M3, security gate 5 and 6). The frame (lianki.com, cross-origin) cannot see
 * the page; its composer's "Share selection" / "Share page title and link"
 * asks the userscript's shell over the MessagePort, and the shell reads the
 * page **only then** (frame-protocol.ts "need-share" → "share").
 *
 * What comes back is page-provided, so it is treated as text everywhere:
 * - the link is http(s) only, origin + path: never the query or the fragment
 *   (they can hold tokens), characters that could close a markdown link
 *   percent-encoded;
 * - the title is escaped for markdown before it goes into the draft, so it
 *   renders literally (never a link, an image or HTML);
 * - the selection goes into the line's attachment (ChatContext), which the
 *   chat renders as plain text.
 *
 * Nothing here sends: a share fills the draft or the attachment chip, and the
 * line goes only when the user presses send.
 */
import { type ChatContext, MAX_CONTEXT_TITLE, MAX_SELECTION, cleanContext } from "../wire";

export type ShareWhat = "selection" | "page";

/** What the shell read from the page for one share (already bounded and cleaned). */
export type SharedPage = {
  what: ShareWhat;
  title: string;
  /** http(s) origin + path only. */
  url: string;
  /** Only for "selection": the selected text, never empty. */
  selection?: string;
};

/** Longest link a share carries (an origin plus a path). */
export const MAX_SHARE_URL = 600;

export const isShareWhat = (v: unknown): v is ShareWhat => v === "selection" || v === "page";

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** A one-line title: control characters out, whitespace collapsed, bounded. */
function cleanTitle(v: unknown): string {
  return typeof v === "string"
    ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_CONTEXT_TITLE)
    : "";
}

/** A selection: control characters (but tabs and newlines) out, trimmed, bounded. */
function cleanSelection(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(CONTROL, "").trim().slice(0, max).trim() : "";
}

/**
 * The page's link as it may be shared: http(s) only, origin + path, no
 * userinfo, no query, no fragment; `()<>[]"'` ` and whitespace
 * percent-encoded so it can never close a markdown link. Null otherwise.
 */
export function shareUrl(href: unknown): string | null {
  if (typeof href !== "string" || href.length > 8192) return null;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const path = u.pathname.replace(
    /[()<>[\]"'`\s\\]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  const out = `${u.protocol}//${u.host}${path}`;
  return out.length <= MAX_SHARE_URL ? out : null;
}

/**
 * The shell's read of the page for one share (src/pill-chat.ts): null when
 * there is nothing to share (no http(s) link; no selection for "selection").
 */
export function readShare(
  what: ShareWhat,
  page: { href: unknown; title: unknown; selection?: unknown },
  maxSelection = MAX_SELECTION,
): SharedPage | null {
  const url = shareUrl(page.href);
  if (!url) return null;
  const title = cleanTitle(page.title);
  if (what === "page") return { what, title, url };
  const selection = cleanSelection(page.selection, Math.min(maxSelection, MAX_SELECTION));
  return selection ? { what, title, url, selection } : null;
}

/** The frame's check of the shell's answer: the same rules again, nothing trusted. */
export function cleanShare(raw: unknown, what: ShareWhat): SharedPage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.what !== what) return null;
  return readShare(what, { href: r.url, title: r.title, selection: r.selection });
}

/**
 * Markdown's active characters, backslash-escaped, so the text renders as it
 * reads: links and images (`[`, `]`, `!`), HTML (`<`, `>`), emphasis and
 * code, tables, and a block marker at the start (heading, list, quote).
 */
export function escapeMarkdown(s: string): string {
  return s
    .replace(/[\\`*_[\]<>!|~]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([#+=-])/, "$1\\$2")
    .replace(/^(\s*\d+)([.)])/, "$1\\$2");
}

/**
 * The draft after "Share page title and link": the escaped title and the link
 * on their own line after what he typed. Not sent: he reads it, edits it,
 * and presses send.
 */
export function shareToDraft(draft: string, p: SharedPage, maxChars = Infinity): string {
  const block = p.title ? `${escapeMarkdown(p.title)}\n${p.url}` : p.url;
  const head = draft.replace(/\s+$/, "");
  return `${head ? `${head}\n` : ""}${block}`.slice(0, maxChars);
}

/**
 * The attachment after "Share selection": the text, the page's title, path
 * and host (ChatContext, rendered as plain text), cut to `maxChars`
 * (config chat.pillShareChars). Undefined when nothing is left.
 */
export function shareToContext(p: SharedPage, maxChars = MAX_SELECTION): ChatContext | undefined {
  if (p.what !== "selection" || !p.selection) return undefined;
  const u = new URL(p.url);
  return cleanContext({
    selection: p.selection.slice(0, Math.max(1, Math.min(maxChars, MAX_SELECTION))),
    title: p.title,
    path: decodeSafe(u.pathname),
    host: u.host,
  });
}

function decodeSafe(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

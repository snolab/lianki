/**
 * Links in the chat's text (owner, 2026-11-06 00:05 JST: "lichat/liagent
 * should recognize links and allow me to click them"): where the URLs are in
 * a string, and which URLs may be followed. Pure, no DOM and no HTML: the
 * renderer (RichText.tsx) builds an <a> from each piece, its text the URL as
 * written, so nothing in a message can become markup.
 *
 * Only http(s). https:// and http:// anywhere, plus a bare lianki.com/… path.
 * Scripts written without spaces between words end a URL, so Chinese touching
 * one is not swallowed; the cost is that a raw `…/wiki/云` links up to the
 * slash (a percent-encoded one works whole). Other scripts stay in a path, not
 * in a host: `https://lіanki.com` with a Cyrillic і is left as text, never a
 * link that reads as ours.
 */

export const LIANKI_ORIGIN = "https://lianki.com";
const LIANKI_HOSTS = new Set(["lianki.com", "www.lianki.com"]);

/** Past this a press on a link was a drag (a selection), not a tap. */
export const LINK_DRAG_PX = 10;

/** Written without spaces between words, with their punctuation and fullwidth forms. */
const UNSPACED =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}\\u3000-\\u303f\\u30a0-\\u30ff\\uff00-\\uffef";
const URL_CHAR = `(?:(?![${UNSPACED}])[\\p{L}\\p{M}\\p{N}\\-._~:/?#\\[\\]@!$&'()*+,;=%])`;
const LINK_SOURCE = `https?://${URL_CHAR}+|(?:www\\.)?lianki\\.com/${URL_CHAR}*`;

/** Before a scheme, these make it part of a longer word (xhttps://). */
const BEFORE_SCHEME = /[A-Za-z0-9+.-]/;
/** Before a bare path, these make it another host or part of a URL or an address. */
const BEFORE_BARE = /[A-Za-z0-9@._/:-]/;

/** What ends the sentence around a URL rather than the URL. */
const TRAILING = new Set([..."., ;:!?'*_~(["]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[" };

const countOf = (s: string, c: string) => s.split(c).length - 1;

/** The URL without what ends the sentence around it; a closer it opened itself stays. */
function trimEnd(raw: string): string {
  let s = raw;
  for (;;) {
    const c = s.at(-1);
    if (c === undefined) return s;
    const open = CLOSERS[c];
    if (open ? countOf(s, c) > countOf(s, open) : TRAILING.has(c)) s = s.slice(0, -1);
    else return s;
  }
}

/** The URL's normal form if it is an http(s) one with a host, else null. */
export function httpHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

/** A match's text and where it goes, or null when it is not a link after all. */
function cleanMatch(raw: string): { text: string; href: string } | null {
  const text = trimEnd(raw);
  const scheme = /^https?:\/\//i.test(text);
  const href = httpHref(scheme ? text : `https://${text}`);
  if (!href) return null;
  const authority = text.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0]!;
  // An ASCII host only: see the top of this file.
  if (/[^ -~]/.test(authority)) return null;
  return { text, href };
}

/** The text in order: plain pieces, and links with their `href`. Joined, it is the text. */
export type LinkSegment = { text: string; href?: string };

export function parseLinks(text: string): LinkSegment[] {
  const out: LinkSegment[] = [];
  const re = new RegExp(LINK_SOURCE, "giu");
  let done = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const prev = text[m.index - 1] ?? "";
    const before = /^h/i.test(m[0]) ? BEFORE_SCHEME : BEFORE_BARE;
    const link = before.test(prev) ? null : cleanMatch(m[0]);
    if (!link) {
      re.lastIndex = m.index + 1;
      continue;
    }
    if (m.index > done) out.push({ text: text.slice(done, m.index) });
    out.push(link);
    done = m.index + link.text.length;
    re.lastIndex = done;
  }
  if (done < text.length) out.push({ text: text.slice(done) });
  return out;
}

/** The URL at the very start of `src`, as written: the markdown parser's bare-URL rule. */
export function linkAtStart(src: string): string | null {
  const m = new RegExp(LINK_SOURCE, "iuy").exec(src);
  return m ? (cleanMatch(m[0])?.text ?? null) : null;
}

/**
 * Where a link in markdown or HTML may go: http(s), or a path on lianki.com
 * (resolved there, so `//evil.example` and `/\evil.example` are seen for what
 * they are). Tabs, newlines and entities hiding a scheme are the URL parser's
 * to see through. Null for anything else: the text stays, the link does not.
 */
export function safeHref(raw: string): string | null {
  const t = raw.trim();
  if (!t.startsWith("/")) return httpHref(t);
  try {
    const u = new URL(t, LIANKI_ORIGIN);
    return u.origin === LIANKI_ORIGIN ? u.href : null;
  } catch {
    return null;
  }
}

/** The image origins the HTML tier may load from. */
export const IMAGE_ORIGINS: readonly string[] = [LIANKI_ORIGIN];

/** An image source from an allowed origin, else null. Only https, or a lianki.com path. */
export function safeImageSrc(raw: string, origins = IMAGE_ORIGINS): string | null {
  const href = safeHref(raw);
  if (!href) return null;
  const u = new URL(href);
  return u.protocol === "https:" && origins.includes(u.origin) ? href : null;
}

export const isLianki = (href: string) => LIANKI_HOSTS.has(new URL(href).hostname);

/** Stays in this tab: a lianki.com link while on lianki.com. Anything else gets a new one. */
export const sameTab = (href: string, hereHost: string | undefined) =>
  !!hereHost && LIANKI_HOSTS.has(hereHost) && isLianki(href);

/**
 * What a click on a link does: "drag" (the press moved: it selected text, so
 * no navigation), "app" (the host's client-side navigation, to `path`), or
 * "native" (the anchor's own, a modifier key included).
 */
export function linkClick(c: {
  href: string;
  hereHost: string | undefined;
  movedPx: number;
  modified: boolean;
  hasRouter: boolean;
}): { to: "drag" | "native" } | { to: "app"; path: string } {
  if (c.movedPx > LINK_DRAG_PX) return { to: "drag" };
  if (c.modified || !c.hasRouter || !sameTab(c.href, c.hereHost)) return { to: "native" };
  const u = new URL(c.href);
  return { to: "app", path: `${u.pathname}${u.search}${u.hash}` };
}

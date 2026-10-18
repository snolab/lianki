import { normalizeUrl } from "./normalizeUrl";

/**
 * Pull links out of pasted text — a markdown list, a chat log, an email, a bare
 * list of urls, or any mix.
 *
 * Line-based filtering is not enough. `/learn` kept only lines *starting* with
 * `http`, so a markdown list (`- https://…`) imported nothing. And the raw
 * endpoint is worse: `normalizeUrl` passes through anything it cannot parse, so
 * `[title](https://…)` posted directly became a card whose url is literally that
 * string — undeletable from the page, unreachable by the userscript. This does
 * the extraction properly and validates every result with `new URL()`.
 *
 * The output is deduped through `normalizeUrl`, the same identity the server
 * uses, so "3 links found" means three cards.
 */

export type ExtractedLink = { url: string; title?: string };

/**
 * A url runs until whitespace or a delimiter that cannot be part of it: `<>`
 * around autolinks, quotes, and the markdown link's own closing `)`. Trailing
 * sentence punctuation is trimmed afterwards, because `https://a.com/x.` is a
 * sentence ending in a url far more often than a url ending in a dot.
 */
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const MD_LINK_RE = /\[([^\]\n]*)\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g;
const TRAILING_PUNCT = /[.,;:!?'"]+$/;

/**
 * Strip trailing punctuation, then trailing `)` — but only unbalanced ones.
 * `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its `)`; `(see https://a.com)`
 * loses it.
 */
function trimUrlTail(raw: string): string {
  let url = raw.replace(TRAILING_PUNCT, "");
  while (url.endsWith(")")) {
    const opens = (url.match(/\(/g) ?? []).length;
    const closes = (url.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    url = url.slice(0, -1).replace(TRAILING_PUNCT, "");
  }
  return url;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && Boolean(u.hostname);
  } catch {
    return false;
  }
}

export function extractLinks(text: string): ExtractedLink[] {
  const byKey = new Map<string, ExtractedLink>();
  const add = (url: string, title?: string) => {
    if (!isHttpUrl(url)) return;
    const key = normalizeUrl(url);
    const existing = byKey.get(key);
    // First occurrence wins for the url; a title fills in if we had none.
    if (!existing) byKey.set(key, title ? { url, title } : { url });
    else if (title && !existing.title) existing.title = title;
  };

  // Markdown links first, so their titles are captured and their urls are
  // consumed — otherwise the bare-url pass sees `https://…)` inside them.
  const remainder = text.replace(MD_LINK_RE, (_m, title: string, url: string) => {
    const t = title.trim();
    add(trimUrlTail(url), t && t !== url ? t : undefined);
    return " ";
  });

  for (const m of remainder.match(URL_RE) ?? []) add(trimUrlTail(m));

  return [...byKey.values()];
}

/**
 * Pages that moved to a new address (docs/url-principles.md). The old address
 * keeps working forever: middleware.ts answers it with a permanent redirect
 * (308) to the new one, subpath and query kept. Add a row when a page moves;
 * never remove one.
 */
export const MOVED_ROUTES: readonly (readonly [from: string, to: string])[] = [
  // 2026-11-09: experiments live under /lab (owner).
  ["/ai-vocab", "/lab/ai-vocab"],
  ["/polyglot", "/lab/polyglot"],
  // 2026-11-09: the reader is a noun (owner, 01:17 JST). /api/read keeps its name.
  ["/read", "/reader"],
];

/**
 * The new path for a moved one — `/ai-vocab/ja` → `/lab/ai-vocab/ja` — or null.
 * Only whole segments match: `/ai-vocabulary` is not `/ai-vocab`.
 */
export function movedPath(pathname: string): string | null {
  for (const [from, to] of MOVED_ROUTES) {
    if (pathname === from || pathname === `${from}/`) return to;
    if (pathname.startsWith(`${from}/`)) return to + pathname.slice(from.length);
  }
  return null;
}

/**
 * An app href with a moved path brought to its new address, query and hash
 * kept — `/read/abc?review=p1#p=4` → `/reader/abc?review=p1#p=4` — else as it
 * was. For hrefs kept on the device or the account (pinned and recent pages).
 */
export function movedHref(href: string): string {
  const cut = href.search(/[?#]/);
  const path = cut < 0 ? href : href.slice(0, cut);
  const moved = movedPath(path);
  return moved ? moved + (cut < 0 ? "" : href.slice(cut)) : href;
}

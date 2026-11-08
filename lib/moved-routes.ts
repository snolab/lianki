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

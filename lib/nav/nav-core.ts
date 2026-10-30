/**
 * The bottom island's pure rules (docs/bottom-nav.md): search ranking, when
 * it shrinks or hides, where it docks next to the chat bar. No DOM, no React.
 */

/** `{n}` / `{url}` in a localized string. */
export const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

export type PaletteKind = "go" | "create" | "list" | "word" | "card" | "tree" | "url";

export type PaletteItem = {
  id: string;
  kind: PaletteKind;
  title: string;
  /** A second line: a word's meaning, a card's URL, a node's path. */
  sub?: string;
  /** Where it goes: an app path, or an absolute URL for a card. */
  href: string;
  /** Extra words that match but are not shown (a nav key, a language). */
  keys?: string;
};

const norm = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** How well `q` matches `text`: 0 is no match; prefix > word start > substring > subsequence. */
export function score(text: string, q: string): number {
  const t = norm(text);
  const n = norm(q.trim());
  if (!n) return 1;
  if (t === n) return 100;
  if (t.startsWith(n)) return 80;
  const i = t.indexOf(n);
  if (i > 0) return /[\s\-_/.›(]/.test(t[i - 1]) ? 60 : 40;
  // Every character in order (ignoring spaces): "wdl" finds "word list".
  let at = 0;
  for (const ch of n.replace(/\s+/g, "")) {
    at = t.indexOf(ch, at);
    if (at < 0) return 0;
    at++;
  }
  return 10;
}

/** The best `limit` items for `q`, best first; ties keep their order. */
export function rank(items: readonly PaletteItem[], q: string, limit = 30): PaletteItem[] {
  return items
    .map((it, i) => ({
      it,
      i,
      s: Math.max(
        score(it.title, q),
        it.sub ? score(it.sub, q) * 0.6 : 0,
        it.keys ? score(it.keys, q) * 0.8 : 0,
      ),
    }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.it);
}

/** A URL someone typed or pasted: http(s), or a bare domain with a dot. */
export function asUrl(q: string): string | null {
  const s = q.trim();
  if (!s || /\s/.test(s)) return null;
  const withScheme = /^https?:\/\//i.test(s)
    ? s
    : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)
      ? `https://${s}`
      : null;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    return u.hostname.includes(".") ? u.href : null;
  } catch {
    return null;
  }
}

/** The first URL in shared text (a share sheet often puts it in `text`). */
export function firstUrl(...parts: (string | null | undefined)[]): string | null {
  for (const p of parts) {
    const m = p?.match(/https?:\/\/[^\s<>"']+/i);
    if (m) return m[0];
  }
  return null;
}

/**
 * Compact (the small capsule) or full, after a scroll by `dy` px. Down past
 * `threshold` shrinks it, any move up brings it back; small jitters keep it.
 */
export function nextCompact(compact: boolean, dy: number, threshold = 12): boolean {
  if (dy > threshold) return true;
  if (dy < -4) return false;
  return compact;
}

/**
 * The on-screen keyboard is up. iOS shrinks only the visual viewport; Android
 * Chrome shrinks the layout viewport too, so the tallest height seen since the
 * last rotation (`tallest`) is the reference.
 */
export function keyboardUp(o: { vvHeight: number; tallest: number; editable: boolean }): boolean {
  if (!o.editable) return false;
  return o.vvHeight < o.tallest - 120;
}

export type Box = { left: number; right: number; top: number; bottom: number };

/**
 * How far above the viewport's bottom edge the island must sit (px) so it
 * clears the chat bar, or 0 when the bar is elsewhere (the other side, or
 * already above the island's resting place).
 */
export function dockAbove(island: Box, bar: Box | null, vh: number, gap = 8): number {
  if (!bar) return 0;
  const overlapX = bar.left < island.right && bar.right > island.left;
  const overlapY = bar.top < island.bottom && bar.bottom > island.top;
  if (!overlapX || !overlapY) return 0;
  return Math.max(0, Math.round(vh - bar.top + gap));
}

/** The due reviews over the cached word lists, groups left out (their lists count). */
export function dueTotal(
  lists: readonly { due?: number; source?: string | null }[] | undefined,
): number {
  if (!lists) return 0;
  return lists.reduce(
    (n, l) => n + (l.source?.startsWith("group:") ? 0 : Math.max(0, Number(l.due) || 0)),
    0,
  );
}

/** Words seen at least once over the cached lists (0: nothing graded yet). */
export function seenTotal(lists: readonly { cards?: number }[]): number {
  return lists.reduce((n, l) => n + Math.max(0, Number(l.cards) || 0), 0);
}

/**
 * The first-visit tip (the /words hint, above the island): only while the
 * learner has graded nothing, there is a hint to show, and it was not dismissed.
 */
export const showFirstTip = (o: { seen: number | null; hint: string | null; dismissed: boolean }) =>
  !o.dismissed && o.seen === 0 && !!o.hint?.trim();

/** A due count for a badge: "99+" past 99, nothing at 0. */
export const badge = (n: number) => (n <= 0 ? "" : n > 99 ? "99+" : String(n));

type TreeLike = { title: string; children: TreeLike[]; done?: boolean };

/** Every open node of the state tree, with its path of titles, for search. */
export function treeItems(nodes: readonly TreeLike[], href: string, max = 300): PaletteItem[] {
  const out: PaletteItem[] = [];
  const walk = (ns: readonly TreeLike[], path: string[]) => {
    for (const n of ns) {
      if (out.length >= max) return;
      const title = n.title.replace(/\s+@\S+$/, "").trim();
      if (!n.done && title)
        out.push({
          id: `tree:${[...path, title].join("/")}`,
          kind: "tree",
          title,
          sub: path.join(" › ") || undefined,
          href,
        });
      walk(n.children, [...path, title]);
    }
  };
  walk(nodes, []);
  return out;
}

/** Start-edge swipe that opens the drawer: from within `edge` px, `min` px across, mostly sideways. */
export function edgeSwipe(
  start: { x: number; y: number },
  now: { x: number; y: number },
  o: { width: number; rtl: boolean; edge?: number; min?: number },
): "open" | "no" | "wait" {
  const edge = o.edge ?? 24;
  const fromEdge = o.rtl ? o.width - start.x : start.x;
  if (fromEdge > edge) return "no";
  const dx = o.rtl ? start.x - now.x : now.x - start.x;
  const dy = Math.abs(now.y - start.y);
  if (dy > 30 && dy > dx) return "no";
  return dx >= (o.min ?? 48) ? "open" : "wait";
}

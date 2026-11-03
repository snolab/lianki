// Where he is in a book (docs/books-plan.md, "Position"): an anchor — the
// line at the reading line and how far into it — never pixels, so it holds
// across text sizes and devices. The synced anchor is the backend's
// (lib/read/reader-api.ts); this device keeps a copy as a cache, so a book
// opens where it was even offline or before the server answers.

export interface Anchor {
  /** The line (paragraph or heading) at the reading line. */
  line: number;
  /**
   * The block's first sentence in that line: a long paragraph split into
   * items has one block per piece (absent: 0, the paragraph's first).
   */
  s?: number;
  /** How far down that block the reading line is, 0..1. */
  off: number;
  /** When it was taken (ms since the epoch); the newest anchor wins. */
  at: number;
}

const KEY = (id: string) => `lk:read-anchor:${id}`;
/** The first reader's key: the line only (ReadViewClient). */
const OLD_KEY = (id: string) => `lk:read-pos:${id}`;

type Store = Pick<Storage, "getItem" | "setItem">;
const store = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function parseAnchor(raw: unknown): Anchor | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Partial<Anchor>;
  if (!Number.isInteger(a.line) || (a.line as number) < 0) return null;
  const off = typeof a.off === "number" && a.off >= 0 && a.off <= 1 ? a.off : 0;
  const at = typeof a.at === "number" && Number.isFinite(a.at) ? a.at : 0;
  const s = Number.isInteger(a.s) && (a.s as number) > 0 ? (a.s as number) : undefined;
  return { line: a.line as number, ...(s ? { s } : {}), off, at };
}

export function loadAnchor(id: string, s: Store | null = store()): Anchor | null {
  try {
    const raw = s?.getItem(KEY(id));
    if (raw) return parseAnchor(JSON.parse(raw));
    const n = Number(s?.getItem(OLD_KEY(id)));
    return Number.isInteger(n) && n > 0 ? { line: n, off: 0, at: 0 } : null;
  } catch {
    return null;
  }
}

export function saveAnchor(id: string, a: Anchor, s: Store | null = store()) {
  try {
    s?.setItem(KEY(id), JSON.stringify(a));
    // The first reader opens there too.
    s?.setItem(OLD_KEY(id), String(a.line));
  } catch {
    // private mode or storage full: the cache is a convenience
  }
}

/** The newer of two anchors (the synced one and this device's). */
export function newestAnchor(a: Anchor | null, b: Anchor | null): Anchor | null {
  if (!a) return b;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

/**
 * The anchor at the reading line `eye` (px from the viewport top), from the
 * rendered blocks' rects, in order: the block that spans it, else the first
 * below it.
 */
export function anchorAt(
  rects: readonly { line: number; s?: number; top: number; height: number }[],
  eye: number,
  now = Date.now(),
): Anchor | null {
  for (const r of rects) {
    if (r.top + r.height <= eye) continue;
    const off = r.height > 0 ? Math.min(1, Math.max(0, (eye - r.top) / r.height)) : 0;
    return { line: r.line, ...(r.s ? { s: r.s } : {}), off, at: now };
  }
  return null;
}

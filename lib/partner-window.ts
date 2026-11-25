/**
 * Li's frozen history window (docs/partner-ai.md, "Prompt caching"): the
 * history Li reads is append-only between checkpoints, so every call repeats
 * the previous call's prompt byte for byte and Workers AI's prefix cache hits.
 *
 * - A line enters the window once, rendered as it read then, and never
 *   changes there.
 * - A line whose text changed later (a polish, a merge) is not re-rendered:
 *   an edit entry is appended after the lines already in the window.
 * - Over the bound (`maxLines` entries or `maxChars` characters, Li's
 *   HISTORY_LINES / HISTORY_MAX_CHARS), a checkpoint starts a new window from
 *   the newest lines within `keepPct` percent of the bound. That is one cache
 *   miss, then stable again.
 *
 * Pure: the hub keeps the window in its storage (`ai:win:<thread>`).
 */
export type WindowLine = { id: string; role: "user" | "assistant"; text: string };
export type WindowItem = { role: "user" | "assistant"; text: string };
export type PartnerWindow = {
  v: 1;
  items: WindowItem[];
  /** The text each line had when the window last took it in, by line id. */
  seen: Record<string, string>;
  /** Lines older than the last checkpoint: never taken in again (at most one bound's worth). */
  before?: string[];
};
export type WindowBounds = { maxLines: number; maxChars: number; keepPct: number };

/** An edit entry: the line as first sent stays above; this says what it reads now. */
export function editEntry(before: string, after: string): string {
  const head = before.length > 60 ? `${before.slice(0, 60)}…` : before;
  return `(correction: the earlier line "${head}" now reads: ${after})`;
}

const size = (items: readonly WindowItem[]) => items.reduce((n, h) => n + h.text.length, 0);

/** A fresh window: the newest lines within keepPct of the bound (always the newest one). */
function checkpoint(lines: readonly WindowLine[], b: WindowBounds): PartnerWindow {
  const keepLines = Math.max(1, Math.floor((b.maxLines * b.keepPct) / 100));
  const keepChars = Math.max(1, Math.floor((b.maxChars * b.keepPct) / 100));
  const kept: WindowLine[] = [];
  let chars = 0;
  for (const l of lines.toReversed()) {
    if (kept.length >= keepLines) break;
    if (kept.length && chars + l.text.length > keepChars) break;
    kept.unshift(l);
    chars += l.text.length;
  }
  const keptIds = new Set(kept.map((l) => l.id));
  return {
    v: 1,
    items: kept.map(({ role, text }) => ({ role, text })),
    seen: Object.fromEntries(kept.map((l) => [l.id, l.text])),
    before: lines.filter((l) => !keptIds.has(l.id)).map((l) => l.id),
  };
}

/** A stored window, if it is one (anything else starts afresh). */
export function parseWindow(raw: unknown): PartnerWindow | undefined {
  const w = raw as Partial<PartnerWindow> | undefined;
  if (!w || w.v !== 1 || !Array.isArray(w.items) || !w.seen || typeof w.seen !== "object")
    return undefined;
  return w as PartnerWindow;
}

/**
 * The window after these lines (the thread's latest, oldest first). Edits to
 * lines already in the window come first, then lines new to it, so the
 * newest line stays last.
 */
export function advanceWindow(
  prev: PartnerWindow | undefined,
  lines: readonly WindowLine[],
  b: WindowBounds,
): PartnerWindow {
  if (!prev) return checkpoint(lines, b);
  const items = [...prev.items];
  const seen = { ...prev.seen };
  for (const l of lines) {
    const was = seen[l.id];
    if (was !== undefined && was !== l.text) {
      items.push({ role: "user", text: editEntry(was, l.text) });
      seen[l.id] = l.text;
    }
  }
  const before = new Set(prev.before ?? []);
  for (const l of lines) {
    if (seen[l.id] !== undefined || before.has(l.id)) continue;
    items.push({ role: l.role, text: l.text });
    seen[l.id] = l.text;
  }
  if (items.length > b.maxLines || size(items) > b.maxChars) return checkpoint(lines, b);
  return { v: 1, items, seen, ...(prev.before?.length ? { before: prev.before } : {}) };
}

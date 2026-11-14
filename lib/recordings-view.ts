/**
 * /my/recordings' rows (docs/recordings.md, "The page"; owner, 2026-11-15):
 * ONE continuous feed of clips, paged by time on the server (never by day),
 * grouped here into dates in the device's own time zone — never JST, never a
 * fixed zone. Each date reads as a journal (lib/recordings-article.ts): its
 * clips in recording order, a heading above. One flat list for the one
 * VirtualList (no pages, owner 2026-11-10). Pure, so it is unit-tested.
 */
import { type Paragraph, paragraphs } from "@/lib/recordings-article";

export type ClipView = {
  id: string;
  /** The server's internal day (the UTC date for new rows); the page never groups by it. */
  day: string;
  at: number;
  durationMs: number;
  mode: "active" | "passive";
  source: "local" | "cloud" | "none";
  speaker: "me" | "other" | "unknown" | null;
  /** The recorder's device label (`iphone`, `mac`…), as the API sends it. */
  device?: string | null;
  text: string | null;
};
/** `day` below is the group: a YYYY-MM-DD date in the viewer's zone. */
export type Row =
  | { kind: "date"; key: string; day: string }
  | { kind: "clip"; key: string; day: string; c: ClipView; p: Paragraph };

/** The zone the device is in (Intl), or UTC when it names none. */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();
function dateFormat(timeZone: string): Intl.DateTimeFormat {
  let f = formats.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      // A zone this engine does not know: UTC, the one fixed zone.
      f = dateFormat("UTC");
    }
    formats.set(timeZone, f);
  }
  return f;
}

/** The calendar date of a time in a zone, YYYY-MM-DD. */
export function zoneDay(at: number, timeZone: string): string {
  const p = Object.fromEntries(
    dateFormat(timeZone)
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

export type Journal = {
  rows: Row[];
  /** Each shown date's paragraphs, in recording order (the player's timeline). */
  groups: Map<string, Paragraph[]>;
  /** The oldest date loaded, held back while more may still belong to it; else null. */
  held: string | null;
};

/**
 * The feed as dates newest first, each followed by its clips oldest first.
 * While `more` is true the oldest date loaded is held back: its earlier clips
 * may be on the next page, and a date opens only once it is whole (so its
 * heading and its first lines never shift above the reader).
 */
export function journal(
  clips: readonly ClipView[],
  o: { timeZone: string; gapMs: number; more: boolean },
): Journal {
  const byDay = new Map<string, ClipView[]>();
  for (const c of clips) {
    const d = zoneDay(c.at, o.timeZone);
    const list = byDay.get(d);
    if (list) list.push(c);
    else byDay.set(d, [c]);
  }
  const days = [...byDay.keys()].sort().reverse();
  const held = o.more && days.length ? days[days.length - 1] : null;
  const rows: Row[] = [];
  const groups = new Map<string, Paragraph[]>();
  for (const day of days) {
    if (day === held) continue;
    const ps = paragraphs(byDay.get(day)!, o.gapMs);
    groups.set(day, ps);
    rows.push({ kind: "date", key: `d:${day}`, day });
    for (const p of ps) rows.push({ kind: "clip", key: `c:${p.c.id}`, day, c: p.c, p });
  }
  return { rows, groups, held };
}

/** Clips from a new page added to those loaded: no id twice, newest first. */
export function mergeClips(current: readonly ClipView[], page: readonly ClipView[]): ClipView[] {
  const seen = new Set(current.map((c) => c.id));
  const out = [...current, ...page.filter((c) => !seen.has(c.id) && seen.add(c.id))];
  return out.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** The next page's cursor: the oldest loaded clip's time, or none for the first page. */
export const cursor = (clips: readonly ClipView[]): number | undefined =>
  clips.length ? Math.min(...clips.map((c) => c.at)) : undefined;

/**
 * Whether to fetch the next page at once, without waiting for the reader to
 * near the end: when this page only added to the held-back date, nothing new
 * opened, so the list would not grow and would never ask again by itself.
 */
export function keepLoading(
  before: readonly ClipView[],
  page: readonly ClipView[],
  more: boolean,
  timeZone: string,
): boolean {
  if (!more || !page.length) return false;
  const days = new Set(page.map((c) => zoneDay(c.at, timeZone)));
  if (days.size > 1) return false;
  const oldest = cursor(before);
  return oldest === undefined || days.has(zoneDay(oldest, timeZone));
}

/** The feed without one clip (a repeated delete changes nothing). */
export const withoutClip = (clips: readonly ClipView[], id: string): ClipView[] =>
  clips.filter((c) => c.id !== id);

/** A duration as h:mm:ss or m:ss. */
export function clock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Failed requests reject so callers keep existing data and offer a retry. */
export async function requestRecordings<T>(
  fetcher: typeof fetch,
  query: string,
  method = "GET",
): Promise<T> {
  const response = await fetcher(`/api/my/recordings${query}`, { method, cache: "no-store" });
  if (!response.ok) throw new Error(`recordings: ${response.status}`);
  return response.json() as Promise<T>;
}

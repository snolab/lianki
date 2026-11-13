/**
 * /my/recordings' rows (docs/recordings.md): the days, newest first, each
 * followed by its clips when it is open — one flat list for the one
 * VirtualList (no pages, owner 2026-11-10). Pure, so it is unit-tested.
 */
export type DaySummary = { day: string; clips: number; ms: number; bytes: number };
export type ClipView = {
  id: string;
  day: string;
  at: number;
  durationMs: number;
  mode: "active" | "passive";
  source: "local" | "cloud" | "none";
  speaker: "me" | "other" | "unknown" | null;
  text: string | null;
};
export type Row =
  | { kind: "day"; key: string; s: DaySummary; open: boolean }
  | { kind: "loading"; key: string; day: string }
  | { kind: "clip"; key: string; c: ClipView };

/** The rows for these days, with the open ones' clips (or a loading row until they come). */
export function recordingRows(
  days: readonly DaySummary[],
  open: ReadonlySet<string>,
  clips: ReadonlyMap<string, readonly ClipView[]>,
): Row[] {
  const out: Row[] = [];
  for (const s of days) {
    const isOpen = open.has(s.day);
    out.push({ kind: "day", key: `d:${s.day}`, s, open: isOpen });
    if (!isOpen) continue;
    const cs = clips.get(s.day);
    if (!cs) out.push({ kind: "loading", key: `l:${s.day}`, day: s.day });
    else for (const c of cs) out.push({ kind: "clip", key: `c:${c.id}`, c });
  }
  return out;
}

/** A duration as h:mm:ss or m:ss. */
export function clock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The days after one is deleted, and a day's summary after one of its clips is. */
export function withoutClip(
  days: readonly DaySummary[],
  clips: ReadonlyMap<string, readonly ClipView[]>,
  c: Pick<ClipView, "id" | "day" | "durationMs">,
): { days: DaySummary[]; clips: Map<string, ClipView[]> } {
  const next = new Map<string, ClipView[]>();
  for (const [d, cs] of clips) next.set(d, d === c.day ? cs.filter((x) => x.id !== c.id) : [...cs]);
  const out: DaySummary[] = [];
  for (const s of days) {
    if (s.day !== c.day) out.push(s);
    else if (s.clips > 1)
      out.push({ ...s, clips: s.clips - 1, ms: Math.max(0, s.ms - c.durationMs) });
  }
  if (!out.some((s) => s.day === c.day)) next.delete(c.day);
  return { days: out, clips: next };
}

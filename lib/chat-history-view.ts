/**
 * /chat/history's pure helpers (docs/chat-history.md): grouping lines by the
 * reader's own day, that day's bounds for a day's delete, and the text shown.
 */
import { isoDay } from "./dates";

/** Lines grouped by the reader's local day, in the order given (newest first). */
export function byDay<L extends { at: number }>(lines: L[]): { day: string; lines: L[] }[] {
  const out: { day: string; lines: L[] }[] = [];
  for (const l of lines) {
    const day = isoDay(l.at);
    const last = out.at(-1);
    if (last?.day === day) last.lines.push(l);
    else out.push({ day, lines: [l] });
  }
  return out;
}

/** One row of the virtual list: a day's heading (with its line count), or a line. */
export type DayRow<L> =
  | { kind: "day"; key: string; day: string; first: L; n: number }
  | { kind: "line"; key: string; line: L };

/**
 * The lines as list rows, each day led by its heading row: the history is one
 * virtual list (app/components/VirtualList.tsx). `keyOf` gives a line's id.
 */
export function dayRows<L extends { at: number }>(
  lines: L[],
  keyOf: (l: L) => string,
): DayRow<L>[] {
  return byDay(lines).flatMap(({ day, lines: ls }) => [
    { kind: "day" as const, key: `day:${day}`, day, first: ls[0]!, n: ls.length },
    ...ls.map((line) => ({ kind: "line" as const, key: `line:${keyOf(line)}`, line })),
  ]);
}

/** A local day ("2026-11-07") as [its first ms, the next day's first ms), on this clock. */
export function dayRange(day: string): { from: number; to: number } {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return { from: new Date(y, m - 1, d).getTime(), to: new Date(y, m - 1, d + 1).getTime() };
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" };

/** An agent line's text without the rich-text tags (rich-text.ts): history shows it plain. */
export function plainText(text: string): string {
  if (!text.includes("<")) return text;
  let s = text.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div)>/gi, "\n");
  // Until nothing is left to take: a tag split by another ("<scr<b>ipt>") goes too.
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/<[^<>]*>/g, "");
  }
  // Entities in one pass, after the tags: the page renders this as text, never as HTML.
  return s
    .replace(/&(lt|gt|quot|#39|amp);/g, (_m, e: string) => ENTITIES[e] ?? _m)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

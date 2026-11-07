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

/** A local day ("2026-11-07") as [its first ms, the next day's first ms), on this clock. */
export function dayRange(day: string): { from: number; to: number } {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return { from: new Date(y, m - 1, d).getTime(), to: new Date(y, m - 1, d + 1).getTime() };
}

/** An agent line's text without the rich-text tags (rich-text.ts): history shows it plain. */
export function plainText(text: string): string {
  if (!text.includes("<")) return text;
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

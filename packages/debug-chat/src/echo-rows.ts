/**
 * Read-aloud echoes in the chat (docs/echo-suppression.md, "UI: collapsed,
 * labelled, expandable"). The hub keeps an echo out of the thread's lines and
 * sends it to his pages in its own frames:
 *
 *   {type:"echo", line}         one more echo to show
 *   {type:"echoes", lines}      the page just joined: all kept ones
 *   {type:"echo-gone", ids}     undone ("This was me") or evicted
 *
 * The chat shows them as slim collapsed rows between the runs, where the line
 * would have been; several with no line between them fold into one row. Pure:
 * tested in unit/echo-rows.test.ts; the row itself is EchoRows.tsx.
 */
import type { ChatMessage } from "./wire";

/** Echoes a page keeps at most (the hub keeps voice.echoShowMax). */
export const ECHO_ROWS_MAX = 200;

const isLine = (x: unknown): x is ChatMessage => {
  if (!x || typeof x !== "object") return false;
  const m = x as Partial<ChatMessage>;
  return (
    typeof m.id === "string" &&
    typeof m.text === "string" &&
    typeof m.at === "number" &&
    Number.isFinite(m.at) &&
    m.echo?.shown === true
  );
};

/**
 * The page's echoes after one hub frame, oldest first; null for a frame that
 * is not an echo frame (the caller handles it).
 */
export function applyEchoFrame(list: readonly ChatMessage[], frame: unknown): ChatMessage[] | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as { type?: unknown; line?: unknown; lines?: unknown; ids?: unknown };
  const sorted = (xs: ChatMessage[]) =>
    xs.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).slice(-ECHO_ROWS_MAX);
  if (f.type === "echo") {
    if (!isLine(f.line)) return [...list];
    const line = f.line;
    return sorted([...list.filter((m) => m.id !== line.id), line]);
  }
  if (f.type === "echoes") {
    const lines = Array.isArray(f.lines) ? f.lines.filter(isLine) : [];
    return sorted([...new Map(lines.map((m) => [m.id, m])).values()]);
  }
  if (f.type === "echo-gone") {
    const ids = new Set(Array.isArray(f.ids) ? f.ids.filter((x) => typeof x === "string") : []);
    return list.filter((m) => !ids.has(m.id));
  }
  return null;
}

/**
 * Where each echo shows: after the last run that started at or before it
 * (-1: before the first run). Echoes in one slot have no line between them,
 * so they fold into one row; each slot's echoes are oldest first.
 */
export function echoSlots(
  runStarts: readonly number[],
  echoes: readonly ChatMessage[],
): Map<number, ChatMessage[]> {
  const out = new Map<number, ChatMessage[]>();
  for (const e of [...echoes].sort((a, b) => a.at - b.at)) {
    let slot = -1;
    for (let i = 0; i < runStarts.length; i++) if (runStarts[i]! <= e.at) slot = i;
    const group = out.get(slot);
    if (group) group.push(e);
    else out.set(slot, [e]);
  }
  return out;
}

/** The first words of an echo, for the collapsed row (whole code points, an ellipsis when cut). */
export function echoHead(text: string, max = 32): string {
  const chars = [...text.trim().replace(/\s+/g, " ")];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** A dev holder's note on one echo: which evidence, how alike, which voice. */
export function echoDevNote(m: ChatMessage): string {
  const e = m.echo;
  if (!e) return "";
  return [
    e.layer ?? "landed",
    e.sim.toFixed(2),
    e.voice,
    e.overlapMs !== undefined ? `${e.overlapMs} ms` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

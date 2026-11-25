/**
 * Deleting a chat line (docs/chat-history.md, "Deleting a line"): the thread's
 * owner takes one line back, for example a secret pasted by mistake. The line
 * stays in its place, so the thread still reads in order, but only the
 * placeholder is left of it: its text, `raw`, edits, merged parts, attachments,
 * audio, page context and screen text all go. The same happens to every copy
 * the hub keeps (its storage ring, the D1 history, Li's frozen window).
 *
 * Pure, no imports but types, so lianki-push bundles it (workers/push/src/debug.ts).
 */
import type { ChatMessage } from "../packages/debug-chat/src/wire";
import type { PartnerWindow } from "./partner-window";

/**
 * What a deleted line reads, as stored (the hub, D1, Li's window). A page shows
 * its own word for it (the `lineRedacted` strings); this is the fallback.
 */
export const REDACTED_TEXT = "(deleted)";

/** The audit kind of a deletion (lib/security/audit-log.ts): who, which id, when; never the text. */
export const REDACT_AUDIT_KIND = "chat.redact";

/** How a deletion reached the hub: his page's socket, or the session API (/api/chat/redact). */
export type RedactVia = "page" | "api";

/** A line id as the hub mints and the pages send them. */
export const REDACT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * The fields of a line that survive a deletion: who and when (so the line keeps
 * its avatar and place), never anything it said. `collapsedInto` stays so a
 * deleted line inside a merged passage stays hidden under it.
 */
const KEEP = [
  "seq",
  "id",
  "from",
  "label",
  "at",
  "thread",
  "sender",
  "via",
  "tokenLane",
  "tok",
  "avatar",
  "client",
  "taskPath",
  "agentId",
  "to",
  "lane",
  "collapsedInto",
] as const satisfies readonly (keyof ChatMessage)[];

/** A line with everything it said taken out: the placeholder and the `redacted` mark. */
export function redactMessage<M extends ChatMessage>(m: M, at: number): ChatMessage {
  const out: Record<string, unknown> = {};
  for (const k of KEEP) if (m[k] !== undefined) out[k] = m[k];
  return {
    ...(out as Pick<ChatMessage, "id" | "from" | "label" | "at">),
    text: REDACTED_TEXT,
    redacted: { at },
  };
}

/**
 * Every text the line has carried: what it reads, what was first heard, each
 * merged part, what it read before a merge. These are what must leave the
 * other copies (Li's window, echoes).
 */
export function lineTexts(m: ChatMessage): string[] {
  const all = [
    m.text,
    m.raw,
    m.premerge?.text,
    m.premerge?.raw,
    ...(m.parts ?? []).map((p) => p.text),
    m.recheck && typeof (m.recheck as { text?: unknown }).text === "string"
      ? (m.recheck as { text: string }).text
      : undefined,
  ];
  return [...new Set(all.filter((t): t is string => typeof t === "string" && !!t.trim()))];
}

/** The first characters an edit entry quotes (partner-window.ts editEntry). */
const HEAD = 60;

/**
 * Li's frozen window (lib/partner-window.ts) without the line: each item that
 * holds any of its texts (as sent, attributed, or quoted in an edit entry)
 * reads the placeholder instead, and the window remembers the line as the
 * placeholder, so it is not taken in again. One cache miss; nothing else moves.
 */
export function redactWindow(
  w: PartnerWindow,
  id: string,
  texts: readonly string[],
  placeholder: string = REDACTED_TEXT,
): PartnerWindow {
  const seen = w.seen[id];
  const needles = [
    ...new Set(
      [...texts, ...(seen !== undefined ? [seen] : [])]
        .filter((t) => t.trim() && t !== placeholder)
        .flatMap((t) => (t.length > HEAD ? [t, t.slice(0, HEAD)] : [t])),
    ),
  ];
  const hit = (text: string) => needles.some((n) => text.includes(n));
  return {
    ...w,
    items: w.items.map((it) => (hit(it.text) ? { ...it, text: placeholder } : it)),
    seen: { ...w.seen, ...(id in w.seen ? { [id]: placeholder } : {}) },
  };
}

/** Does any copy of these texts remain in the window? (tests, and the hub's own check) */
export function windowHolds(w: PartnerWindow, texts: readonly string[]): boolean {
  const blob = JSON.stringify(w);
  return texts.some(
    (t) => t.trim() && t !== REDACTED_TEXT && blob.includes(JSON.stringify(t).slice(1, -1)),
  );
}

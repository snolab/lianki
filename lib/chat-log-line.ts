/**
 * What of a chat line goes to the account's history (docs/chat-history.md):
 * the hub's ChatMessage narrowed to id, from, lane, text, time, and whether
 * it is an ask card and what it was answered. Pure, no imports but types and
 * voices.ts, so lianki-push bundles it (workers/push/src/debug.ts).
 *
 * Never kept, whatever the line carries:
 *   - `context` (a selection attached with the + menu) and `scene` (the text
 *     on screen around a voice line): page text, which on a private screen
 *     (`[data-lk-private-screen]`: /vibe, a transcript in /read) is private
 *     speech, not chat (docs/vibe.md);
 *   - `raw` and `parts` (STT before polish), `timing`, `speaker`, `wake`;
 *   - `label` (the page path and user agent), `sender`, `email`;
 *   - `attachments` (upload ids; the files stay in the inbox);
 *   - audio and clip ids (none are on a line).
 */
import type { Ask, AskAnswer } from "../packages/debug-chat/src/ask";
import { type LaneId, laneOf } from "../packages/debug-chat/src/voices";

/** Longest text kept, as the chat's own MAX_CHAT (wire.ts). */
export const CHAT_LOG_MAX_TEXT = 4000;
/** Longest answer text kept (labels of the chosen options, joined). */
export const CHAT_LOG_MAX_ANSWER = 1000;
/** At most this many lines per write (a backfill is CHAT_HISTORY = 200). */
export const CHAT_LOG_MAX_LINES = 250;

export type ChatLogFrom = "owner" | "friend" | "agent";

/** One line as the account's history keeps it. */
export type ChatLogLine = {
  id: string;
  from: ChatLogFrom;
  /** The agent's lane (voices.ts LANES); null on the user's own lines. */
  lane: LaneId | null;
  text: string;
  at: number;
  /** An ask card (its text is the question and options, askText). */
  ask: boolean;
  /** The ask's answer, the chosen options' labels; null until tapped. */
  answer: string | null;
};

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/** The labels of an ask's chosen options, "a / b" per question, "; " between questions. */
export function answerText(ask: Ask | undefined, answer: AskAnswer | undefined): string | null {
  if (!ask || !answer?.choices) return null;
  const parts: string[] = [];
  for (const q of ask.questions ?? []) {
    const ids = answer.choices[q.id] ?? [];
    const labels = ids.map((id) => q.options.find((o) => o.id === id)?.label ?? id);
    if (labels.length) parts.push(labels.join(" / "));
  }
  return parts.length ? parts.join("; ").slice(0, CHAT_LOG_MAX_ANSWER) : null;
}

/** The fields of a hub line this needs; anything else on it is ignored. */
export type LoggableLine = {
  id?: unknown;
  from?: unknown;
  lane?: unknown;
  text?: unknown;
  at?: unknown;
  ask?: Ask;
  answer?: AskAnswer;
};

/** A hub line narrowed to what history keeps, or null when it is not a chat line. */
export function chatLogLine(m: LoggableLine): ChatLogLine | null {
  if (typeof m.id !== "string" || !ID.test(m.id)) return null;
  if (m.from !== "owner" && m.from !== "friend" && m.from !== "agent") return null;
  if (typeof m.text !== "string" || typeof m.at !== "number" || !Number.isFinite(m.at)) return null;
  let text = m.text;
  let lane: LaneId | null = null;
  if (m.from === "agent") {
    const r = laneOf({ lane: m.lane, text });
    lane = r.lane ?? "main";
    text = r.text;
  }
  text = text.slice(0, CHAT_LOG_MAX_TEXT);
  if (!text.trim()) return null;
  return {
    id: m.id,
    from: m.from,
    lane,
    text,
    at: Math.round(m.at),
    ask: !!m.ask,
    answer: answerText(m.ask, m.answer),
  };
}

/** Checks a line that crossed the RPC boundary; null when anything is off. */
export function parseChatLogLine(raw: unknown): ChatLogLine | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID.test(r.id)) return null;
  if (r.from !== "owner" && r.from !== "friend" && r.from !== "agent") return null;
  if (typeof r.text !== "string" || !r.text.trim()) return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at) || r.at < 0) return null;
  const lane =
    r.from === "agent" &&
    (r.lane === "main" || r.lane === "codex" || r.lane === "agy" || r.lane === "claude")
      ? (r.lane as LaneId)
      : r.from === "agent"
        ? "main"
        : null;
  return {
    id: r.id,
    from: r.from,
    lane,
    text: r.text.slice(0, CHAT_LOG_MAX_TEXT),
    at: Math.round(r.at),
    ask: r.ask === true,
    answer: typeof r.answer === "string" ? r.answer.slice(0, CHAT_LOG_MAX_ANSWER) : null,
  };
}

/** What the hub asks the main Worker to do (DebugSessions.chatLog, worker.ts). */
export type ChatLogRequest =
  /** New lines: inserted, never overwriting (an id already there stays as it is). */
  | { op: "put"; thread: string; lines: ChatLogLine[] }
  /** Changed lines (polish, merge, an answer): updated only where still kept. */
  | { op: "update"; thread: string; lines: ChatLogLine[] }
  /** A merged line split back: the first updates `id`, the rest are added only while `id` is kept. */
  | { op: "split"; thread: string; id: string; lines: ChatLogLine[] }
  /** The hub's stored history, once per account (lib/chat-log.ts backfill). */
  | { op: "backfill"; thread: string; lines: ChatLogLine[] }
  /**
   * Lines the hub derived and takes back (a merged passage undone): only ids
   * that are such derived lines (isDerivedLogId); a line he said never.
   */
  | { op: "drop"; thread: string; ids: string[] };

/** A merged passage's own line in the history: its first line's id + ".merged". */
export const passageLogId = (id: string) => `${id}.merged`;
/** Is this a history line the hub derived (a passage), which it may drop on an undo? */
export const isDerivedLogId = (id: string) => /^[A-Za-z0-9_-]{1,64}\.merged$/.test(id);

export type ChatLogAnswer = { ok: true; written: number } | { ok: false; error: string };

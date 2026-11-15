/**
 * Continuous speech amends the line already sent (owner, 2026-11-06 01:13 JST:
 * "连续的语音输入应该能够有能力编辑已经发出去的消息"). Flag `stt.merge`; the rule and the
 * evidence behind it are in docs/dev-debug-widget.md, "Continuous speech amends
 * the last line".
 *
 * The same verdict runs twice: on the page (to decide whether to ask, and which
 * cue to play) and in the hub, which alone decides. Nothing here knows a
 * language. What a line's end says is read from punctuation classes only, and the
 * windows are what the mic already works with:
 *
 * - `VOICE_TUNE.redemptionMs`: the silence the VAD's own endpoint treats as inside
 *   one utterance. Only the local STT's 600 ms endpoint ever splits speech at less,
 *   and it does so for latency, not because a thought ended.
 * - `JOIN_WINDOW_MS`: the wait that rejoined 17 of 18 cut lines on his clips (#357).
 *
 * The gap alone is not enough: on his clips room talk restarts the VAD just as fast,
 * and nearly every line ends in a stop whether it is finished or not. So a line that
 * only looks finished merges only when the Mac's voiceprint signed both as him.
 *
 * Pure, and free of the DOM: the Worker imports it.
 */
import { MAX_UTTERANCE_MS, joinText } from "./mic";
import {
  JOIN_WINDOW_MS,
  MERGE_REOPEN_DEFAULT_SEC,
  MERGE_REOPEN_KEY,
  MERGE_REOPEN_MAX_SEC,
  VOICE_TUNE,
  isShortAnswer,
} from "./voice-tune";
import {
  type ChatContext,
  type ChatMessage,
  MAX_CHAT,
  type MergedPart,
  type SpeakerTag,
  type SttTag,
  type VoiceTiming,
  combineSpeaker,
} from "./wire";

/** A stored line stays well under a Durable Object value's 128 KiB, whatever the parts carry. */
export const MAX_MERGE_PARTS = 40;
/** The `by` on a merge's edit mark: no agent wrote this text. */
export const MERGE_BY = "merge";
/** The `by` on the event that splits a merged line back. */
export const UNMERGE_BY = "undo";
/** No speech for this long after a voice line: the passage is over, polish may read all of it. */
export const PASSAGE_END_MS = JOIN_WINDOW_MS;

/** How a line's text ends: "final" a question or exclamation, "open" a clause mark or nothing. */
export type TextEnd = "final" | "open" | "stop";

const CLOSERS = "[\"'”’」』)）]*";
const FINAL_END = new RegExp(`[?？!！]${CLOSERS}$`, "u");
/** A clause mark, with or without the stop the mic adds after it (…然后，。). */
const OPEN_END = /(?:[,，、;；:：…～—-]|\.\.\.)\s*[。．.]?$/u;

export function textEnd(text: string): TextEnd {
  const t = text.trim();
  if (FINAL_END.test(t)) return "final";
  if (OPEN_END.test(t) || !/\p{P}$/u.test(t)) return "open";
  return "stop";
}

/** Two parts as one text: no space after a full-width mark (joinText spaces those). */
export const joinParts = (a: string, b: string) =>
  /[\uff00-\uffef]$/.test(a) ? a + b.trim() : joinText(a, b);

/** The newest utterance in a line: what the next one follows. */
const lastRaw = (m: ChatMessage) => m.parts?.at(-1)?.text ?? m.raw ?? m.text;
const lastTiming = (m: ChatMessage) => m.parts?.at(-1)?.timing ?? m.timing;

/** The next utterance, as much of it as both the page and the hub know. */
export type MergeCandidate = {
  text: string;
  timing?: VoiceTiming;
  stt?: SttTag;
  to?: string;
  wake?: "active" | "passive";
  context?: ChatContext;
  attachments?: unknown[];
  speaker?: SpeakerTag;
  wakeReason?: ChatMessage["wakeReason"];
};

export type MergeVerdict =
  | { ok: true; signal: "cut" | "open" | "quick" | "reopen" }
  | { ok: false; reason: string };

/**
 * May `cur` amend `prev`? Conservative: anything unknown stays a new line. A
 * wrong merge costs more than two bubbles.
 */
export function mergeVerdict(prev: ChatMessage, cur: MergeCandidate): MergeVerdict {
  const no = (reason: string): MergeVerdict => ({ ok: false, reason });
  if (prev.from !== "owner" || prev.source !== "stt") return no("not-voice");
  if (!prev.mergeable) return no("not-mergeable");
  if (prev.settled) return no("settled");
  const why = joinable(prev, cur);
  if (why) return no(why);
  // No timestamps, no evidence.
  const a = lastTiming(prev);
  const start = cur.timing?.t_speechStart;
  if (start === undefined || a?.t_speechEnd === undefined) return no("no-timing");
  const since = start - a.t_speechEnd;
  if (a.t_cut !== undefined && since <= JOIN_WINDOW_MS) return { ok: true, signal: "cut" };
  if (textEnd(lastRaw(prev)) === "open" && since <= JOIN_WINDOW_MS)
    return { ok: true, signal: "open" };
  if (a.t_lastVoice === undefined || start - a.t_lastVoice > VOICE_TUNE.redemptionMs)
    return no("gap");
  if (prev.speaker?.decision !== "me" || cur.speaker?.decision !== "me") return no("unverified");
  return { ok: true, signal: "quick" };
}

/**
 * What a live merge and a reopen both need, or why not: the same node, no wake
 * word, nothing attached, nobody else's voice, no short answer, no question or
 * exclamation at the end, and the caps.
 */
function joinable(prev: ChatMessage, cur: MergeCandidate): string | undefined {
  const no = (reason: string) => reason;
  if ((prev.to ?? undefined) !== (cur.to ?? undefined)) return no("other-node");
  // A wake-word line is a new turn; files or a selection make a line about them.
  if (prev.wake === "passive" || cur.wake === "passive") return no("wake");
  if (prev.context || prev.attachments?.length || cur.context || cur.attachments?.length)
    return no("attached");
  // Someone else's voice is not his next words, and a short answer stands alone.
  if (prev.speaker?.decision === "other" || cur.speaker?.decision === "other")
    return no("speaker");
  if (isShortAnswer(lastRaw(prev)) || isShortAnswer(cur.text)) return no("short-answer");
  if (textEnd(lastRaw(prev)) === "final") return no("ended");
  if ((prev.parts?.length ?? 1) >= MAX_MERGE_PARTS) return no("parts");
  if (joinParts(heardOf(prev), cur.text).length > MAX_CHAT) return no("long");
  return undefined;
}

/** What a line read as heard: before Whisper's reading of its run, before any polish. */
const heardOf = (m: ChatMessage) => m.recheck?.heard ?? m.raw ?? m.text;

/**
 * Config `stt.mergeReopenSec` (lib/config.ts): how long after his last voice line
 * a new utterance may still join it. Defaults and bounds here, the live value from
 * the DB; the hub and the page both read it through reopenMsOf.
 */
export { MERGE_REOPEN_DEFAULT_SEC, MERGE_REOPEN_KEY, MERGE_REOPEN_MAX_SEC };

/** The reopen window in ms from a config value; anything unreadable or out of range is off (0). */
export function reopenMsOf(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MERGE_REOPEN_MAX_SEC) return 0;
  return Math.round(v * 1000);
}

/**
 * The `by` marks a reopened line may carry: a merge, the hub's own polish, the
 * two-mic swap. Nobody chose those words, so the next ones may still join them.
 * A lane's or his own edit (`eval.ts edit`) is a hand on the line: it stays.
 */
export const REOPEN_EDITS: readonly string[] = [MERGE_BY, "auto", "two-mic"];

/**
 * May `cur` join `prev` although the live run has ended (owner, 2026-11-15:
 * "已经提交的语音消息是不是也可以继续贡献给识别窗口？")? `prev` is his newest voice
 * line, posted (and perhaps settled, re-listened, polished by the hub) and still
 * the thread's latest line; the caller checks that. `windowMs` is
 * stt.mergeReopenSec; `arrived`, when known (the hub), is how long after the
 * line last grew `cur` reached it, on the hub's clock: at most the window plus
 * one utterance, so a page clock that jumped does not stretch it.
 *
 * The gap no longer has to look like one utterance, so the speaker check is
 * stricter than a live merge's: both lines verified as him by the Mac, or (no
 * voiceprint on the device) neither tagged at all.
 */
export function reopenVerdict(
  prev: ChatMessage,
  cur: MergeCandidate,
  windowMs: number,
  arrived?: number,
): MergeVerdict {
  const no = (reason: string): MergeVerdict => ({ ok: false, reason });
  if (!(windowMs > 0)) return no("reopen-off");
  if (prev.from !== "owner" || prev.source !== "stt") return no("not-voice");
  if (!prev.mergeable) return no("not-mergeable");
  if (prev.removed || prev.echo || prev.collapsedInto || prev.passage || prev.summary)
    return no("superseded");
  if (prev.edited && !REOPEN_EDITS.includes(prev.edited.by)) return no("edited");
  const why = joinable(prev, cur);
  if (why) return no(why);
  const a = prev.speaker?.decision;
  const b = cur.speaker?.decision;
  if ((a || b) && (a !== "me" || b !== "me")) return no("unverified");
  const end = lastTiming(prev)?.t_speechEnd;
  const start = cur.timing?.t_speechStart;
  if (start === undefined || end === undefined) return no("no-timing");
  if (start - end > windowMs) return no("gap");
  if (arrived !== undefined && arrived > windowMs + MAX_UTTERANCE_MS) return no("gap");
  return { ok: true, signal: "reopen" };
}

/**
 * The page's and the hub's one question: a live merge first (mergeVerdict), else
 * a reopen within the window. The refusal names both reasons when a reopen was tried.
 */
export function joinVerdict(
  prev: ChatMessage,
  cur: MergeCandidate,
  windowMs: number,
  arrived?: number,
): MergeVerdict {
  const v = mergeVerdict(prev, cur);
  if (v.ok || !(windowMs > 0)) return v;
  const r = reopenVerdict(prev, cur, windowMs, arrived);
  return r.ok ? r : { ok: false, reason: `${v.reason}; reopen: ${r.reason}` };
}

/** A line as one part of a merged line. Never a polish: only what was heard. */
function partOf(m: {
  id: string;
  text: string;
  raw?: string;
  at: number;
  timing?: VoiceTiming;
  stt?: SttTag;
  speaker?: SpeakerTag;
  wake?: "active" | "passive";
  wakeReason?: ChatMessage["wakeReason"];
}): MergedPart {
  return {
    id: m.id,
    text: m.raw ?? m.text,
    at: m.at,
    ...(m.timing ? { timing: m.timing } : {}),
    ...(m.stt ? { stt: m.stt } : {}),
    ...(m.speaker ? { speaker: m.speaker } : {}),
    ...(m.wake ? { wake: m.wake } : {}),
    ...(m.wakeReason ? { wakeReason: m.wakeReason } : {}),
  };
}

/**
 * The line after `cur` joined it. The text falls back to the merged raw text:
 * an earlier polish is dropped, so the next one reads what was heard and its
 * errors do not compound. `edited.count` stays the number of polishes (no
 * cap: polish is unrestricted, owner 2026-11-14); a merge spends none of it.
 *
 * The speaker tag is the weakest of the parts, with all their signed words, and
 * a part with none leaves the line with none: an unverified part must not ride
 * on a verified one.
 */
export function mergeLines(
  prev: ChatMessage,
  cur: MergeCandidate & { id: string; at: number },
  at: number,
): ChatMessage {
  const raw = joinParts(heardOf(prev), cur.text);
  // A reopened line (reopenVerdict) is a run again: not settled, and its Whisper
  // reading, made of fewer parts, goes; the next passage end re-listens all of it.
  const {
    speaker: _speaker,
    timing: _timing,
    stt: _stt,
    settled: _settled,
    recheck: _recheck,
    ...rest
  } = prev;
  const a = prev.speaker;
  const b = cur.speaker;
  const weakest = a && b ? combineSpeaker([a, b]) : undefined;
  const signed = [...(a?.signed ?? []), ...(b?.signed ?? [])];
  const tag = weakest && signed.length ? { ...weakest, signed } : weakest;
  return {
    ...rest,
    text: raw,
    raw,
    parts: [...(prev.parts ?? [partOf(prev)]), partOf(cur)],
    edited: { at, by: MERGE_BY, count: prev.edited?.count ?? 0 },
    ...(cur.timing ? { timing: cur.timing } : {}),
    ...(cur.stt ? { stt: cur.stt } : {}),
    ...(tag ? { speaker: tag } : {}),
  };
}

/** A merged line back as the lines it was made from, as heard. They merge no further. */
export function splitLine(line: ChatMessage): ChatMessage[] {
  const {
    parts,
    raw: _raw,
    edited: _edited,
    mergeable: _mergeable,
    settled: _settled,
    recheck: _recheck,
    speaker: _speaker,
    timing: _timing,
    stt: _stt,
    wake: _wake,
    wakeReason: _wakeReason,
    ...base
  } = line;
  return (parts ?? []).map((p) => ({ ...base, ...p }));
}

/** What a polish of a merged line may draw on: its own parts, so later words correct earlier ones. */
export const partTexts = (line: ChatMessage): string[] => (line.parts ?? []).map((p) => p.text);

/** When the line last grew. */
export const lastPartAt = (line: ChatMessage): number => line.parts?.at(-1)?.at ?? line.at;

/**
 * Why these lines may not become one passage (an agent's `edit --merge`), by
 * speaker, or undefined. Never someone else's line (owner, 2026-11-13: a final
 * split by speaker leaves his part and hers as two lines, and the polish must
 * not join them again); and a line verified as his never shares a passage with
 * one that is not, so his ✓ never covers words the Mac did not sign as his.
 */
export function passageSpeakers(
  lines: readonly Pick<ChatMessage, "id" | "speaker">[],
): string | undefined {
  const other = lines.find((x) => x.speaker?.decision === "other");
  if (other) return `message ${other.id} is someone else's voice: only his own lines make a passage`;
  const me = lines.find((x) => x.speaker?.decision === "me");
  const not = lines.find((x) => x.speaker?.decision !== "me");
  if (me && not)
    return `message ${not.id} is not verified as his voice and message ${me.id} is: a passage keeps one speaker`;
  return undefined;
}

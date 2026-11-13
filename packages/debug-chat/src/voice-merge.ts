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
import { joinText } from "./mic";
import { JOIN_WINDOW_MS, VOICE_TUNE, isShortAnswer } from "./voice-tune";
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
const joinParts = (a: string, b: string) =>
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
  | { ok: true; signal: "cut" | "open" | "quick" }
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
  if ((prev.to ?? undefined) !== (cur.to ?? undefined)) return no("other-node");
  // A wake-word line is a new turn; files or a selection make a line about them.
  if (prev.wake === "passive" || cur.wake === "passive") return no("wake");
  if (prev.context || prev.attachments?.length || cur.context || cur.attachments?.length)
    return no("attached");
  // Someone else's voice is not his next words, and a short answer stands alone.
  if (prev.speaker?.decision === "other" || cur.speaker?.decision === "other")
    return no("speaker");
  if (isShortAnswer(lastRaw(prev)) || isShortAnswer(cur.text)) return no("short-answer");
  const end = textEnd(lastRaw(prev));
  if (end === "final") return no("ended");
  if ((prev.parts?.length ?? 1) >= MAX_MERGE_PARTS) return no("parts");
  if (joinParts(prev.raw ?? prev.text, cur.text).length > MAX_CHAT) return no("long");
  // No timestamps, no evidence.
  const a = lastTiming(prev);
  const start = cur.timing?.t_speechStart;
  if (start === undefined || a?.t_speechEnd === undefined) return no("no-timing");
  const since = start - a.t_speechEnd;
  if (a.t_cut !== undefined && since <= JOIN_WINDOW_MS) return { ok: true, signal: "cut" };
  if (end === "open" && since <= JOIN_WINDOW_MS) return { ok: true, signal: "open" };
  if (a.t_lastVoice === undefined || start - a.t_lastVoice > VOICE_TUNE.redemptionMs)
    return no("gap");
  if (prev.speaker?.decision !== "me" || cur.speaker?.decision !== "me") return no("unverified");
  return { ok: true, signal: "quick" };
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
 * errors do not compound. `edited.count` stays the number of polishes, so
 * MAX_EDITS still caps them across the passage; a merge spends none of it.
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
  const raw = joinParts(prev.raw ?? prev.text, cur.text);
  const { speaker: _speaker, timing: _timing, stt: _stt, ...rest } = prev;
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

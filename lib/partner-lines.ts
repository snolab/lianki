/**
 * Who said what, for the Learning Partner AI (Li; docs/partner-ai.md,
 * "Speaking as itself"). Two jobs, both pure:
 *
 * - `partnerHistoryLine`: a thread line as the model sees it. Only Li's own
 *   lines are `assistant`; every other agent line (a dev lane, a token lane, a
 *   hub notice) is a `user` line attributed to its sender, "(agent coco said:
 *   …)", with its 【lane】 tag taken off. Passed raw as `assistant`, a lane's
 *   "【claude】…" read as Li's own earlier words, and Li went on writing in that
 *   voice (2026-11-17: a reply opening "【claude】Happy to build it…").
 * - `stripLeadTags`: Li's reply without any speaker tag in front. In the chat
 *   a leading 【name】 is the speaker's tag (voices.ts laneOf), so every
 *   leading 【…】 goes, whatever it says: an unknown name is still a tag, and
 *   Li has no reason to open with one. `[name]` and `name:` are common text
 *   too ("[1]", "Note:"), so they go only when the name is a member's: a lane
 *   id, name or alias (built-in, the live table, or the config rows passed),
 *   or Li's own names.
 */
import type { ChatLaneDef } from "../packages/debug-chat/src/voices";
import { laneIds, laneOf, laneSpec } from "../packages/debug-chat/src/voices";
import { PARTNER_AI_LABEL } from "./partner-ai-config";

/** Li's own names as a tag could spell them (lower case). */
const LI_NAMES = ["li", "learning partner", PARTNER_AI_LABEL.toLowerCase()];

/** A leading 【…】 tag, maybe in bold, and the punctuation after it. */
const BRACKET_TAG = /^\s*(?:\*\*|__)?【[^】\n]{0,40}】(?:\*\*|__)?[\s:：,，.。\-–—]*/u;
/** A leading [name] or name: / name： (maybe in bold), the name captured. */
const SQUARE_TAG = /^\s*(?:\*\*|__)?\[\s*([^\]\n]{1,40}?)\s*\](?:\*\*|__)?[\s:：,，\-–—]*/u;
const COLON_TAG =
  /^\s*(?:\*\*|__)?([^\s:：\n*_][^:：\n*_]{0,39}?)\s*(?:\*\*|__)?[:：](?:\*\*|__)?\s*/u;

/** Every name a member goes by (lower case): lanes known here, the rows given, and Li's. */
export function memberNames(lanes: readonly ChatLaneDef[] = []): Set<string> {
  const out = new Set<string>(LI_NAMES);
  const add = (n: string | undefined) => {
    const t = n?.trim().toLowerCase();
    if (t) out.add(t);
  };
  for (const id of laneIds()) {
    add(id);
    const s = laneSpec(id);
    add(s.name);
    s.aliases.forEach(add);
  }
  for (const d of lanes) {
    add(d.id);
    add(d.name);
    d.aliases?.forEach(add);
  }
  return out;
}

/** The text without any speaker tag in front (see the file comment for which). */
export function stripLeadTags(text: string, lanes: readonly ChatLaneDef[] = []): string {
  let names: Set<string> | undefined;
  const known = (n: string) => (names ??= memberNames(lanes)).has(n.trim().toLowerCase());
  let t = text;
  for (let i = 0; i < 8; i++) {
    const b = BRACKET_TAG.exec(t);
    if (b) {
      t = t.slice(b[0].length);
      continue;
    }
    const s = SQUARE_TAG.exec(t) ?? COLON_TAG.exec(t);
    if (s && known(s[1]!)) {
      t = t.slice(s[0].length);
      continue;
    }
    break;
  }
  return t.trim();
}

/** A stored chat line, as much of it as attribution needs. */
export type ThreadLine = {
  from: string;
  text: string;
  label?: string;
  lane?: unknown;
  tokenLane?: string;
};

/** Who an agent line is from, as a short name: its lane's name tag, its token's, else its label. */
export function senderName(m: ThreadLine): string {
  if (m.tokenLane?.trim()) return m.tokenLane.trim().slice(0, 40);
  const lane = laneOf({ lane: m.lane, text: m.text }).lane;
  if (lane) return laneSpec(lane).name || lane;
  return m.label?.trim().slice(0, 40) || "agent";
}

/**
 * One thread line for the model: his (or the friend's) lines and Li's own as
 * they are; another member's attributed, as a `user` line, never as Li's.
 */
export function partnerHistoryLine(m: ThreadLine): { role: "user" | "assistant"; text: string } {
  if (m.from !== "agent") return { role: "user", text: m.text };
  if (m.label === PARTNER_AI_LABEL) return { role: "assistant", text: stripLeadTags(m.text) };
  return { role: "user", text: `(agent ${senderName(m)} said: ${stripLeadTags(m.text)})` };
}

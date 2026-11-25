/**
 * The reminded agent's answer (owner, 2026-11-26: 「状态树提醒被发出来了之后，
 * 被提醒的那个 agent 应该在这里回一条消息，说明这个提醒已经被处理了或者正在处理」;
 * docs/state-tree.md, "Replies"). When a state-tree reminder went out (an
 * "ETA reached" line, or a blocked nudge to a lane) and the agent then acks
 * its receipt or reports on that node, the progress hub has the chat hub post
 * one short line in the thread under that agent's name, quoting the task:
 * 「coco (codex)：收到「R键重播」，处理中（ETA 20 分钟）」. It comes from the ack
 * or the report itself, so no agent can forget it. One per reminder
 * (ProgressEntry.replyFor). The words are live config keys (lib/config.ts);
 * their descriptions are the translators' context.
 */
import { LANES, parseLaneDef } from "../packages/debug-chat/src/voices";
import { type ProgressEntry, nudgeKey, parseWho } from "./progress";

/** What the reply says: got it (no new time), working on it until {min}, or done. */
export type ReplyState = "ack" | "doing" | "done";
export const REPLY_STATES: readonly ReplyState[] = ["ack", "doing", "done"];

/** The config keys of the reply words and of the reminders' sender name. */
export const REPLY_KEYS = {
  ack: "chat.etaReplyAck",
  doing: "chat.etaReplyDoing",
  done: "chat.etaReplyDone",
} as const satisfies Record<ReplyState, string>;
/** The sender name the reminders carry (their label), so nobody reads "@codex …" as codex speaking. */
export const STATE_TREE_SENDER_KEY = "chat.stateTreeSender";

/** The defaults (lib/config.ts holds the same; the chat hub falls back to these). */
export const REPLY_DEFAULTS: Record<ReplyState, string> = {
  ack: "{agent}：收到「{task}」，处理中",
  doing: "{agent}：收到「{task}」，处理中（ETA {min} 分钟）",
  done: "{agent}：「{task}」已处理",
};
export const STATE_TREE_SENDER_DEFAULT = "状态树提醒";

/** The config key of the lane table, whose `name`s are the lanes' display names. */
export const LANE_TABLE_KEY = "chat.lanes";

/**
 * A lane's display name (owner, 2026-11-26: 「为什么是 agy 而不是哈基米」): its
 * `chat.lanes` row's name, else the built-in lane's (voices.ts LANES), else the
 * id. `rows` is the live table as read (anything not a list: none).
 */
export function laneShown(lane: string, rows: unknown = []): string {
  if (Array.isArray(rows))
    for (const r of rows) {
      const d = parseLaneDef(r);
      if (d?.id === lane && d.name) return d.name;
    }
  const base = (LANES as Readonly<Record<string, { name: string } | undefined>>)[lane];
  return base?.name || lane;
}

/**
 * How a who or an assignee reads in a line, by display names: "哈基米" for the
 * lane agy, "coco (哈基米)" for an agent coco in it, the name as it is otherwise.
 */
export function whoShown(who: string, rows: unknown = []): string {
  const t = parseWho(who);
  if (!t) return who;
  const lane = laneShown(t.lane, rows);
  return t.agent && t.agent !== lane ? `${t.agent} (${lane})` : lane;
}

/** A template's text with {agent}, {task} and {min} filled in. */
export function replyText(tpl: string, v: { agent: string; task: string; min?: number }): string {
  return tpl
    .replaceAll("{agent}", v.agent)
    .replaceAll("{task}", v.task)
    .replaceAll("{min}", v.min === undefined ? "?" : String(v.min));
}

/** The key of the reminder a node last had sent, if one went out and was heard. */
export function reminderKey(e: ProgressEntry): string | undefined {
  // A blocked nudge that reached a listener (a queued one was never heard).
  if (e.nudgeFor !== undefined && (e.nudgeN ?? 0) > 0 && e.nudgeQueued === undefined)
    return `nudge:${e.nudgeFor}`;
  // An "ETA reached" line that went out.
  if (e.etaAt !== undefined && e.etaSent === e.etaAt && e.etaQueued !== e.etaAt)
    return `eta:${e.etaAt}`;
  return undefined;
}

/**
 * The reply a write owes: `prev` had a reminder out that is not answered yet,
 * and `next` is the node after the ack or report. Undefined: none owed.
 */
export function replyOwed(
  prev: ProgressEntry | undefined,
  next: ProgressEntry,
  t: number,
): { key: string; state: ReplyState; min?: number } | undefined {
  if (!prev) return undefined;
  const key = reminderKey(prev);
  if (!key || prev.replyFor === key) return undefined;
  // A blocked node re-reported unchanged is still waiting: nothing to answer yet.
  if (key.startsWith("nudge:") && nudgeKey(next) === prev.nudgeFor) return undefined;
  if (next.status === "done") return { key, state: "done" };
  if (next.etaAt !== undefined && next.etaAt > t)
    return { key, state: "doing", min: Math.max(1, Math.ceil((next.etaAt - t) / 60_000)) };
  return { key, state: "ack" };
}

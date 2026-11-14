/**
 * The chat log's avatars, the pure part (Avatar.tsx draws them): which
 * pictures to try for a line, in what order, and what shows after each
 * failure. No React at runtime, so the unit tests and other hosts can use it.
 */
import type { ReactNode } from "react";
import type { ChatMessage, Sender } from "./wire";
import { LANES, type LaneId, isLaneId } from "./voices";

/**
 * What an avatar shows: picture URLs in fallback order (each that fails to
 * load falls through to the next), or an element (the host app's logo as a
 * component). Nothing, or every URL failing, shows the initial.
 */
export type AvatarSource = string | readonly string[] | ReactNode;

/** The URLs to try, in order, from an AvatarSource (an element has none). */
export function avatarSrcs(src: AvatarSource): string[] {
  if (typeof src === "string") return src ? [src] : [];
  if (Array.isArray(src)) return src.filter((u): u is string => typeof u === "string" && !!u);
  return [];
}

/**
 * What an avatar shows after `failed` of its pictures failed to load: the
 * next picture, then the element (if any), then the initial.
 */
export function avatarView(
  srcs: readonly string[],
  failed: number,
  hasNode: boolean,
): { kind: "img"; src: string } | { kind: "node" } | { kind: "initial" } {
  if (failed < srcs.length) return { kind: "img", src: srcs[failed] };
  return hasNode ? { kind: "node" } : { kind: "initial" };
}

/** Who a log line is from, as its avatar draws it. */
export type LineAvatar = {
  src?: AvatarSource;
  /** The alt text and sr-only name: the sender's name, or "you". */
  name: string;
  /** Whose initial the fallback shows (the viewer's own name on "you" lines). */
  initialFrom: string;
  seed: string;
  mine: boolean;
  /** The voiceprint could not decide (a short or soft sentence): drawn as him, faded, with a "?". */
  unsure?: boolean;
};

/**
 * A log line's avatar. The agent's is the host app's logo (`agentAvatar`)
 * named by its assignee id (`agentId`), else its label. Anyone else's comes from `avatarFor` (the host's
 * resolver), else the line's `sender`; the viewer's own lines (owner lines
 * on the owner's page, friend lines on a friend's) fill the gaps from
 * `viewer` and are named "you". The fallback colour's seed is the sender's
 * hashed id, else the thread, never an email. An owner line in another voice
 * (SpeakerTag.voice) gets that voice's own avatar instead (`voiceAvatar`).
 */
export function lineAvatar(
  m: ChatMessage,
  opts: {
    friend?: boolean;
    viewer?: Sender;
    agentAvatar?: AvatarSource;
    avatarFor?: (m: ChatMessage) => Sender | undefined;
    /** The agent's fallback name (the host's localized feature name). */
    agentName?: string;
    /** The viewer's own name on their lines, localized. */
    you?: string;
    /** A lane's own mark (LaneMark.tsx laneAvatar); undefined = the agent's avatar. */
    laneAvatar?: (lane: LaneId) => AvatarSource | undefined;
    /** Any other token agent's picture (LaneMark.tsx agentAvatar): its own SVG, else the generated mark. */
    tokenAvatar?: (p: { name: string; avatar?: string }) => AvatarSource | undefined;
    /** Who is here (presence.ts), by token tag: the owner's name and picture for it win. */
    participant?: (tok: string) => { name: string; avatar?: string } | undefined;
    /** Another voice's avatar (LaneMark.tsx voiceAvatar, from speaker-avatar.ts); undefined = its initial. */
    voiceAvatar?: (voice: string) => AvatarSource | undefined;
    /** What that avatar is called (localized): "Another voice". */
    otherVoice?: string;
  },
): LineAvatar {
  // A lane with a mark of its own (voices.ts LANES): its mark and name.
  const lane = m.from === "agent" && isLaneId(m.lane) ? LANES[m.lane] : null;
  if (lane?.mark && lane.name) {
    // Without the drawn mark (another host): its initial on its own colour, never the agent's logo.
    const src = opts.laneAvatar?.(m.lane!);
    return { src, name: lane.name, initialFrom: lane.name, seed: `lane:${m.lane}`, mine: false };
  }
  // Any other API-token agent: its (owner-given) name, its own picture or the generated one.
  if (m.from === "agent" && m.via === "token" && !lane?.mark) {
    const p = m.tok ? opts.participant?.(m.tok) : undefined;
    const name = p?.name || m.tokenLane || m.label || "agent";
    const avatar = p ? p.avatar : m.avatar;
    return {
      src: opts.tokenAvatar?.({ name, ...(avatar ? { avatar } : {}) }),
      name,
      initialFrom: name,
      seed: `tok:${m.tok ?? name}`,
      mine: false,
    };
  }
  if (m.from === "agent") {
    // The node's assignee, when the line names one; else the controller's label.
    const name = m.agentId || m.label || opts.agentName || "agent";
    return { src: opts.agentAvatar, name, initialFrom: name, seed: `agent:${name}`, mine: false };
  }
  const mine = m.from === (opts.friend ? "friend" : "owner");
  // An owner's voice line spoken by someone else (docs/voice-mode.md, "Speaker
  // avatars"): that voice's own disc, named "another voice", seeded by its id, so
  // two people's lines fall into runs of their own. Only with a voiceprint enrolled
  // (the Mac sets no `voice` without one), and never on "me".
  // Only a line the voiceprint *decided* was someone else: an "unknown" one (a
  // short or soft sentence of his own, under the line) keeps his avatar, marked
  // unsure (owner, 2026-11-14 23:1x: "我的头像怎么变成S了").
  const voice = m.from === "owner" ? m.speaker?.voice : undefined;
  if (voice && voice !== "me" && m.speaker?.decision === "other") {
    const name = opts.otherVoice || "another voice";
    return { src: opts.voiceAvatar?.(voice), name, initialFrom: name, seed: `voice:${voice}`, mine };
  }
  const unsure = m.from === "owner" && m.speaker?.decision === "unknown" ? true : undefined;
  const own = opts.avatarFor?.(m);
  const s: Sender = { ...(mine ? opts.viewer : undefined), ...m.sender, ...own };
  // The host's resolver first; then, on the viewer's own lines, the viewer's
  // current pictures (fresher than the ones stored with an old line).
  const avatars = [
    ...(own?.avatars ?? []),
    ...(mine ? (opts.viewer?.avatars ?? []) : []),
    ...(m.sender?.avatars ?? []),
  ];
  const name = s.name || (m.from === "friend" ? "friend" : "owner");
  return {
    src: [...new Set(avatars)],
    name: mine ? opts.you || "you" : name,
    initialFrom: name,
    seed: s.id || m.thread || m.from,
    mine,
    ...(unsure ? { unsure } : {}),
  };
}

/** The runs themselves (from runStarts): each run's message indexes, in order. */
export function runsOf(starts: readonly boolean[]): number[][] {
  const out: number[][] = [];
  starts.forEach((start, i) => {
    if (start || !out.length) out.push([i]);
    else out[out.length - 1]!.push(i);
  });
  return out;
}

/** A pause this long between two lines starts a new run, avatar and all. */
export const RUN_GAP_MS = 5 * 60_000;

/**
 * Avatar grouping: which lines open a run of consecutive lines from the same
 * sender (the same avatar seed, the same state-tree node, no long pause) and
 * so show the avatar. The rest of the run shows none, only its indent. The
 * first line, not the last: the log reads top down, avatar then text, so
 * the avatar introduces the speaker (as Slack does); iMessage's last-line
 * avatar belongs to bubbles anchored at the bottom.
 */
export function runStarts(
  lines: readonly { seed: string; node?: string; at: number }[],
  gapMs = RUN_GAP_MS,
): boolean[] {
  return lines.map((l, i) => {
    const p = lines[i - 1];
    return !p || p.seed !== l.seed || p.node !== l.node || Math.abs(l.at - p.at) > gapMs;
  });
}

/** Whether a chat message was recognized as spoken by someone other than the owner. */
export function isOtherVoice(m: Pick<ChatMessage, "from" | "speaker">): boolean {
  if (m.from !== "owner") return false;
  // Only a decided "other": an "unknown" line (his own, under the line) is not someone else.
  return m.speaker?.decision === "other";
}

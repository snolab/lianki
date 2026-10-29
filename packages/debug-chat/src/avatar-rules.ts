/**
 * The chat log's avatars, the pure part (Avatar.tsx draws them): which
 * pictures to try for a line, in what order, and what shows after each
 * failure. No React at runtime, so the unit tests and other hosts can use it.
 */
import type { ReactNode } from "react";
import type { ChatMessage, Sender } from "./wire";

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
};

/**
 * A log line's avatar. The agent's is the host app's logo (`agentAvatar`)
 * named by its assignee id (`agentId`), else its label. Anyone else's comes from `avatarFor` (the host's
 * resolver), else the line's `sender`; the viewer's own lines (owner lines
 * on the owner's page, friend lines on a friend's) fill the gaps from
 * `viewer` and are named "you". The fallback colour's seed is the sender's
 * hashed id, else the thread, never an email.
 */
export function lineAvatar(
  m: ChatMessage,
  opts: {
    friend?: boolean;
    viewer?: Sender;
    agentAvatar?: AvatarSource;
    avatarFor?: (m: ChatMessage) => Sender | undefined;
  },
): LineAvatar {
  if (m.from === "agent") {
    // The node's assignee, when the line names one; else the controller's label.
    const name = m.agentId || m.label || "agent";
    return { src: opts.agentAvatar, name, initialFrom: name, seed: `agent:${name}`, mine: false };
  }
  const mine = m.from === (opts.friend ? "friend" : "owner");
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
    name: mine ? "you" : name,
    initialFrom: name,
    seed: s.id || m.thread || m.from,
    mine,
  };
}

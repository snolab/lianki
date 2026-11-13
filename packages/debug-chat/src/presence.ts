/**
 * Who is in a chat thread (docs/dev-debug-widget.md, "Who is here"): the
 * pure part, shared by the hub (workers/push/src/debug.ts builds the list and
 * pushes it to the thread's pages on every join, leave, post and expiry) and
 * the page (PresenceStack.tsx draws it right of the connection chip).
 *
 * Present: an API token with a listening socket open (`lianki chat listen`,
 * an MCP wait), a token that read the thread within the read window, and
 * anyone whose agent line is within the recent-speaker window. Both windows
 * are live config (lib/config.ts chat.presenceReadMin, chat.presenceSpeakerMin).
 */
import { LANES, type LaneId, isLaneId, laneOf } from "./voices";
import type { ChatMessage } from "./wire";

/** One participant, as a page gets it. */
export type Present = {
  /** "lane:codex", "tok:<tag>", "agent:<name>": one entry per participant. */
  key: string;
  /** The name shown: the owner's name for it, else the token's name (or the lane's). */
  name: string;
  /** A known lane (voices.ts LANES): its mark. */
  lane?: LaneId;
  /** A token's short tag: lines carry it (`tok`), so their avatar and name follow this entry. */
  tok?: string;
  /**
   * The token's id (its SHA-256, as /my/preferences lists it): only on the
   * pages of the account that owns the token, which may manage it.
   */
  id?: string;
  /** The custom avatar in effect (svg-avatar.ts reference); absent = the generated mark. */
  avatar?: string;
  /** Who chose what is in effect: the owner, the agent itself, or nobody (the token's name, the generated mark). */
  nameBy?: "owner";
  avatarBy?: "owner" | "agent";
  /** The token's own name (when the owner renamed it). */
  selfName?: string;
  /** Came through an MCP client: the "MCP" badge. */
  mcp?: true;
  /** Reading right now (a socket open). */
  live?: true;
  /** Since when it has been here (socket opened, or first read in the window). */
  since?: number;
  /** Its last read, and its last line. */
  seenAt?: number;
  postAt?: number;
  /** The latest of since/seenAt/postAt: the order (most recent first). */
  active: number;
};

/** What the hub keeps per token (`part:<tag>` in its storage). */
export type PartRecord = {
  tag: string;
  id: string;
  userId: string;
  thread: string;
  /** The token's own name (its lane). */
  lane: string;
  mcp?: true;
  /** The agent's own avatar (`lianki chat avatar`), a reference. */
  self?: string;
  /** The owner's choices; they win over the agent's. `ownerAvatar: "auto"` = the generated mark. */
  ownerName?: string;
  ownerAvatar?: string;
  /** First seen in the current stay, and the last read (HTTP read/wait). */
  since?: number;
  seenAt?: number;
  /** Its token was revoked: never listed again, its old lines left out too. */
  revoked?: true;
};

/** The name and avatar in effect for a token record. */
export function effective(r: PartRecord): Pick<Present, "name" | "avatar" | "nameBy" | "avatarBy" | "selfName"> {
  const avatar =
    r.ownerAvatar === "auto" ? undefined : (r.ownerAvatar ?? r.self);
  return {
    name: r.ownerName || r.lane,
    ...(r.ownerName ? { nameBy: "owner" as const, selfName: r.lane } : {}),
    ...(avatar ? { avatar } : {}),
    ...(r.ownerAvatar
      ? { avatarBy: "owner" as const }
      : r.self
        ? { avatarBy: "agent" as const }
        : {}),
  };
}

const known = (name: string): LaneId | null => laneOf({ text: `【${name}】` }).lane;

/** A line's participant key (the same as its token's, when it has one). */
export function lineKey(m: ChatMessage): string | null {
  if (m.from !== "agent") return null;
  const lane = isLaneId(m.lane) ? m.lane : m.via === "token" ? null : laneOf(m).lane;
  if (lane) return `lane:${lane}`;
  if (m.via === "token") return m.tok ? `tok:${m.tok}` : `agent:${m.tokenLane ?? m.label}`;
  return "lane:main";
}

/**
 * The thread's participants, most recently active first. `live`: the token
 * sockets open in it; `records`: the tokens seen in it; `lines`: its recent
 * history. `viewer`: the account whose page this goes to (token ids only for
 * its own tokens). `mainName`: the name for main's lines (the host's agent).
 */
export function presentList(p: {
  now: number;
  readMs: number;
  speakerMs: number;
  live: readonly { tag: string; at: number }[];
  records: readonly PartRecord[];
  lines: readonly ChatMessage[];
  viewer?: string;
  mainName?: string;
}): Present[] {
  const out = new Map<string, Present>();
  const rec = new Map(p.records.map((r) => [r.tag, r]));
  const liveAt = new Map<string, number>();
  for (const l of p.live) liveAt.set(l.tag, Math.min(liveAt.get(l.tag) ?? l.at, l.at));
  const tokenKey = (r: PartRecord) => {
    const k = known(r.lane);
    return k ? `lane:${k}` : `tok:${r.tag}`;
  };
  const fromRecord = (r: PartRecord): Present => {
    const lane = known(r.lane);
    return {
      key: tokenKey(r),
      ...effective(r),
      ...(lane ? { lane } : {}),
      tok: r.tag,
      ...(p.viewer && p.viewer === r.userId ? { id: r.id } : {}),
      ...(r.mcp ? { mcp: true as const } : {}),
      active: 0,
    };
  };
  const touch = (e: Present) => {
    e.active = Math.max(e.since ?? 0, e.seenAt ?? 0, e.postAt ?? 0);
    out.set(e.key, e);
  };
  // Open sockets and recent reads.
  for (const r of p.records) {
    if (r.revoked) continue;
    const at = liveAt.get(r.tag);
    const read = r.seenAt !== undefined && p.now - r.seenAt < p.readMs;
    if (at === undefined && !read) continue;
    const e = out.get(tokenKey(r)) ?? fromRecord(r);
    if (at !== undefined) {
      e.live = true;
      e.since = Math.min(e.since ?? at, r.since ?? at, at);
    } else if (r.since !== undefined) e.since = Math.min(e.since ?? r.since, r.since);
    if (r.seenAt !== undefined) e.seenAt = Math.max(e.seenAt ?? 0, r.seenAt);
    touch(e);
  }
  // Recent speakers (newest line wins the post time).
  for (const m of p.lines) {
    if (p.now - m.at >= p.speakerMs) continue;
    if (m.tok && rec.get(m.tok)?.revoked) continue;
    const key = lineKey(m);
    if (!key) continue;
    let e = out.get(key);
    if (!e) {
      const r = m.tok ? rec.get(m.tok) : undefined;
      if (r && tokenKey(r) === key) e = fromRecord(r);
      else {
        const lane = key.startsWith("lane:") ? (key.slice(5) as LaneId) : undefined;
        e = {
          key,
          name: lane ? LANES[lane].name || p.mainName || "" : (m.tokenLane ?? m.label),
          ...(lane ? { lane } : {}),
          ...(m.tok ? { tok: m.tok } : {}),
          ...(m.avatar ? { avatar: m.avatar, avatarBy: "agent" as const } : {}),
          ...(m.client === "mcp" ? { mcp: true as const } : {}),
          active: 0,
        };
      }
    }
    e.postAt = Math.max(e.postAt ?? 0, m.at);
    if (m.client === "mcp") e.mcp = true;
    touch(e);
  }
  return [...out.values()].sort((a, b) => b.active - a.active || a.key.localeCompare(b.key));
}

/**
 * When the list next changes by time alone (a read or a line leaving its
 * window), or null: the hub sets its alarm for it, so a leave is pushed
 * without anyone polling.
 */
export function nextExpiry(p: {
  now: number;
  readMs: number;
  speakerMs: number;
  records: readonly PartRecord[];
  lines: readonly ChatMessage[];
}): number | null {
  let next = Number.POSITIVE_INFINITY;
  for (const r of p.records)
    if (r.seenAt !== undefined && r.seenAt + p.readMs > p.now) next = Math.min(next, r.seenAt + p.readMs);
  for (const m of p.lines)
    if (m.from === "agent" && m.at + p.speakerMs > p.now) next = Math.min(next, m.at + p.speakerMs);
  return Number.isFinite(next) ? next : null;
}

/** The stack's split: the first `shown` (most recent first) and how many more ("+N"). */
export function stackOf<T>(list: readonly T[], shown: number): { shown: T[]; more: number } {
  const n = Math.max(0, Math.floor(shown));
  return { shown: list.slice(0, n), more: Math.max(0, list.length - n) };
}

/** The hover / single-tap summary: "agy, codex, mcp-bot +2". */
export function presenceSummary(list: readonly Pick<Present, "name">[], shown: number): string {
  const { shown: s, more } = stackOf(list, shown);
  const names = s.map((x) => x.name || "agent").join(", ");
  return more ? `${names} +${more}` : names;
}

/** Is this a well-formed presence list from the hub? Anything else is dropped. */
export function parsePresent(raw: unknown): Present[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Present[] = [];
  for (const x of raw.slice(0, 100)) {
    if (!x || typeof x !== "object") continue;
    const e = x as Record<string, unknown>;
    if (typeof e.key !== "string" || typeof e.name !== "string" || typeof e.active !== "number")
      continue;
    out.push(e as unknown as Present);
  }
  return out;
}

/** A name the owner gives a participant: 1–40 characters, no brackets of a lane prefix, no control characters. */
export function cleanPartName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // oxlint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f【】<>]/g, "").trim();
  if (!s || [...s].length > 40) return null;
  return s;
}

// --- Invite --------------------------------------------------------------------

/** The token form, prefilled for a chat-only agent (TokenManager reads it; it never makes a token by itself). */
export const INVITE_QUERY = "new-token";
export const INVITE_HREF = `/my/preferences?${INVITE_QUERY}=chat-agent#api-tokens`;
/** What the prefill puts in the form: a name, the three chat permissions, a short expiry. */
export const INVITE_PREFILL = {
  name: "agent",
  scopes: ["chat:read", "chat:write", "chat:ask"] as const,
  days: 7,
};
/** The prefill a page URL asks for, or null. */
export function invitePrefill(search: string): typeof INVITE_PREFILL | null {
  return new URLSearchParams(search).get(INVITE_QUERY) === "chat-agent" ? INVITE_PREFILL : null;
}

/** How an agent connects with the token it is given (no token in it: a placeholder). */
export function mcpSnippet(origin = "https://lianki.com"): string {
  return [
    `MCP: ${origin}/mcp`,
    "Authorization: Bearer <token>",
    "",
    "LIANKI_TOKEN=<token> npx -y lianki mcp",
  ].join("\n");
}

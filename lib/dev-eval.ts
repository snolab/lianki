/**
 * Remote eval for the owner's debug session — the shared, pure pieces: the
 * debug hub (workers/push/src/debug.ts), the page (app/components/DebugEval.tsx)
 * and the sender (scripts/dev/eval.ts). Its only import is the chat widget's
 * wire types and UI helpers (packages/debug-chat/src/wire.ts, re-exported
 * here), by a relative path: the push Worker bundles it.
 *
 * Flow and security model: docs/monitoring.md, "Remote eval (owner debug)".
 */

import {
  MAX_CHAT,
  ROOT_NODE,
  agentIdOf,
  nodePath,
  type ChatMessage,
  type PageInfo,
  type PairInfo,
  type Scope,
  type MessageSource,
  type VoiceTiming,
  cleanTiming,
  type SpeakerTag,
  cleanSpeaker,
} from "../packages/debug-chat/src/wire";
import { type Ask, parseAsk } from "../packages/debug-chat/src/ask";
import { cleanProofs } from "./speaker-proof";
import { type WakeReason, isWakeReason } from "../packages/debug-chat/src/wake";

export {
  MAX_AGENT_ID,
  MAX_CHAT,
  MAX_NODE_PATH,
  ROOT_NODE,
  type NodeGrant,
  agentIdOf,
  commonAncestor,
  isWithin,
  lineNode,
  mayAddress,
  nodePath,
  parseAddress,
  pathLabel,
  routeTo,
  allowLabel,
  avatarUrl,
  hashId,
  senderOf,
  type Sender,
  pageParts,
  pairSentence,
  pickLang,
  pickVoice,
  type ChatMessage,
  type PageInfo,
  type PairInfo,
  type Scope,
  type MessageSource,
  type EditMark,
  type EditedEvent,
  MAX_EDITS,
  applyEdit,
  dictatedDraft,
  draftSource,
  type VoiceTiming,
  cleanTiming,
  type SpeakerTag,
  type SpeakerDecision,
  cleanSpeaker,
  combineSpeaker,
} from "../packages/debug-chat/src/wire";

/** Largest `code` accepted, in characters. */
export const MAX_CODE = 16 * 1024;
/** Largest result summary a page sends back, in characters. */
export const MAX_RESULT = 4000;
/**
 * A streamed result's piece (`$lk.send`, below): at most this many characters
 * of data per {type:"chunk"} message. A screenshot (scripts/dev/shot.ts) is a
 * few hundred KB to a few MB of base64, so it travels as several of these,
 * well under the runtime's WebSocket message limit.
 */
export const MAX_CHUNK = 128 * 1024;
/** Most chunks one streamed piece may be split into (MAX_CHUNK × this ≈ 32 MB). */
export const MAX_CHUNKS = 256;
/** Largest page or controller label, in characters. */
export const MAX_LABEL = 300;
/** How long the owner has to answer a pairing prompt. */
export const PENDING_MS = 2 * 60_000;
/** How long a friend's approved preview pairing may send code (one socket, no token). */
export const APPROVAL_MS = 60 * 60_000;
/**
 * How long the owner's "Allow" for eval lasts — and its resumable grant token:
 * the sender reconnects with it (x-debug-token) without a new prompt until
 * then, or until End revokes it.
 */
export const EVAL_GRANT_MS = 8 * 60 * 60_000;
/**
 * Auto-renewal of the owner's eval grant (docs/monitoring.md, "Renewal"): with
 * less than this left, a use of the grant (or the one alarm set for that
 * moment, or the approving page coming back) extends it by EVAL_GRANT_MS —
 * only while the owner's page on the device that approved it, signed in with
 * the same session, is connected.
 */
export const EVAL_RENEW_BEFORE_MS = 2 * 60 * 60_000;
/** A renewal chain ends this long after the tap that started it: then a new tap. */
export const EVAL_CHAIN_MS = 30 * 24 * 60 * 60_000;
/** How long "Allow chat" lasts — and its resumable grant token. */
export const CHAT_MS = 30 * 24 * 60 * 60_000;
/** Chat messages the hub keeps per thread (and sends a page on connect). */
export const CHAT_HISTORY = 200;
/** A friend may send at most FRIEND_CHAT_MAX messages per FRIEND_CHAT_WINDOW_MS. */
export const FRIEND_CHAT_MAX = 30;
export const FRIEND_CHAT_WINDOW_MS = 10 * 60_000;
/** The owner's chat thread; every other thread is a friend's user id. */
export const OWNER_THREAD = "owner";
/** The "agent is working" spinner stops this long after the last heartbeat. */
export const BUSY_MS = 12_000;
/**
 * A beat the hub stamped within this long after an agent reply in the same
 * thread is the beat loop's last one, still in flight when the reply landed:
 * it does not restart the spinner.
 */
export const BUSY_GRACE_MS = 1_500;

/**
 * Who a debug page belongs to, as the main Worker's /api/debug/identity says.
 * The owner's pages see the owner thread and owner pairings; anyone else
 * signed in is a "friend": their own thread, and only pairings made for them.
 */
export type Identity = {
  userId: string;
  email: string;
  owner: boolean;
  /** Display name and picture URL (better-auth's user.name / user.image), when known: the chat's avatars. */
  name?: string;
  image?: string;
  /**
   * The sign-in session: sessionTag(session id), never the id or its token,
   * and when it expires (ms). Binds an eval grant's renewal to it.
   */
  session?: string;
  sessionUntil?: number;
};

/** A sign-in session as the debug hub knows it: a SHA-256 of its id, never the id itself. */
export async function sessionTag(sessionId: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`lianki-debug-session:${sessionId}`),
  );
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}
/** A session tag as sessionTag makes it. */
export const isSessionTag = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** A user id usable as a thread and a storage key: no separators, bounded. */
export const isUserId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) && v !== OWNER_THREAD;

/** A friend who has used the chat, as the hub keeps it (`friend:<userId>`). */
export type FriendRecord = {
  email: string;
  /** First message, epoch ms. */
  firstSeen: number;
  /** Latest message, epoch ms. */
  lastAt: number;
  count: number;
  blocked?: boolean;
  blockedAt?: number;
};

/** Messages a controller (the sender CLI) may send to the hub. */
export type ControllerMessage =
  | { type: "eval"; code: string; target?: string }
  /** An ask card (ask.ts): `to` a thread as for say (absent = the owner's). */
  | { type: "ask"; ask: Ask; to?: string }
  /**
   * `to`: a friend's thread (user id or email); `node`: a state-tree node to
   * address instead (a `to` starting with "/"). `taskPath`/`agentId`: the
   * sender's own node and its assignee (docs/dev-debug-widget.md, "Node paths").
   */
  | {
      type: "say";
      text: string;
      to?: string;
      node?: string;
      taskPath?: string;
      agentId?: string;
      /** `say --quiet`: shown, never read aloud. */
      quiet?: true;
    }
  | { type: "busy"; to?: string; label?: string }
  /**
   * The mic's wake-word mode on that thread's pages (docs/wake-word.md):
   * "passive" waits for "Linky", "active" hears everything, "ignored" says
   * the last line was not for the agent (one rejection towards passive).
   * Relayed like a heartbeat: not stored, not shown.
   */
  | { type: "wake"; mode: "active" | "passive" | "ignored"; to?: string }
  /**
   * Polish the owner's latest line, when it came from the widget's mic
   * (`source: "stt"`): docs/dev-debug-widget.md, "Agent edits of voice messages".
   */
  | { type: "edit"; id: string; text: string }
  /**
   * Let senders within node `from` address nodes within `to` for `ms` (the
   * fallback for a scoped grant token): only a listener whose node holds both.
   */
  | { type: "grant"; from: string; to: string; ms?: number }
  | { type: "ungrant"; from: string; to: string };
/** Messages an owner page may send to the hub. */
export type PageMessage =
  /** A tap on an ask card: which options, per question. The hub stamps the rest. */
  | { type: "answer"; askId: string; choices: Record<string, unknown> }
  /**
   * `pages`: the page ids the grant covers, or "all" (also every page that
   * connects later). Absent (a page from before) = "all". `scope` is the old
   * page's choice; the requester's own scope is what counts now.
   */
  | { type: "allow"; pair: string; scope?: "chat"; pages?: string[] | "all" }
  | { type: "deny" | "revoke"; pair: string }
  /** `to`: the state-tree node it is addressed to (absent = the main thread). */
  /** `source: "stt"`: sent from the widget's mic, unchanged (absent = typed). */
  /** `timing`: a voice line's timestamps (VoiceTiming), kept on the stored line. */
  | {
      type: "chat";
      id: string;
      text: string;
      to?: string;
      source?: MessageSource;
      timing?: VoiceTiming;
      /** The mic's wake-word mode when the line was sent (docs/wake-word.md); absent = mic off. */
      wake?: "active" | "passive";
      /**
       * The Mac's signed speaker attestations for a voice line's finals
       * (lib/speaker-proof.ts). The hub verifies them; a page-made tag is never taken.
       */
      speakerProof?: string[];
      /** Why the mic is in that mode (wake.ts WakeReason: "rejects", "wake-word", "kws-failed", …). */
      wakeReason?: WakeReason;
    }
  /** The page moved (client-side navigation): its new label. Never shown in the chat. */
  | { type: "page"; label: string }
  /** Close another (or this) page of the same audience, from the chat's menu. */
  | { type: "end-page"; id: string }
  /**
   * One piece of a streamed result (`$lk.send(data)` in the eval code):
   * piece `part` of the eval `id`, split into `total` chunks; this is `seq`.
   * Forwarded to the controller like a result; the sender reassembles it.
   */
  | {
      type: "chunk";
      id: string;
      to: string;
      part: number;
      seq: number;
      total: number;
      data: string;
    }
  | {
      type: "result";
      id: string;
      to: string;
      ok: boolean;
      value?: string;
      error?: string;
      stack?: string;
      ms?: number;
    }
  | PageErrorMessage;

/**
 * Page errors (docs/dev-debug-widget.md, "Page errors"): an owner page's
 * uncaught error, rejection, console.error, failed /api call, or media load
 * failure, scrubbed on the page (packages/debug-chat/src/page-errors.ts).
 * The hub forwards it to the owner-approved listeners only; never stored.
 */
export const PAGE_ERROR_KINDS = [
  "error",
  "rejection",
  "console",
  "fetch",
  "network",
  "media",
  "socket",
] as const;
export type PageErrorKind = (typeof PAGE_ERROR_KINDS)[number];
export const PAGE_ERROR_MAX_MESSAGE = 500;
export const PAGE_ERROR_MAX_STACK = 1500;
export type PageErrorMessage = {
  type: "page-error";
  kind: PageErrorKind;
  message: string;
  stack?: string;
  /** The page's path (or the failed request's), never a query. */
  path: string;
  status?: number;
  at: number;
  rev?: string;
};

/** A page id: the tab's own (sessionStorage), so a reload keeps its grants. */
export const isPageId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{6,40}$/.test(v);
/**
 * `listeners`: owner-approved controllers in time (the agent hearing the
 * chat), never heartbeat-only sockets (`busy --every`). `pages`: this
 * audience's open debug pages; `self`: the receiver's id. `pending` and
 * `sessions` are only the pairings made for this page's audience — the
 * owner's, or this friend's own.
 */
export type HubState = {
  type: "state";
  pending: PairInfo | null;
  sessions: PairInfo[];
  listeners?: number;
  /** This audience's open debug pages (the owner's, or this friend's own). */
  pages?: PageInfo[];
  /** Which of `pages` is the one receiving this state. */
  self?: string;
  /** The state-tree nodes listeners are subscribed at (never "/"), for "@/…" completions. */
  nodes?: string[];
};
/** Close code for a page ended from the chat menu; it stays closed until its next visibility or debug event. */
export const PAGE_ENDED = 4410;
/**
 * An eval pairing granted for some pages only lives on while they are away
 * (a phone drops its socket when the app is in the background) — until they
 * have been gone this long; then it is closed with PAGES_GONE, to pair again.
 */
export const PAGE_GONE_GRACE_MS = 5 * 60_000;
export const PAGES_GONE = 4409;
/**
 * A thread with no open page for this long is "idle": the hub tells the
 * agent ({type:"pages-idle"}) and closes its heartbeat sockets for it. Long
 * enough to cover a reload or a navigation.
 */
export const PAGES_IDLE_MS = 60_000;
/** Close code for a heartbeat socket whose thread went idle. */
export const PAGES_IDLE = 4411;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

/** The largest raw message, in characters: a chunk's data may be escaped (\u00xx) in JSON. */
const MAX_RAW = MAX_CODE + 2048;
const MAX_CHUNK_RAW = MAX_CHUNK * 6 + 1024;

function parse(raw: unknown, max = MAX_RAW): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length > max) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Validate a controller's message; anything else is dropped. */
export function parseControllerMessage(
  raw: unknown,
): { ok: true; value: ControllerMessage } | { ok: false; error: string } {
  const m = parse(raw);
  if (m?.type === "say") {
    const text = chatText(m.text);
    if (!text) return { ok: false, error: `say needs text of 1–${MAX_CHAT} chars` };
    let to = str(m.to, 320)?.trim();
    // A `to` that is a path addresses a state-tree node; anything else is a thread.
    let node: string | undefined;
    if (to?.startsWith("/") || typeof m.node === "string") {
      node = nodePath(typeof m.node === "string" ? m.node : to);
      if (!node) return { ok: false, error: `not a node path: ${String(m.node ?? to)}` };
      if (to?.startsWith("/")) to = undefined;
      if (node === ROOT_NODE) node = undefined;
    }
    const taskPath = m.taskPath === undefined ? undefined : nodePath(m.taskPath);
    if (m.taskPath !== undefined && !taskPath)
      return { ok: false, error: `not a node path: ${String(m.taskPath)}` };
    const agentId = agentIdOf(m.agentId);
    // A boolean only, and only `true` is kept. An old `loud` is dropped: it means nothing now.
    const quiet = m.quiet === true;
    return {
      ok: true,
      value: {
        type: "say",
        text,
        ...(to ? { to } : {}),
        ...(node ? { node } : {}),
        ...(taskPath && taskPath !== ROOT_NODE ? { taskPath } : {}),
        ...(agentId ? { agentId } : {}),
        ...(quiet ? { quiet: true as const } : {}),
      },
    };
  }
  if (m?.type === "ask") {
    const r = parseAsk(m, Date.now(), () => crypto.randomUUID().slice(0, 12));
    if (!r.ok) return { ok: false, error: r.error };
    const to = str(m.to, 320)?.trim();
    return { ok: true, value: { type: "ask", ask: r.ask, ...(to ? { to } : {}) } };
  }
  // A tap is a person on a page: an agent or controller can never answer.
  if (m?.type === "answer")
    return {
      ok: false,
      error: "answers come only from a tap on a page; a controller cannot answer",
    };
  if (m?.type === "edit") {
    const id = str(m.id, 64)?.trim();
    if (!id) return { ok: false, error: "edit needs the id of the message to polish" };
    const text = chatText(m.text);
    if (!text) return { ok: false, error: `edit needs text of 1–${MAX_CHAT} chars` };
    return { ok: true, value: { type: "edit", id, text } };
  }
  if (m?.type === "grant" || m?.type === "ungrant") {
    const from = nodePath(m.from);
    const to = nodePath(m.to);
    if (!from || !to) return { ok: false, error: `${m.type} needs node paths "from" and "to"` };
    if (m.type === "ungrant") return { ok: true, value: { type: "ungrant", from, to } };
    const ms = typeof m.ms === "number" && m.ms > 0 ? Math.min(m.ms, CHAT_MS) : undefined;
    return { ok: true, value: { type: "grant", from, to, ...(ms ? { ms } : {}) } };
  }
  if (m?.type === "wake") {
    const mode = m.mode;
    if (mode !== "active" && mode !== "passive" && mode !== "ignored")
      return { ok: false, error: 'wake needs mode "active", "passive" or "ignored"' };
    const to = str(m.to, 320)?.trim();
    return { ok: true, value: { type: "wake", mode, ...(to ? { to } : {}) } };
  }
  if (m?.type === "busy") {
    const to = str(m.to, 320)?.trim();
    const label = cleanLabel(str(m.label, 80));
    return {
      ok: true,
      value: { type: "busy", ...(to ? { to } : {}), ...(label ? { label } : {}) },
    };
  }
  if (!m || m.type !== "eval")
    return {
      ok: false,
      error:
        'expected {"type":"eval","code":"…"}, {"type":"say","text":"…"}, {"type":"busy"}, {"type":"wake","mode"}, {"type":"edit","id","text"} or {"type":"grant","from","to"}',
    };
  if (typeof m.code !== "string" || !m.code.trim()) return { ok: false, error: "empty code" };
  if (m.code.length > MAX_CODE) return { ok: false, error: `code over ${MAX_CODE} chars` };
  const target = str(m.target, MAX_LABEL);
  return {
    ok: true,
    value: target ? { type: "eval", code: m.code, target } : { type: "eval", code: m.code },
  };
}

/** Validate an owner page's message; anything else is dropped. */
export function parsePageMessage(raw: unknown): PageMessage | null {
  const m = parse(raw, MAX_CHUNK_RAW);
  if (!m) return null;
  if (m.type === "chunk") return parseChunk(m);
  // Only a chunk may be that large.
  if ((raw as string).length > MAX_RAW) return null;
  if (m.type === "allow") {
    const pair = str(m.pair, 64);
    if (!pair) return null;
    const pages =
      m.pages === "all"
        ? "all"
        : Array.isArray(m.pages)
          ? m.pages.filter(isPageId).slice(0, 50)
          : undefined;
    return {
      type: "allow",
      pair,
      ...(m.scope === "chat" ? { scope: "chat" as const } : {}),
      ...(pages ? { pages } : {}),
    };
  }
  if (m.type === "deny" || m.type === "revoke") {
    const pair = str(m.pair, 64);
    return pair ? { type: m.type, pair } : null;
  }
  if (m.type === "end-page") {
    const id = str(m.id, 64);
    return id ? { type: "end-page", id } : null;
  }
  if (m.type === "page") {
    const label = cleanLabel(str(m.label, MAX_LABEL * 2));
    return label ? { type: "page", label } : null;
  }
  if (m.type === "answer") {
    const askId = str(m.askId, 64);
    if (!askId || !m.choices || typeof m.choices !== "object" || Array.isArray(m.choices))
      return null;
    return { type: "answer", askId, choices: m.choices as Record<string, unknown> };
  }
  if (m.type === "chat") {
    const id = str(m.id, 64);
    const text = chatText(m.text);
    if (!id || !text) return null;
    // An address that is not a node path is dropped: the line goes to the main thread.
    const to = nodePath(m.to);
    const timing = m.source === "stt" ? cleanTiming(m.timing) : undefined;
    const speakerProof = m.source === "stt" ? cleanProofs(m.speakerProof) : undefined;
    return {
      type: "chat",
      id,
      text,
      ...(to && to !== ROOT_NODE ? { to } : {}),
      ...(m.source === "stt" ? { source: "stt" as const } : {}),
      ...(timing ? { timing } : {}),
      ...(m.wake === "active" || m.wake === "passive" ? { wake: m.wake } : {}),
      ...(speakerProof ? { speakerProof } : {}),
      ...((m.wake === "active" || m.wake === "passive") && isWakeReason(m.wakeReason)
        ? { wakeReason: m.wakeReason }
        : {}),
    };
  }
  if (m.type === "page-error") return parsePageError(m);
  if (m.type === "result") {
    const id = str(m.id, 64);
    const to = str(m.to, 64);
    if (!id || !to) return null;
    return {
      type: "result",
      id,
      to,
      ok: m.ok === true,
      value: str(m.value, MAX_RESULT + 64),
      error: str(m.error, 1000),
      stack: str(m.stack, 2000),
      ms: typeof m.ms === "number" ? m.ms : undefined,
    };
  }
  return null;
}

/** A page-error as the hub forwards it: a known kind, bounded strings, a path with no query. */
function parsePageError(m: Record<string, unknown>): PageErrorMessage | null {
  const kind = PAGE_ERROR_KINDS.find((k) => k === m.kind);
  const message = str(m.message, PAGE_ERROR_MAX_MESSAGE)?.trim();
  if (!kind || !message) return null;
  const path = (str(m.path, 300) ?? "").split(/[?#]/)[0] || "/";
  const stack = str(m.stack, PAGE_ERROR_MAX_STACK);
  const status = count(m.status, 1000);
  const rev = str(m.rev, 64);
  return {
    type: "page-error",
    kind,
    message,
    ...(stack ? { stack } : {}),
    path,
    ...(status !== undefined ? { status } : {}),
    at: typeof m.at === "number" && Number.isFinite(m.at) ? m.at : 0,
    ...(rev ? { rev } : {}),
  };
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < max ? v : undefined;

function parseChunk(m: Record<string, unknown>): PageMessage | null {
  const id = str(m.id, 64);
  const to = str(m.to, 64);
  const part = count(m.part, 1_000_000);
  const total = count(m.total, MAX_CHUNKS + 1);
  const seq = count(m.seq, total ?? 0);
  if (!id || !to || part === undefined || !total || seq === undefined) return null;
  if (typeof m.data !== "string" || m.data.length > MAX_CHUNK) return null;
  return { type: "chunk", id, to, part, seq, total, data: m.data };
}

/**
 * The {type:"chunk"} messages that carry one streamed piece of eval `id`'s
 * result back to controller `to`: `data` cut into MAX_CHUNK-character
 * pieces (an empty string is one empty chunk). The page sends them in order.
 */
export function chunkMessages(
  id: string,
  to: string,
  part: number,
  data: string,
  size = MAX_CHUNK,
): Extract<PageMessage, { type: "chunk" }>[] {
  const total = Math.max(1, Math.ceil(data.length / size));
  if (total > MAX_CHUNKS) throw new Error(`too large to send: ${data.length} chars`);
  return Array.from({ length: total }, (_, seq) => ({
    type: "chunk" as const,
    id,
    to,
    part,
    seq,
    total,
    data: data.slice(seq * size, (seq + 1) * size),
  }));
}

/** A chat message's text: trimmed, non-empty, at most MAX_CHAT characters; else undefined. */
export function chatText(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t && t.length <= MAX_CHAT ? t : undefined;
}

/**
 * The page's view of the agent's heartbeat. `beatAt` is the hub's stamp on
 * the last beat and `agentAt` on the last agent reply (both hub clock, so they
 * compare); `seenAt` is when this page received the beat (its own clock, so
 * staleness never depends on clock skew).
 */
export type Heartbeat = { beatAt: number; seenAt: number };

/**
 * How much longer the "agent is working" spinner stays up, in ms; 0 = not
 * working. Up only while the socket is live, a beat arrived less than
 * BUSY_MS ago, and no agent reply has landed since that beat.
 */
export function busyLeft(
  live: boolean,
  beat: Heartbeat | null,
  agentAt: number,
  now: number,
): number {
  if (!live || !beat) return 0;
  if (beat.beatAt < agentAt + BUSY_GRACE_MS) return 0;
  return Math.max(0, BUSY_MS - (now - beat.seenAt));
}

/** The newest `max` messages, oldest first. */
export function trimHistory(list: ChatMessage[], max = CHAT_HISTORY): ChatMessage[] {
  return list.length > max ? list.slice(list.length - max) : list;
}

/** A label shown to the owner: one line, printable, bounded. */
export function cleanLabel(raw: string | null | undefined, max = MAX_LABEL): string {
  return (raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);
}

/** The short code the CLI prints and the prompt shows, so the owner can match them. */
export function shortCode(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 2), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A socket's label matches when there is no target, or it contains the target (any case). */
export function matchesTarget(label: string, target: string | undefined): boolean {
  if (!target) return true;
  return label.toLowerCase().includes(target.toLowerCase());
}

/**
 * A JSON-serialisable summary of whatever the code returned, at most `max`
 * characters: cycles, functions, DOM nodes, errors, Maps, Sets and BigInts
 * become readable strings instead of throwing.
 */
export function summarize(value: unknown, max = MAX_RESULT): string {
  const seen = new WeakSet<object>();
  let out: string | undefined;
  try {
    out = JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "bigint") return `${v}n`;
      if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
      if (typeof v === "symbol") return v.toString();
      if (v === undefined) return "[undefined]";
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
      if (typeof v === "object" && v !== null) {
        const node = v as { nodeType?: unknown; outerHTML?: unknown; nodeName?: unknown };
        if (typeof node.nodeType === "number")
          return typeof node.outerHTML === "string"
            ? node.outerHTML.slice(0, 500)
            : `[node ${String(node.nodeName)}]`;
        if (seen.has(v)) return "[circular]";
        seen.add(v);
        if (v instanceof Map) return { "[Map]": [...v.entries()] };
        if (v instanceof Set) return { "[Set]": [...v.values()] };
      }
      return v;
    });
  } catch (e) {
    out = `[unserialisable: ${e instanceof Error ? e.message : String(e)}]`;
  }
  out ??= "[undefined]";
  return out.length > max ? `${out.slice(0, max)}…[${out.length - max} more]` : out;
}

/**
 * What eval code sees as `$lk` (DebugEval passes it). `send(data)` streams
 * one piece back to the sender ahead of the result, in chunks of any size
 * the result itself could not carry (MAX_RESULT); it returns the piece's
 * number, 0, 1, 2… in this run.
 */
export type EvalContext = { send(data: string): number };

/**
 * Compile `code` as an async function of `$lk` (an EvalContext). An
 * expression (`document.title`) is returned as is; anything else is a
 * function body, so `return x` works and `await` is allowed in both.
 */
export function compile(code: string): ($lk?: EvalContext) => Promise<unknown> {
  type Fn = ($lk?: EvalContext) => Promise<unknown>;
  try {
    return new Function("$lk", `return (async () => (\n${code}\n))();`) as Fn;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return new Function("$lk", `return (async () => {\n${code}\n})();`) as Fn;
  }
}

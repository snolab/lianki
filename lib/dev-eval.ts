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
  type ChatMessage,
  type PageInfo,
  type PairInfo,
  type Scope,
} from "../packages/debug-chat/src/wire";

export {
  MAX_CHAT,
  allowLabel,
  pageParts,
  pairSentence,
  pickLang,
  pickVoice,
  type ChatMessage,
  type PageInfo,
  type PairInfo,
  type Scope,
} from "../packages/debug-chat/src/wire";

/** Largest `code` accepted, in characters. */
export const MAX_CODE = 16 * 1024;
/** Largest result summary a page sends back, in characters. */
export const MAX_RESULT = 4000;
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
export type Identity = { userId: string; email: string; owner: boolean };

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
  | { type: "say"; text: string; to?: string }
  | { type: "busy"; to?: string; label?: string };
/** Messages an owner page may send to the hub. */
export type PageMessage =
  /**
   * `pages`: the page ids the grant covers, or "all" (also every page that
   * connects later). Absent (a page from before) = "all". `scope` is the old
   * page's choice; the requester's own scope is what counts now.
   */
  | { type: "allow"; pair: string; scope?: "chat"; pages?: string[] | "all" }
  | { type: "deny" | "revoke"; pair: string }
  | { type: "chat"; id: string; text: string }
  /** The page moved (client-side navigation): its new label. Never shown in the chat. */
  | { type: "page"; label: string }
  /** Close another (or this) page of the same audience, from the chat's menu. */
  | { type: "end-page"; id: string }
  | {
      type: "result";
      id: string;
      to: string;
      ok: boolean;
      value?: string;
      error?: string;
      stack?: string;
      ms?: number;
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

function parse(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length > MAX_CODE + 2048) return null;
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
    const to = str(m.to, 320)?.trim();
    return { ok: true, value: to ? { type: "say", text, to } : { type: "say", text } };
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
      error: 'expected {"type":"eval","code":"…"}, {"type":"say","text":"…"} or {"type":"busy"}',
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
  const m = parse(raw);
  if (!m) return null;
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
  if (m.type === "chat") {
    const id = str(m.id, 64);
    const text = chatText(m.text);
    return id && text ? { type: "chat", id, text } : null;
  }
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
 * Compile `code` as an async function. An expression (`document.title`) is
 * returned as is; anything else is a function body, so `return x` works and
 * `await` is allowed in both.
 */
export function compile(code: string): () => Promise<unknown> {
  try {
    return new Function(`return (async () => (\n${code}\n))();`) as () => Promise<unknown>;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return new Function(`return (async () => {\n${code}\n})();`) as () => Promise<unknown>;
  }
}

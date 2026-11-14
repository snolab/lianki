/**
 * The chat's last lines on this device, so the Learning Partner paints at
 * once on a page load instead of after the hub's socket opens and sends its
 * history (docs/cold-start.md, "The chat at once").
 *
 * - One entry per device, under one account: `{account, at, lines}`. A read
 *   for any other account (or a signed-out page) never returns it, and drops it.
 * - Sign-out drops it (lib/sign-out.ts) and freezes writes for the rest of the
 *   page's life (`freezeChatCache`): the chat's queued write timer, or a hub line
 *   arriving while the sign-out request is in flight, must not put it back.
 * - A page rendered with no session drops it too; a page whose account changes
 *   under it starts over (lib/use-chat-cache.ts).
 * - Only what the chat shows and docs/chat-history.md keeps: each line passes
 *   `cacheLine`, an allowlist. Never the page context or screen text, STT before
 *   polish, page labels, avatars, emails, attachments, timings or speaker tags.
 * - The hub wins: its history replaces the cached lines (`reconcileHistory`).
 *
 * localStorage, not IndexedDB: it is read synchronously in the first render,
 * which is the point. A device cache, never synced (docs/ui-state.md).
 */
import type { ChatMessage, Sender } from "@/lib/dev-eval";

export const CHAT_CACHE_KEY = "lk:chat-cache";
/** Stored JSON larger than this drops its oldest lines first (localStorage is ~5 MB per origin). */
export const CHAT_CACHE_MAX_BYTES = 200_000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Entry = { v: 1; account: string; at: number; lines: ChatMessage[] };

/**
 * Set at sign-out: no write lands after it on this page (DebugEval stays mounted
 * through the sign-out request, with a write timer pending and the hub still
 * talking). The page is replaced at the end of sign-out, so it never thaws in
 * the browser; `thawChatCache` is for tests.
 */
let frozen = false;

const local = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** The sender as shown, without avatars (docs/chat-history.md: never kept). */
function cacheSender(s: Sender | undefined): Sender | undefined {
  if (!s || typeof s !== "object") return undefined;
  const out: Sender = {};
  if (typeof s.id === "string") out.id = s.id;
  if (typeof s.name === "string") out.name = s.name;
  return out.id || out.name ? out : undefined;
}

/**
 * One line as kept on the device: the fields the chat draws, and nothing
 * docs/chat-history.md says is never kept. `label` (the page path and user
 * agent) is emptied; an ask's answer loses its page label the same way.
 */
export function cacheLine(m: ChatMessage): ChatMessage {
  const out: ChatMessage = { id: m.id, from: m.from, label: "", text: m.text, at: m.at };
  const sender = cacheSender(m.sender);
  if (sender) out.sender = sender;
  if (m.thread !== undefined) out.thread = m.thread;
  if (m.via) out.via = m.via;
  if (m.tokenLane) out.tokenLane = m.tokenLane;
  if (m.taskPath) out.taskPath = m.taskPath;
  if (m.agentId) out.agentId = m.agentId;
  if (m.to) out.to = m.to;
  if (m.source) out.source = m.source;
  if (m.edited) out.edited = m.edited;
  if (m.summary) out.summary = m.summary;
  if (m.collapsedInto) out.collapsedInto = m.collapsedInto;
  if (m.passage) out.passage = m.passage;
  if (m.settled) out.settled = m.settled;
  if (m.quiet) out.quiet = m.quiet;
  if (m.lane) out.lane = m.lane;
  if (m.voice) out.voice = m.voice;
  if (m.ownerGrant) out.ownerGrant = m.ownerGrant;
  if (m.eta) out.eta = m.eta;
  if (m.ask) out.ask = m.ask;
  if (m.answer) out.answer = { ...m.answer, label: "" };
  return out;
}

const valid = (m: unknown): m is ChatMessage => {
  const x = m as ChatMessage | null;
  return (
    !!x &&
    typeof x === "object" &&
    typeof x.id === "string" &&
    typeof x.text === "string" &&
    typeof x.at === "number" &&
    (x.from === "owner" || x.from === "friend" || x.from === "agent")
  );
};

/** The lines cached for `account`, oldest first; [] for none, another account's (dropped), or no account. */
export function readChatCache(
  account: string | null | undefined,
  store: Store | null = local(),
): ChatMessage[] {
  if (!store) return [];
  try {
    const raw = store.getItem(CHAT_CACHE_KEY);
    if (!raw) return [];
    const e = JSON.parse(raw) as Partial<Entry> | null;
    if (!account || !e || e.account !== account || !Array.isArray(e.lines)) {
      // Another account's lines (or a signed-out page): never shown, not kept.
      store.removeItem(CHAT_CACHE_KEY);
      return [];
    }
    return e.lines.filter(valid);
  } catch {
    try {
      store.removeItem(CHAT_CACHE_KEY);
    } catch {}
    return [];
  }
}

/** Keep the newest `max` lines of `account`'s thread (0: keep nothing). Nothing once frozen. */
export function writeChatCache(
  account: string | null | undefined,
  lines: readonly ChatMessage[],
  max: number,
  store: Store | null = local(),
  now = Date.now(),
): void {
  if (!store || frozen) return;
  try {
    if (!account || !(max > 0)) return void store.removeItem(CHAT_CACHE_KEY);
    let kept = lines.slice(-Math.floor(max)).map(cacheLine);
    let json = JSON.stringify({ v: 1, account, at: now, lines: kept } satisfies Entry);
    while (json.length > CHAT_CACHE_MAX_BYTES && kept.length > 0) {
      kept = kept.slice(Math.max(1, Math.ceil(kept.length / 4)));
      json = JSON.stringify({ v: 1, account, at: now, lines: kept } satisfies Entry);
    }
    store.setItem(CHAT_CACHE_KEY, json);
  } catch {
    // Storage full or blocked (private mode): the chat waits for the hub as before.
  }
}

/** Forget the device's chat lines (sign-out, no session). */
export function clearChatCache(store: Store | null = local()): void {
  try {
    store?.removeItem(CHAT_CACHE_KEY);
  } catch {}
}

/**
 * Sign-out: forget the lines and refuse every later write on this page. Called
 * at the start of sign-out and again right before the page is replaced
 * (lib/sign-out.ts), so neither a pending write timer nor a hub line that
 * arrives in between leaves a copy behind.
 */
export function freezeChatCache(store: Store | null = local()): void {
  frozen = true;
  clearChatCache(store);
}

/** Sign-out has begun on this page: the chat schedules no more writes. */
export function chatCacheFrozen(): boolean {
  return frozen;
}

/** Tests only: a fresh page. */
export function thawChatCache(): void {
  frozen = false;
}

/**
 * The hub's history replacing the cached lines: the hub wins, so a cached
 * line it no longer has (deleted, out of its window) goes, and a line in both
 * is the hub's version. Duplicate ids in the hub's list keep their last copy,
 * in the place of the first.
 */
export function reconcileHistory(
  _cached: readonly ChatMessage[],
  hub: readonly ChatMessage[],
): ChatMessage[] {
  const last = new Map<string, ChatMessage>();
  for (const m of hub) last.set(m.id, m);
  const out: ChatMessage[] = [];
  const seen = new Set<string>();
  for (const m of hub) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(last.get(m.id)!);
  }
  return out;
}

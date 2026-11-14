/**
 * lianki.chat.* and lianki.ui.card for mini apps (docs/mini-apps.md,
 * "Capabilities"). The app never holds a token: for each say or card the
 * server mints a short-lived API token of the account's own (named after the
 * app, so the line reads 【app-calc】 and the token list shows it), scoped to
 * exactly that chat permission, calls lianki-push's token chat over the PUSH
 * binding (workers/push/src/token-chat.ts), and revokes it at once. A card
 * waits on a token socket for the tap (event-driven, no polling), at most
 * config miniApps.cardWaitMs. Reading is the account's own D1 chat history.
 */
import { type ScopeId, createToken, revokeToken } from "@/lib/api-tokens";
import type { D1Like } from "@/lib/d1/types";
import { type ChatLogDb, listHistory } from "@/lib/chat-log";
import { ASK_MAX_LABEL, ASK_MAX_OPTIONS, ASK_MAX_QUESTION } from "@lianki/debug-chat/ask";

export type ChatUser = { id: string; email: string };
export type ChatLine = { id: string; from: string; lane: string | null; text: string; at: number };
export type CardAsk = { title: string; options: string[] };

export type ChatPort = {
  read(u: ChatUser, limit: number): Promise<ChatLine[]>;
  say(u: ChatUser, lane: string, text: string): Promise<{ id: string } | { error: string }>;
  card(
    u: ChatUser,
    lane: string,
    ask: CardAsk,
    waitMs: number,
  ): Promise<{ choice: string | null } | { error: string }>;
};

export const SAY_MAX = 2000;
export const READ_MAX = 50;

/** A card as the app sent it: a title and 1–8 short option labels; else null. */
export function parseCard(raw: unknown): CardAsk | null {
  const r = raw as { title?: unknown; options?: unknown } | null;
  if (!r || typeof r.title !== "string") return null;
  const title = r.title.trim();
  if (!title || title.length > ASK_MAX_QUESTION) return null;
  if (!Array.isArray(r.options) || r.options.length < 1 || r.options.length > ASK_MAX_OPTIONS)
    return null;
  const options: string[] = [];
  for (const o of r.options) {
    if (typeof o !== "string" || !o.trim() || o.length > ASK_MAX_LABEL) return null;
    options.push(o.trim());
  }
  return { title, options };
}

/** The token's name and the line's lane: `app-<slug>`. */
export const laneOfApp = (slug: string) => `app-${slug}`.slice(0, 40);

type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };
/** The slice of a Workers WebSocket used here. */
export type PortSocket = {
  accept(): void;
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: "message" | "close", fn: (e: { data?: unknown }) => void): void;
};

const CHAT_URL = "https://lianki-push/api/version/chat";
const TOKEN_MS = 15 * 60_000;

export function pushChatPort(o: {
  db: D1Like;
  push: Fetcher | null;
  now?: () => number;
  /** Tell lianki-push a token is gone (lib/push-chat-tokens.ts); best effort. */
  revoked?: (ids: string[]) => Promise<void>;
}): ChatPort {
  const now = o.now ?? Date.now;
  async function withToken<T>(
    u: ChatUser,
    lane: string,
    scopes: ScopeId[],
    run: (token: string) => Promise<T>,
  ): Promise<T> {
    const owner = { userId: u.id, email: u.email };
    const t = await createToken(o.db, owner, {
      name: lane,
      scopes,
      expiresAt: new Date(now() + TOKEN_MS),
    });
    try {
      return await run(t.token);
    } finally {
      await revokeToken(o.db, owner, t.id);
      await o.revoked?.([t.id]).catch(() => {});
    }
  }
  const post = async (token: string, body: Record<string, unknown>) => {
    const res = await o.push!.fetch(CHAT_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      id?: string;
      askId?: string;
      error?: string;
    };
  };
  return {
    async read(u, limit) {
      const { lines } = await listHistory(o.db as unknown as ChatLogDb, u.id, {
        limit: Math.min(Math.max(1, limit), READ_MAX),
      });
      return lines.map((l) => ({ id: l.id, from: l.from, lane: l.lane, text: l.text, at: l.at }));
    },
    async say(u, lane, text) {
      if (!o.push) return { error: "chat-unavailable" };
      return withToken(u, lane, ["chat:write"], async (token) => {
        const r = await post(token, { op: "say", text });
        return r.ok && r.id ? { id: r.id } : { error: "chat-refused" };
      });
    },
    async card(u, lane, ask, waitMs) {
      if (!o.push) return { error: "chat-unavailable" };
      return withToken(u, lane, ["chat:read", "chat:ask"], async (token) => {
        const res = await o.push!.fetch(CHAT_URL, { headers: { upgrade: "websocket" } });
        const ws = (res as unknown as { webSocket?: PortSocket | null }).webSocket;
        if (!ws) return { error: "chat-unavailable" };
        ws.accept();
        return waitForTap(ws, token, waitMs, (r) =>
          post(token, {
            op: "ask",
            question: ask.title,
            options: ask.options,
            expiresAt: now() + waitMs,
          }).then(r),
        );
      });
    },
  };
}

/**
 * Listen on `ws` (authenticated with `token`); once the hub says ready, post
 * the ask; resolve with the tapped label of that ask, or null on timeout or close.
 */
export function waitForTap(
  ws: PortSocket,
  token: string,
  waitMs: number,
  postAsk: (then: (r: { askId?: string }) => string | undefined) => Promise<string | undefined>,
): Promise<{ choice: string | null } | { error: string }> {
  return new Promise((resolve) => {
    let askId: string | undefined;
    let done = false;
    const finish = (v: { choice: string | null } | { error: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close(1000);
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => finish({ choice: null }), waitMs);
    ws.addEventListener("close", () => finish({ choice: null }));
    ws.addEventListener("message", (e) => {
      let m: { type?: string; askId?: string; labels?: Record<string, string[]> };
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.type === "ready")
        void postAsk((r) => (askId = r.askId)).then((id) => {
          if (!id) finish({ error: "chat-refused" });
        });
      else if (m.type === "answered" && askId && m.askId === askId)
        finish({ choice: Object.values(m.labels ?? {})[0]?.[0] ?? null });
      else if (m.type === "error" || m.type === "revoked" || m.type === "expired")
        finish({ error: "chat-refused" });
    });
    ws.send(JSON.stringify({ type: "auth", token }));
  });
}

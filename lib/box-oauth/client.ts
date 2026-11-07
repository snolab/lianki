/**
 * The box's side of the flow, in the browser (docs/box-oauth.md). A public
 * client: no secret anywhere in the box. The tokens live in this tab's
 * sessionStorage, and every API call goes to the provider with
 * `credentials: "omit"`.
 */
import { BOX_AUTHORIZE_PATH, BOX_CALLBACK_PATH, BOX_CHAT_TICKET_PATH, boxHubUrl } from "./rules";

const PENDING = "lk:box:pending";
const TOKENS = "lk:box:tokens";

/** `hub`: the chat socket's URL, when it is not the provider's own (a local QA run only). */
export type BoxConfig = { clientId: string; provider: string; scope: string; hub?: string };
type Tokens = { access: string; refresh: string | null; until: number };

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

function readJson<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

const redirectUri = () => `${location.origin}${BOX_CALLBACK_PATH}`;

export async function startBoxSignIn(c: BoxConfig): Promise<void> {
  const verifier = random();
  const state = random();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: redirectUri(),
    scope: c.scope,
    state,
    code_challenge: b64url(new Uint8Array(digest)),
    code_challenge_method: "S256",
  });
  location.assign(`${c.provider}${BOX_AUTHORIZE_PATH}?${q}`);
}

function keep(body: { access_token?: string; refresh_token?: string; expires_in?: number }) {
  if (!body.access_token) throw new Error("no_token");
  const tokens: Tokens = {
    access: body.access_token,
    refresh: body.refresh_token ?? null,
    until: Date.now() + (body.expires_in ?? 0) * 1000,
  };
  sessionStorage.setItem(TOKENS, JSON.stringify(tokens));
}

const tokenRequest = (c: BoxConfig, form: Record<string, string>) =>
  nativeFetch()(`${c.provider}/api/auth/oauth2/token`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, ...form }),
  });

/** Back from lianki.com: checks the state, then trades the one-time code. Returns an error code or null. */
export async function finishBoxSignIn(
  c: BoxConfig,
  search: URLSearchParams,
): Promise<string | null> {
  const pending = readJson<{ verifier: string; state: string }>(PENDING);
  sessionStorage.removeItem(PENDING);
  const error = search.get("error");
  if (error) return error.slice(0, 80);
  const code = search.get("code");
  if (!pending || !code || search.get("state") !== pending.state) return "bad_state";
  const res = await tokenRequest(c, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: pending.verifier,
  });
  if (!res.ok) return `token_${res.status}`;
  keep(await res.json());
  return null;
}

/** Does this tab hold a box sign-in that can still be used (or refreshed)? */
export function hasBoxTokens(): boolean {
  const t = readJson<Tokens>(TOKENS);
  return Boolean(t && (t.refresh || t.until > Date.now()));
}

/** The provider refused the tokens: forget them, so /sign-in starts again. */
export function forgetBoxTokens(): void {
  try {
    sessionStorage.removeItem(TOKENS);
  } catch {}
}

let refreshing: Promise<boolean> | null = null;

async function refresh(c: BoxConfig): Promise<boolean> {
  const t = readJson<Tokens>(TOKENS);
  if (!t?.refresh) return false;
  refreshing ??= tokenRequest(c, { grant_type: "refresh_token", refresh_token: t.refresh })
    .then(async (res) => {
      if (!res.ok) return false;
      keep(await res.json());
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** Revokes this box's refresh token at the provider and forgets everything here. */
export async function boxSignOut(c: BoxConfig): Promise<void> {
  const t = readJson<Tokens>(TOKENS);
  sessionStorage.removeItem(TOKENS);
  if (!t?.refresh) return;
  await nativeFetch()(`${c.provider}/api/auth/oauth2/revoke`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, token: t.refresh }),
  }).catch(() => undefined);
}

let original: typeof fetch | null = null;
const nativeFetch = () => original ?? fetch.bind(globalThis);

/** Same-origin /api calls go to the provider with the token; /api/auth stays local and answers nothing. */
export function boxApiUrl(input: string, here: string): string | null {
  let u: URL;
  try {
    u = new URL(input, here);
  } catch {
    return null;
  }
  if (u.origin !== new URL(here).origin) return null;
  if (!u.pathname.startsWith("/api/") || u.pathname.startsWith("/api/auth")) return null;
  return `${u.pathname}${u.search}`;
}

let installed: BoxConfig | null = null;
/** This page load was refused a chat ticket (no box:chat): it does not ask again. */
let chatRefused = false;

export type BoxChatHub = {
  /** wss://lianki.com/api/version/debug */
  url: string;
  /** A fresh 60 s, single-use ticket for one socket, or null (no box:chat, signed out). */
  ticket: () => Promise<string | null>;
};

/**
 * The Learning Partner's hub on a box (docs/box-oauth.md, "Chat on the owner's
 * box"): null off a box, without a token, or once refused. DebugEval opens its
 * socket there with the ticket, in Sec-WebSocket-Protocol, never in the URL.
 */
export function boxChatHub(): BoxChatHub | null {
  const c = installed;
  if (!c || chatRefused || !hasBoxTokens()) return null;
  return {
    url: c.hub || boxHubUrl(c.provider),
    ticket: async () => {
      try {
        // Through the box's fetch: to lianki.com, with the token.
        const r = await fetch(BOX_CHAT_TICKET_PATH, { method: "POST" });
        if (r.status === 403 || r.status === 404) chatRefused = true;
        if (!r.ok) return null;
        const b = (await r.json()) as { ticket?: unknown };
        return typeof b.ticket === "string" ? b.ticket : null;
      } catch {
        return null;
      }
    },
  };
}

export function installBoxFetch(c: BoxConfig): void {
  if (original) return;
  installed = c;
  original = fetch.bind(globalThis);
  const send = (path: string, init: RequestInit, access: string | undefined) => {
    const headers = new Headers(init.headers);
    if (access) headers.set("authorization", `Bearer ${access}`);
    return nativeFetch()(`${c.provider}${path}`, {
      ...init,
      headers,
      credentials: "omit",
      mode: "cors",
    });
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = boxApiUrl(raw, location.href);
    if (!path) return nativeFetch()(input, init);
    const req = input instanceof Request ? input : null;
    const merged: RequestInit = {
      method: init?.method ?? req?.method,
      headers: init?.headers ?? req?.headers,
      body:
        init?.body ??
        (req && req.method !== "GET" && req.method !== "HEAD"
          ? await req.clone().blob()
          : undefined),
      signal: init?.signal ?? req?.signal,
    };
    let t = readJson<Tokens>(TOKENS);
    if (t && t.until - Date.now() < 30_000 && (await refresh(c))) t = readJson<Tokens>(TOKENS);
    const res = await send(path, merged, t?.access);
    if (res.status === 401 && t && (await refresh(c)))
      return send(path, merged, readJson<Tokens>(TOKENS)?.access);
    return res;
  }) as typeof fetch;
}

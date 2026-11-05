// The Google connection (docs/connections.md): access to Google Drive files
// the user picks, separate from signing in with Google.
//
// - Its own OAuth authorization-code flow with PKCE (S256) and a random state,
//   both kept in a sealed, HttpOnly cookie bound to the signed-in user for
//   10 minutes. Scopes: `drive.file` (only files the user opens with Lianki,
//   through the Picker) plus `openid email` to show which account it is.
//   `access_type=offline` + `prompt=consent` so Google hands a refresh token
//   every time; never `include_granted_scopes` (lib/google-auth-url.ts: the
//   shared GCP project would fold unrelated scopes in and Google refuses).
// - The refresh token is sealed at rest in D1 (`connection`, lib/connections/
//   crypto.ts). Access tokens live in this isolate's memory only, never in D1,
//   never logged.
// - Disconnecting revokes the grant at Google and deletes the row. Sign-in
//   (better-auth's `account` table) is never read or touched here.

import type { D1Like } from "@/lib/d1/types";
import { randomId, s256, sameString } from "@/lib/cli-login";
import { seal, sealKey, unseal } from "./crypto";
import { CONNECT_SCOPES, DRIVE_FILE_SCOPE } from "./scopes";

export const PROVIDER = "google";

export { CONNECT_SCOPES, DRIVE_FILE_SCOPE };

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const CALLBACK_PATH = "/api/connections/google/callback";
export const STATE_COOKIE = "lk_gconn";
export const STATE_COOKIE_PATH = "/api/connections/google";
export const STATE_TTL_MS = 10 * 60_000;

/** Starts per user per window, and picker tokens per user per window (D1 counters). */
export const CONNECT_STARTS = { max: 10, windowMs: 10 * 60_000 };
export const TOKEN_REQUESTS = { max: 30, windowMs: 10 * 60_000 };

export type ConnError =
  | "not-configured"
  | "not-connected"
  | "reconnect"
  | "no-drive-scope"
  | "google-failed";

/** Where a connection failed, for the log line only: a step word and Google's `error` word. */
export interface ConnFailDetail {
  step: "token" | "id-token" | "no-refresh-token" | "refresh";
  /** Google's `error` field (e.g. invalid_grant), when it is a plain word. Never its description. */
  google?: string;
  status?: number;
}

export class ConnectionError extends Error {
  constructor(
    public code: ConnError,
    public detail?: ConnFailDetail,
  ) {
    super(code);
    this.name = "ConnectionError";
  }
}

/** Google's `error` field when it is a short plain word, else undefined (logged, never shown). */
export function googleErrorWord(v: unknown): string | undefined {
  return typeof v === "string" && /^[a-z_]{1,40}$/.test(v) ? v : undefined;
}

// ── configuration ───────────────────────────────────────────────────────────

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

type Env = Record<string, string | undefined>;

/** The site's own origin for the callback: BETTER_AUTH_BASE_URL (https://lianki.com in production). */
export function siteOrigin(env: Env, requestUrl?: string): string | null {
  const raw = env.BETTER_AUTH_BASE_URL?.trim() || requestUrl;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The sign-in client's id and secret, reused; null until both are set. */
export function googleConfig(env: Env, requestUrl?: string): GoogleConfig | null {
  const clientId = env.AUTH_GOOGLE_ID?.trim();
  const clientSecret = env.AUTH_GOOGLE_SECRET?.trim();
  const origin = siteOrigin(env, requestUrl);
  if (!clientId || !clientSecret || !origin) return null;
  return { clientId, clientSecret, redirectUri: `${origin}${CALLBACK_PATH}` };
}

export interface PickerConfig {
  apiKey: string;
  /** The GCP project number (the Picker's app id). */
  appId: string;
}

/**
 * The Picker's browser key (secret GOOGLE_PICKER_API_KEY) and app id: the
 * project number, from GOOGLE_PICKER_APP_ID or else the OAuth client id's
 * numeric prefix (`<project number>-….apps.googleusercontent.com`).
 */
export function pickerConfig(env: Env): PickerConfig | null {
  const apiKey = env.GOOGLE_PICKER_API_KEY?.trim();
  if (!apiKey || !/^[A-Za-z0-9_-]{20,100}$/.test(apiKey)) return null;
  const explicit = env.GOOGLE_PICKER_APP_ID?.trim();
  const fromClient = /^(\d{6,20})-/.exec(env.AUTH_GOOGLE_ID?.trim() ?? "")?.[1];
  const appId = explicit && /^\d{6,20}$/.test(explicit) ? explicit : fromClient;
  if (!appId) return null;
  return { apiKey, appId };
}

// ── state cookie + PKCE ─────────────────────────────────────────────────────

export interface ConnectState {
  /** The random state sent to Google and checked on the way back. */
  s: string;
  /** The PKCE verifier. */
  v: string;
  /** The signed-in user who started it. */
  u: string;
  /** Expiry, ms. */
  e: number;
  /** Where to go afterwards (checked by `returnPath`). */
  r: string;
}

/**
 * Only our own pages that start a connection: /connections, /read with a doc
 * to import, or either with `?pick=drive` (the Picker opens on return,
 * lib/connections/drive-pick.ts).
 */
export function returnPath(raw: unknown): string {
  if (typeof raw !== "string") return "/connections";
  if (
    raw === "/connections" ||
    raw === "/read" ||
    raw === "/connections?pick=drive" ||
    raw === "/read?pick=drive"
  )
    return raw;
  const m = /^\/read\?gdoc=([A-Za-z0-9_-]{25,128})$/.exec(raw);
  return m ? `/read?gdoc=${m[1]}` : "/connections";
}

export async function newConnectState(
  userId: string,
  ret: unknown,
  now = Date.now(),
): Promise<{ state: ConnectState; challenge: string }> {
  const state: ConnectState = {
    s: randomId(32),
    v: randomId(48), // 64 base64url characters: inside RFC 7636's 43–128
    u: userId,
    e: now + STATE_TTL_MS,
    r: returnPath(ret),
  };
  return { state, challenge: await s256(state.v) };
}

const stateAad = (userId: string) => `google-oauth-state:${userId}`;

export async function sealState(state: ConnectState, secret: string | undefined): Promise<string> {
  return seal(
    await sealKey("google-oauth-state", secret),
    JSON.stringify(state),
    stateAad(state.u),
  );
}

export type StateCheck = { ok: true; state: ConnectState } | { ok: false; error: "bad-state" };

/**
 * The cookie's state, when it opens for this user, has not expired and its
 * state equals the one Google sent back (compared in constant time).
 */
export async function checkState(
  cookie: string | undefined,
  returnedState: unknown,
  userId: string,
  secret: string | undefined,
  now = Date.now(),
): Promise<StateCheck> {
  const bad = { ok: false, error: "bad-state" } as const;
  if (
    !cookie ||
    typeof returnedState !== "string" ||
    !/^[A-Za-z0-9_-]{20,100}$/.test(returnedState)
  )
    return bad;
  const plain = await unseal(await sealKey("google-oauth-state", secret), cookie, stateAad(userId));
  if (!plain) return bad;
  let st: ConnectState;
  try {
    st = JSON.parse(plain) as ConnectState;
  } catch {
    return bad;
  }
  if (st.u !== userId || typeof st.s !== "string" || typeof st.v !== "string") return bad;
  if (!Number.isFinite(st.e) || st.e <= now) return bad;
  if (!sameString(st.s, returnedState)) return bad;
  return { ok: true, state: { ...st, r: returnPath(st.r) } };
}

export function authorizationUrl(
  cfg: GoogleConfig,
  state: string,
  challenge: string,
  loginHint?: string,
): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", CONNECT_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (loginHint && /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(loginHint))
    u.searchParams.set("login_hint", loginHint);
  // Never include_granted_scopes (lib/google-auth-url.ts).
  return u.toString();
}

/** A code Google returned: what its token endpoint accepts, nothing else. */
export function validCode(code: unknown): code is string {
  return typeof code === "string" && /^[A-Za-z0-9/_.\-~]{10,512}$/.test(code);
}

// ── Google's endpoints ──────────────────────────────────────────────────────

type Fetch = typeof fetch;

interface TokenAnswer {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
}

async function postForm(fetchImpl: Fetch, url: string, form: Record<string, string>) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    // Not "error": the Workers runtime throws a TypeError on it ("won't be
    // implemented … at the edge"), so every exchange failed before reaching
    // Google. "manual" leaves a 3xx as a non-200, which callers treat as failed.
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenAnswer;
  return { status: res.status, json };
}

export interface IdClaims {
  sub: string;
  email: string | null;
}

/**
 * The id_token's claims. It comes straight from Google's token endpoint over
 * TLS in exchange for our client secret, so (OpenID Connect Core 3.1.3.7) its
 * signature need not be checked; issuer, audience and expiry still are.
 */
export function idClaims(idToken: unknown, clientId: string, now = Date.now()): IdClaims | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const c = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (ch) => ch.charCodeAt(0))));
    if (c.iss !== "https://accounts.google.com" && c.iss !== "accounts.google.com") return null;
    if (c.aud !== clientId) return null;
    if (typeof c.exp !== "number" || c.exp * 1000 < now - 5 * 60_000) return null;
    if (typeof c.sub !== "string" || !/^\d{1,40}$/.test(c.sub)) return null;
    const email =
      typeof c.email === "string" && c.email_verified === true && c.email.length <= 320
        ? c.email
        : null;
    return { sub: c.sub, email };
  } catch {
    return null;
  }
}

export function grantedScopes(scope: unknown): string[] {
  if (typeof scope !== "string") return [];
  return [...new Set(scope.split(/\s+/).filter((s) => /^[\x21-\x7e]{1,200}$/.test(s)))].slice(
    0,
    20,
  );
}

export interface Exchanged {
  accessToken: string;
  expiresAt: number;
  refreshToken: string | null;
  scopes: string[];
  claims: IdClaims;
}

export async function exchangeCode(
  cfg: GoogleConfig,
  code: string,
  verifier: string,
  fetchImpl: Fetch = fetch,
  now = Date.now(),
): Promise<Exchanged> {
  const { status, json } = await postForm(fetchImpl, GOOGLE_TOKEN_URL, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
  });
  if (status !== 200 || typeof json.access_token !== "string")
    throw new ConnectionError("google-failed", {
      step: "token",
      status,
      google: googleErrorWord(json.error),
    });
  const claims = idClaims(json.id_token, cfg.clientId, now);
  if (!claims) throw new ConnectionError("google-failed", { step: "id-token" });
  return {
    accessToken: json.access_token,
    expiresAt: now + Math.max(60, Math.min(3600, Number(json.expires_in) || 3600)) * 1000,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    scopes: grantedScopes(json.scope),
    claims,
  };
}

/** Revoke a token at Google (a refresh token revokes the whole grant). Best effort. */
export async function revokeAtGoogle(token: string, fetchImpl: Fetch = fetch): Promise<boolean> {
  try {
    const { status } = await postForm(fetchImpl, GOOGLE_REVOKE_URL, { token });
    // 400 invalid_token: already revoked, which is what we wanted.
    return status === 200 || status === 400;
  } catch {
    return false;
  }
}

// ── storage (D1 `connection`) ───────────────────────────────────────────────

export type ConnStatus = "ok" | "reconnect";

export interface ConnectionInfo {
  provider: typeof PROVIDER;
  email: string | null;
  scopes: string[];
  status: ConnStatus;
  createdMs: number;
  updatedMs: number;
}

interface Row {
  account_sub: string;
  account_email: string | null;
  scopes: string;
  refresh_enc: string;
  status: string;
  created_ms: number;
  updated_ms: number;
}

const refreshAad = (userId: string) => `google-refresh:${userId}:${PROVIDER}`;

export async function getConnection(db: D1Like, userId: string): Promise<ConnectionInfo | null> {
  const row = await db
    .prepare(
      "SELECT account_email, scopes, status, created_ms, updated_ms FROM connection WHERE user_id = ? AND provider = ?",
    )
    .bind(userId, PROVIDER)
    .first<Row>();
  if (!row) return null;
  return {
    provider: PROVIDER,
    email: row.account_email,
    scopes: grantedScopes(row.scopes),
    status: row.status === "ok" ? "ok" : "reconnect",
    createdMs: row.created_ms,
    updatedMs: row.updated_ms,
  };
}

/** Store a fresh grant. Without a new refresh token, keep the old one only for the same Google account. */
export async function saveConnection(
  db: D1Like,
  userId: string,
  ex: Exchanged,
  secret: string | undefined,
  now = Date.now(),
): Promise<void> {
  const key = await sealKey("google-refresh", secret);
  let sealed: string | null = null;
  if (ex.refreshToken) sealed = await seal(key, ex.refreshToken, refreshAad(userId));
  else {
    const old = await db
      .prepare("SELECT account_sub, refresh_enc FROM connection WHERE user_id = ? AND provider = ?")
      .bind(userId, PROVIDER)
      .first<Row>();
    if (old && old.account_sub === ex.claims.sub) sealed = old.refresh_enc;
  }
  if (!sealed) throw new ConnectionError("google-failed", { step: "no-refresh-token" });
  await db
    .prepare(
      `INSERT INTO connection
         (user_id, provider, account_sub, account_email, scopes, refresh_enc, status, created_ms, updated_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ok', ?7, ?7)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         account_sub = ?3, account_email = ?4, scopes = ?5, refresh_enc = ?6,
         status = 'ok', updated_ms = ?7`,
    )
    .bind(userId, PROVIDER, ex.claims.sub, ex.claims.email, ex.scopes.join(" "), sealed, now)
    .run();
  remember(userId, ex.accessToken, ex.expiresAt, ex.scopes);
}

/** The sealed refresh token opened, or null (no row, or AUTH_SECRET rotated). */
async function refreshTokenOf(
  db: D1Like,
  userId: string,
  secret: string | undefined,
): Promise<{ token: string | null; row: Row | null }> {
  const row = await db
    .prepare("SELECT * FROM connection WHERE user_id = ? AND provider = ?")
    .bind(userId, PROVIDER)
    .first<Row>();
  if (!row) return { token: null, row: null };
  const token = await unseal(
    await sealKey("google-refresh", secret),
    row.refresh_enc,
    refreshAad(userId),
  );
  return { token, row };
}

async function markReconnect(db: D1Like, userId: string, now = Date.now()) {
  forget(userId);
  await db
    .prepare(
      "UPDATE connection SET status = 'reconnect', updated_ms = ? WHERE user_id = ? AND provider = ?",
    )
    .bind(now, userId, PROVIDER)
    .run();
}

/** Disconnect: revoke at Google (best effort), then delete the row whatever Google said. */
export async function disconnect(
  db: D1Like,
  userId: string,
  secret: string | undefined,
  fetchImpl: Fetch = fetch,
): Promise<{ deleted: boolean; revoked: boolean }> {
  forget(userId);
  const { token, row } = await refreshTokenOf(db, userId, secret).catch(() => ({
    token: null,
    row: null,
  }));
  const revoked = token ? await revokeAtGoogle(token, fetchImpl) : false;
  await db
    .prepare("DELETE FROM connection WHERE user_id = ? AND provider = ?")
    .bind(userId, PROVIDER)
    .run();
  return { deleted: !!row, revoked };
}

// ── access tokens: this isolate's memory only ───────────────────────────────

interface Cached {
  token: string;
  exp: number;
  scopes: string[];
}
const MAX_CACHED = 500;
const cache = new Map<string, Cached>();

function remember(userId: string, token: string, exp: number, scopes: string[]) {
  cache.delete(userId);
  cache.set(userId, { token, exp, scopes });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
}

export function forget(userId: string) {
  cache.delete(userId);
}

/**
 * A Drive access token for this user: the cached one while it has more than a
 * minute left, else a refresh. A refused refresh (the user revoked Lianki at
 * Google, or AUTH_SECRET rotated) marks the connection "reconnect".
 */
export async function accessToken(
  db: D1Like,
  userId: string,
  cfg: GoogleConfig,
  secret: string | undefined,
  fetchImpl: Fetch = fetch,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const hit = cache.get(userId);
  if (hit && hit.exp - 60_000 > now) {
    if (!hit.scopes.includes(DRIVE_FILE_SCOPE)) throw new ConnectionError("no-drive-scope");
    return { token: hit.token, expiresAt: hit.exp };
  }
  const { token: refresh, row } = await refreshTokenOf(db, userId, secret);
  if (!row) throw new ConnectionError("not-connected");
  if (row.status !== "ok") throw new ConnectionError("reconnect");
  if (!refresh) {
    await markReconnect(db, userId, now);
    throw new ConnectionError("reconnect");
  }
  if (!grantedScopes(row.scopes).includes(DRIVE_FILE_SCOPE))
    throw new ConnectionError("no-drive-scope");
  let answer: Awaited<ReturnType<typeof postForm>>;
  try {
    answer = await postForm(fetchImpl, GOOGLE_TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    });
  } catch {
    throw new ConnectionError("google-failed");
  }
  const { status, json } = answer;
  if (json.error === "invalid_grant" || status === 401) {
    await markReconnect(db, userId, now);
    throw new ConnectionError("reconnect");
  }
  if (status !== 200 || typeof json.access_token !== "string")
    throw new ConnectionError("google-failed", {
      step: "refresh",
      status,
      google: googleErrorWord(json.error),
    });
  const exp = now + Math.max(60, Math.min(3600, Number(json.expires_in) || 3600)) * 1000;
  const scopes = json.scope ? grantedScopes(json.scope) : grantedScopes(row.scopes);
  if (typeof json.refresh_token === "string" && json.refresh_token !== refresh) {
    const sealed = await seal(
      await sealKey("google-refresh", secret),
      json.refresh_token,
      refreshAad(userId),
    );
    await db
      .prepare(
        "UPDATE connection SET refresh_enc = ?, updated_ms = ? WHERE user_id = ? AND provider = ?",
      )
      .bind(sealed, now, userId, PROVIDER)
      .run();
  }
  remember(userId, json.access_token, exp, scopes);
  if (!scopes.includes(DRIVE_FILE_SCOPE)) throw new ConnectionError("no-drive-scope");
  return { token: json.access_token, expiresAt: exp };
}

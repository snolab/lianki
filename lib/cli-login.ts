/**
 * `lianki auth login` in the browser (docs/secrets-and-auth.md, "CLI login").
 * A loopback flow with a one-time code and a PKCE (S256) verifier, so the API
 * token never travels in a URL:
 *
 * 1. The CLI listens on 127.0.0.1:<random port> and opens
 *    /cli-login?redirect_uri=http://127.0.0.1:<port>/cb&state=…&code_challenge=…&host=…
 * 2. The page (signed-in user only) checks every parameter and starts a
 *    `pending` row; its Approve button carries the row's random id, which is
 *    also the CSRF token (it exists only in the page rendered for this session).
 * 3. Approve (POST /api/cli-login/approve, same origin, state echoed) turns the
 *    row into a one-time code good for 60 s, and the page goes to
 *    http://127.0.0.1:<port>/cb?code=…&state=…
 * 4. The CLI checks the state and POSTs code + verifier to /api/cli-login/token
 *    (rate-limited per IP). The code is consumed in one UPDATE before anything
 *    else is checked, so it works once even if the verifier is wrong; a
 *    matching verifier mints the token, returned in the response body only.
 *
 * Only http://127.0.0.1:<port>/cb and http://[::1]:<port>/cb are accepted as
 * the redirect, matched as a whole string and rebuilt from its parts, so no
 * userinfo, other host, other path, query or fragment can get through.
 */
import type { D1Like } from "@/lib/d1/types";
import { sha256Hex } from "@/lib/security/throttle";
import type { Limit } from "@/lib/security/throttle";

const MIN = 60_000;
/** How long the page's Approve button stays good. */
export const PENDING_TTL_MS = 10 * MIN;
/** How long the one-time code sent to the CLI stays good. */
export const CODE_TTL_MS = 60_000;
/** Exchanges per IP: a code is 256 random bits, so this only caps abuse. */
export const EXCHANGES_PER_IP: Limit = { max: 10, windowMs: 15 * MIN };

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/cb$/;

/** The CLI's loopback callback, rebuilt from its parts, or null for anything else. */
export function loopbackRedirect(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const m = LOOPBACK.exec(raw);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://${m[1]}:${port}/cb`;
}

/** base64url without padding: state, code_challenge. */
const B64URL = /^[A-Za-z0-9_-]+$/;
export const validState = (s: unknown): s is string =>
  typeof s === "string" && s.length >= 16 && s.length <= 128 && B64URL.test(s);
/** An S256 challenge: base64url of a SHA-256, 43 characters. */
export const validChallenge = (s: unknown): s is string =>
  typeof s === "string" && s.length === 43 && B64URL.test(s);
/** RFC 7636 verifier: 43–128 unreserved characters. */
export const validVerifier = (s: unknown): s is string =>
  typeof s === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(s);

/** The CLI's machine name as shown on the page and in the token's name. */
export function cleanHost(raw: unknown): string {
  const s = typeof raw === "string" ? raw.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) : "";
  return s || "unknown";
}
export const tokenName = (host: string) => `lianki CLI ${cleanHost(host)}`;

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const randomId = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** The S256 challenge of a verifier. */
export async function s256(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(d));
}

/** Equal strings, compared without an early exit. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type LoginParams = {
  redirectUri: string;
  state: string;
  challenge: string;
  host: string;
};

/** The page's query, checked; an error names the first bad parameter. */
export function parseLoginParams(
  q: Record<string, string | string[] | undefined>,
): { ok: true; params: LoginParams } | { ok: false; error: string } {
  const one = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : undefined);
  const redirectUri = loopbackRedirect(one("redirect_uri"));
  if (!redirectUri) return { ok: false, error: "redirect_uri" };
  const state = one("state");
  if (!validState(state)) return { ok: false, error: "state" };
  const challenge = one("code_challenge");
  if (!validChallenge(challenge)) return { ok: false, error: "code_challenge" };
  if ((one("code_challenge_method") ?? "S256") !== "S256")
    return { ok: false, error: "code_challenge_method" };
  return { ok: true, params: { redirectUri, state, challenge, host: cleanHost(one("host")) } };
}

type Row = {
  user_id: string;
  email: string;
  redirect_uri: string;
  state: string;
  challenge: string;
  name: string;
  stage: string;
  expires_ms: number;
};

/** The page: start a pending request for this user. Returns the id for its Approve button. */
export async function startRequest(
  db: D1Like,
  u: { userId: string; email: string },
  p: LoginParams,
  now = Date.now(),
): Promise<string> {
  await db.prepare("DELETE FROM cli_login WHERE expires_ms < ?").bind(now).run();
  const id = randomId();
  await db
    .prepare(
      `INSERT INTO cli_login (request_hash, user_id, email, redirect_uri, state, challenge, name,
         stage, code_hash, expires_ms, created_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
    )
    .bind(
      await sha256Hex(id),
      u.userId,
      u.email,
      p.redirectUri,
      p.state,
      p.challenge,
      tokenName(p.host),
      now + PENDING_TTL_MS,
      now,
    )
    .run();
  return id;
}

export type ApproveResult = { ok: true; redirect: string } | { ok: false; status: number };

/**
 * Approve: the request must be this user's, still pending and unexpired, and
 * the state must match. It becomes a one-time code; the redirect carries it.
 */
export async function approveRequest(
  db: D1Like,
  a: { requestId: unknown; userId: string; state: unknown },
  now = Date.now(),
): Promise<ApproveResult> {
  if (typeof a.requestId !== "string" || !B64URL.test(a.requestId) || a.requestId.length > 64)
    return { ok: false, status: 400 };
  if (!validState(a.state)) return { ok: false, status: 400 };
  const hash = await sha256Hex(a.requestId);
  const code = randomId();
  // One UPDATE decides it, so two clicks cannot both get a code.
  const row = await db
    .prepare(
      `UPDATE cli_login SET stage = 'code', code_hash = ?, expires_ms = ?
       WHERE request_hash = ? AND user_id = ? AND stage = 'pending' AND expires_ms > ? AND state = ?
       RETURNING redirect_uri, state`,
    )
    .bind(await sha256Hex(code), now + CODE_TTL_MS, hash, a.userId, now, a.state)
    .first<{ redirect_uri: string; state: string }>();
  if (!row) return { ok: false, status: 404 };
  const redirect = loopbackRedirect(row.redirect_uri);
  if (!redirect) return { ok: false, status: 400 };
  const u = new URL(redirect);
  u.searchParams.set("code", code);
  u.searchParams.set("state", row.state);
  return { ok: true, redirect: u.toString() };
}

export type ExchangeResult =
  | { ok: true; token: string; tokenHash: string; name: string; email: string }
  | { ok: false; status: number; error: string };

/**
 * The CLI's exchange: consume the code (once, whatever follows), then check
 * expiry, the redirect it was sent to and the verifier, then mint the token.
 */
export async function exchangeCode(
  db: D1Like,
  x: { code: unknown; verifier: unknown; redirectUri: unknown },
  now = Date.now(),
): Promise<ExchangeResult> {
  const bad = (error: string, status = 400): ExchangeResult => ({ ok: false, status, error });
  if (typeof x.code !== "string" || !B64URL.test(x.code) || x.code.length > 64) return bad("code");
  if (!validVerifier(x.verifier)) return bad("code_verifier");
  const row = await db
    .prepare(
      `UPDATE cli_login SET stage = 'used' WHERE code_hash = ? AND stage = 'code'
       RETURNING user_id, email, redirect_uri, state, challenge, name, stage, expires_ms`,
    )
    .bind(await sha256Hex(x.code))
    .first<Row>();
  if (!row) return bad("invalid_grant");
  if (row.expires_ms <= now) return bad("expired");
  if (typeof x.redirectUri !== "string" || x.redirectUri !== row.redirect_uri)
    return bad("redirect_uri");
  if (!sameString(await s256(x.verifier), row.challenge)) return bad("code_verifier");

  const hex = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const token = `lk_${hex}`;
  const tokenHash = await sha256Hex(token);
  await db
    .prepare("INSERT INTO api_tokens (token_hash, email, name, created_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, row.email, row.name, new Date(now).toISOString())
    .run();
  return { ok: true, token, tokenHash, name: row.name, email: row.email };
}

/**
 * CSRF for the Approve POST: JSON, from this origin. A cross-site form cannot
 * send `application/json`, and a cross-site fetch carries its own Origin.
 */
export function sameOriginPost(req: Request): boolean {
  if (req.method !== "POST") return false;
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return false;
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = req.headers.get("origin");
  return origin !== null && origin === new URL(req.url).origin;
}

/** `lianki auth logout`: a token revokes itself, and nothing else. */
export async function revokeSelf(db: D1Like, token: string): Promise<boolean> {
  if (!/^lk_[0-9a-f]{64}$/.test(token)) return false;
  const hash = await sha256Hex(token);
  const row = await db
    .prepare("DELETE FROM api_tokens WHERE token_hash = ? RETURNING token_hash")
    .bind(hash)
    .first();
  return row !== null;
}

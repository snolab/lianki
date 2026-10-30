/**
 * The whole-page dev server's guard (docs/dev-whole-page.md): pure decisions,
 * no I/O, so unit/whole-page-guard.test.ts can pin every rule.
 *
 * The dev server runs the app against PRODUCTION D1, so every request passes
 * two locks before it reaches `next dev`:
 *
 * 1. Device: a cookie pinned by a one-time link (`/__dev/enter?t=…`). Without
 *    it, nothing is served — not even static files.
 * 2. Owner: the request's better-auth session must belong to an OWNER_EMAILS
 *    address. Anyone else gets 403, so no other user's data is readable.
 *
 * And the auth API is cut down to reading and ending a session: every sign-in
 * and sign-up endpoint is refused, so no account or password can be created in
 * production through this origin. The owner's session comes only from the
 * enter link (app/api/dev-whole-page/login).
 */

export const ENTER_PATH = "/__dev/enter";
export const DEVICE_COOKIE = "lk_dev_device";
/** Sent by the guard to the login route; stripped from every incoming request. */
export const GUARD_HEADER = "x-lianki-dev-guard";
/** One-time enter tokens live this long. */
export const ENTER_TOKEN_TTL_MS = 10 * 60 * 1000;
/** Where the enter link lands (owner, 2026-10-31: keep /words?list=all). */
export const LANDING = "/words?list=all";

/** The only auth endpoints the dev origin serves. */
const AUTH_ALLOWED = new Set(["/api/auth/get-session", "/api/auth/sign-out"]);

/** Served once the device is pinned, before a session exists (the app shell's assets, HMR). */
const PRE_SESSION_PREFIXES = ["/_next/", "/__nextjs"];

export type Decision =
  | { kind: "enter" } // the one-time link: verify the token, pin the device, sign in
  | { kind: "deny"; status: 403; reason: string }
  | { kind: "pass" } // forward without a session check
  | { kind: "owner" }; // forward only if the session is the owner's

/**
 * What to do with a request, before any session lookup.
 * `deviceOk` = the device cookie verified (see verifyDevice).
 */
export function decide(pathname: string, deviceOk: boolean): Decision {
  if (pathname === ENTER_PATH) return { kind: "enter" };
  if (!deviceOk) return { kind: "deny", status: 403, reason: "device not paired" };
  if (pathname.startsWith("/api/auth/") || pathname === "/api/auth") {
    return AUTH_ALLOWED.has(pathname)
      ? { kind: "pass" }
      : { kind: "deny", status: 403, reason: "sign-in is closed on the dev origin" };
  }
  if (PRE_SESSION_PREFIXES.some((p) => pathname.startsWith(p))) return { kind: "pass" };
  return { kind: "owner" };
}

/** Constant-time string compare (both sides are ours: hex of equal length). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The device cookie's value: HMAC-SHA256(secret, "device") as hex. */
export async function deviceCookieValue(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("device"));
  return Buffer.from(sig).toString("hex");
}

export async function verifyDevice(cookieValue: string | undefined, secret: string) {
  if (!cookieValue) return false;
  return safeEqual(cookieValue, await deviceCookieValue(secret));
}

/** Read one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/**
 * One-time enter tokens: issued on the guard's loopback control port, kept only
 * as SHA-256 hashes, consumed on first use, expired after ENTER_TOKEN_TTL_MS.
 */
export class EnterTokens {
  private live = new Map<string, number>(); // sha256(token) → expiry
  constructor(private now: () => number = Date.now) {}

  issue(): string {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    this.live.set(sha256(token), this.now() + ENTER_TOKEN_TTL_MS);
    return token;
  }

  /** True once per issued token, within its lifetime. */
  consume(token: string | null | undefined): boolean {
    if (!token) return false;
    const h = sha256(token);
    const exp = this.live.get(h);
    this.live.delete(h);
    for (const [k, e] of this.live) if (e <= this.now()) this.live.delete(k);
    return exp !== undefined && exp > this.now();
  }
}

function sha256(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

/** A session lookup result from /api/auth/get-session. */
export type SessionInfo = { user?: { email?: string | null } | null } | null;

export function sessionIsOwner(info: SessionInfo, owners: string[]): boolean {
  const email = info?.user?.email?.trim().toLowerCase();
  return Boolean(email && owners.includes(email));
}

/** RFC 1918 IPv4 — the only hosts the dev server may bind to (never 0.0.0.0). */
export function isPrivateLanHost(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

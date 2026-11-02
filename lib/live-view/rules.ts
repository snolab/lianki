/**
 * Live view (docs/live-view.md): the page, sign-in, cookies and API stay on
 * lianki.com; only the front-end JS of the swappable parts (the Learning
 * Partner widget and the hot islands) comes from the owner's dev server.
 *
 * The dev machine says where that JS is with a **signed claim**. Its Ed25519
 * private key is on the Mac only (scripts/dev/live-view.ts); lianki.com and
 * the page hold only the public key (keys.ts). The STT tickets (lib/stt-ticket.ts)
 * are the other way round: lianki.com signs, the Mac verifies.
 *
 * Wire form, as the STT ticket: `<payload>.<signature>`, base64url without
 * padding; the signature covers the ASCII bytes of `<payload>`. Payload JSON:
 *
 *   {aud:"lianki-live-view", op:"on", serial, iat, exp, widget?, islands?, branch, sha}
 *   {aud:"lianki-live-view", op:"off" | "status", serial, iat, exp}
 *
 * `serial` only grows: the server keeps the highest it accepted (on or off)
 * and refuses anything not above it, so an old pointer cannot be replayed.
 * An "on" lives at most 12 h; "off" and "status" at most 5 min.
 *
 * Pure and isomorphic: the route, the page and the Mac's script share it.
 */
import { b64url, fromB64url } from "@/lib/stt-ticket";
import { LIVE_VIEW_ORIGINS } from "./origins";

export const LIVE_VIEW_AUD = "lianki-live-view";
/** An "on" pointer lives at most this long (seconds). */
export const LIVE_VIEW_MAX_S = 12 * 3600;
/** An "off" or "status" request lives at most this long (seconds). */
export const LIVE_VIEW_REQ_MAX_S = 300;
/** Clock skew allowed between the Mac and the verifier (seconds). */
export const LIVE_VIEW_SKEW_S = 60;
/** Longest token accepted, before any parsing. */
export const LIVE_VIEW_MAX_LEN = 2048;
/** The owner's per-device switch (Live view ⇄ Normal). Not a secret: the server checks the owner. */
export const LIVE_VIEW_COOKIE = "lk_live_view";

export type LiveViewOp = "on" | "off" | "status";
export type LiveViewClaim = {
  aud: string;
  op: LiveViewOp;
  serial: number;
  iat: number;
  exp: number;
  /** The widget module, e.g. https://<mac>.<tailnet>.ts.net/lianki-widget/debug-chat.js */
  widget?: string;
  /** The islands module, e.g. https://<mac>.<tailnet>.ts.net/lianki-islands/islands.js */
  islands?: string;
  branch?: string;
  sha?: string;
};

export type LiveViewResult =
  | { ok: true; claim: LiveViewClaim }
  | {
      ok: false;
      error:
        | "malformed"
        | "bad signature"
        | "wrong aud"
        | "wrong op"
        | "bad lifetime"
        | "expired"
        | "bad source"
        | "no source";
    };

const ED = { name: "Ed25519" } as const;
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BRANCH = /^[A-Za-z0-9._/+-]{1,80}$/;
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * Where live JS may come from: exactly one of `origins` (LIVE_VIEW_ORIGINS,
 * the owner's own hosts — origins.ts), over https. `allowLocal` adds
 * http(s)://localhost, for dev builds and tests only. No credentials, no
 * fragment, at most 300 characters.
 */
export function liveSourceOk(
  raw: unknown,
  allowLocal = false,
  origins: readonly string[] = LIVE_VIEW_ORIGINS,
): raw is string {
  if (typeof raw !== "string" || raw.length > 300) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (allowLocal && LOCAL.has(u.hostname) && (u.protocol === "http:" || u.protocol === "https:"))
    return true;
  return u.protocol === "https:" && origins.includes(u.origin);
}

/** A public key from its raw 32 bytes, base64url. */
export async function importLiveViewPublicKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64url(raw.trim()) as BufferSource, ED, false, [
    "verify",
  ]);
}

/** The Mac's private key, a JWK (kty OKP, crv Ed25519, d, x). */
export async function importLiveViewPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d)
    throw new Error("not an Ed25519 private JWK");
  return crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x },
    ED,
    false,
    ["sign"],
  );
}

export async function signLiveView(
  key: CryptoKey,
  claim: Omit<LiveViewClaim, "aud"> & { aud?: string },
): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify({ aud: LIVE_VIEW_AUD, ...claim })));
  const sig = new Uint8Array(await crypto.subtle.sign(ED, key, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** Split and check the signature against any of `keys`; null if none matches. */
async function verified(token: string, keys: CryptoKey[]): Promise<unknown | "bad" | null> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const data = new TextEncoder().encode(parts[0]);
  let sig: Uint8Array;
  try {
    sig = fromB64url(parts[1]);
  } catch {
    return null;
  }
  let ok = false;
  for (const k of keys) {
    try {
      if (await crypto.subtle.verify(ED, k, sig as BufferSource, data)) {
        ok = true;
        break;
      }
    } catch {}
  }
  if (!ok) return "bad";
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
  } catch {
    return null;
  }
}

/**
 * Verify a live-view token: signature (any of `keys`), audience, op, lifetime
 * and, for "on", the sources. Replay (the serial) is the store's job: only it
 * knows the highest serial so far.
 */
export async function verifyLiveView(
  token: unknown,
  keys: CryptoKey[],
  o: { op?: LiveViewOp; now?: number; allowLocal?: boolean; origins?: readonly string[] } = {},
): Promise<LiveViewResult> {
  if (typeof token !== "string" || token.length > LIVE_VIEW_MAX_LEN || !keys.length)
    return { ok: false, error: "malformed" };
  const v = await verified(token, keys);
  if (v === "bad") return { ok: false, error: "bad signature" };
  if (!v || typeof v !== "object") return { ok: false, error: "malformed" };
  const c = v as Record<string, unknown>;
  if (c.aud !== LIVE_VIEW_AUD) return { ok: false, error: "wrong aud" };
  if (c.op !== "on" && c.op !== "off" && c.op !== "status")
    return { ok: false, error: "malformed" };
  if (o.op && c.op !== o.op) return { ok: false, error: "wrong op" };
  const { serial, iat, exp } = c;
  if (
    typeof serial !== "number" ||
    !Number.isSafeInteger(serial) ||
    serial <= 0 ||
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    !Number.isFinite(iat) ||
    !Number.isFinite(exp)
  )
    return { ok: false, error: "malformed" };
  const t = Math.floor((o.now ?? Date.now()) / 1000);
  const max = c.op === "on" ? LIVE_VIEW_MAX_S : LIVE_VIEW_REQ_MAX_S;
  if (exp <= iat || exp - iat > max || iat > t + LIVE_VIEW_SKEW_S)
    return { ok: false, error: "bad lifetime" };
  if (exp <= t) return { ok: false, error: "expired" };
  const claim: LiveViewClaim = { aud: LIVE_VIEW_AUD, op: c.op, serial, iat, exp };
  if (c.op === "on") {
    if (c.widget === undefined && c.islands === undefined) return { ok: false, error: "no source" };
    for (const s of [c.widget, c.islands])
      if (s !== undefined && !liveSourceOk(s, o.allowLocal, o.origins))
        return { ok: false, error: "bad source" };
    if (typeof c.branch !== "string" || !BRANCH.test(c.branch))
      return { ok: false, error: "malformed" };
    if (typeof c.sha !== "string" || !SHA.test(c.sha)) return { ok: false, error: "malformed" };
    if (c.widget !== undefined) claim.widget = c.widget as string;
    if (c.islands !== undefined) claim.islands = c.islands as string;
    claim.branch = c.branch;
    claim.sha = c.sha;
  }
  return { ok: true, claim };
}

/** "feat/x@abc1234": what the banner shows. */
export const liveLabel = (c: Pick<LiveViewClaim, "branch" | "sha">) =>
  `${c.branch ?? "?"}@${(c.sha ?? "").slice(0, 7)}`;

/**
 * Whether this page may still honour the old unsigned localStorage overrides
 * (lk:agent-widget-src, lk:debug-widget-src, lk:slots-src): only a dev build
 * (`next dev`, the whole-page dev server) or a page served from this machine.
 * On production (lianki.com) only a signed live-view pointer loads dev JS.
 */
export function unsignedOverridesAllowed(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  hostname: string | undefined = typeof location === "undefined" ? undefined : location.hostname,
): boolean {
  if (nodeEnv !== "production") return true;
  return hostname !== undefined && LOCAL.has(hostname);
}

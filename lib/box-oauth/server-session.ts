/**
 * The box's own server learns who is signed in (docs/box-oauth.md, "The box's
 * server sees the sign-in"). The tokens live in the tab's sessionStorage, so
 * the box's server saw nobody, and every page it decides (/learn, /polyglot,
 * /profile, the shell's account, the owner's /dev pages) said "sign in" to a
 * signed-in tab (2026-11-09).
 *
 * Now the tab mirrors its current access token into one cookie of the box's own
 * host (client.ts, `__Host-` on https: never sent to lianki.com or another
 * box). The box's server asks lianki.com who that token is, through the same
 * gate as the browser: GET /api/box/me, `Authorization: Bearer`, the box's own
 * origin, no cookie. So it learns exactly what the page already knows, and
 * nothing it could not ask itself; the token stays short-lived and bound to
 * this box's origin and account. Anything off (no cookie, a malformed one, an
 * expired or revoked token, lianki.com unreachable, no configured origin) is
 * nobody: never a fall back to a local session, which a box does not have.
 *
 * The answer is kept 30 s per token (as lianki.com keeps the owner list), so a
 * page costs at most one call to lianki.com, and a revoke reaches it within 30 s.
 */
import { BOX_ME_PATH, BOX_TOKEN_PREFIX } from "./rules";

/** The cookie's name on an https box: host-only, Secure, Path=/ (no subdomain can set it). */
export const BOX_AT_COOKIE = "__Host-lk_box_at";
/** On an http box (local QA only), where a browser refuses a `__Host-` cookie. */
export const BOX_AT_COOKIE_HTTP = "lk_box_at";

const TOKEN = new RegExp(`^${BOX_TOKEN_PREFIX}[A-Za-z0-9_-]{16,256}$`);
export const BOX_SESSION_CACHE_MS = 30_000;
const MAX_CACHED = 32;

/** The token from a Cookie header, or null: absent or not a box token's shape. */
export function boxAccessFromCookies(cookie: string | null | undefined): string | null {
  if (!cookie) return null;
  let plain: string | null = null;
  for (const part of cookie.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === BOX_AT_COOKIE && TOKEN.test(value)) return value;
    if (name === BOX_AT_COOKIE_HTTP && TOKEN.test(value)) plain ??= value;
  }
  return plain;
}

export type BoxServerAccount = {
  id: string;
  email: string;
  name: string;
  image: string | null;
  /** lianki.com's owner role for this account (site_role). */
  owner: boolean;
};

export type BoxServerDeps = {
  /** lianki.com (LIANKI_BOX_PROVIDER). */
  provider: string;
  /** This box's own origin (BETTER_AUTH_BASE_URL): the token works only from it. */
  origin: string | null;
  fetch?: typeof fetch;
  now?: () => number;
};

type Cached = { at: number; account: BoxServerAccount };
// On globalThis: route handlers and server components may each get a copy of this module.
const KEY = Symbol.for("lianki.box-server-session");
const store = globalThis as unknown as Record<symbol, Map<string, Cached> | undefined>;
const cache: Map<string, Cached> = (store[KEY] ??= new Map());

export function clearBoxServerCache(): void {
  cache.clear();
}

const text = (v: unknown, max: number) =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

/** Who the token belongs to, per lianki.com, or null. */
export async function boxServerAccount(
  token: string | null,
  d: BoxServerDeps,
): Promise<BoxServerAccount | null> {
  if (!token || !TOKEN.test(token) || !d.origin) return null;
  const now = d.now?.() ?? Date.now();
  const hit = cache.get(token);
  if (hit && now - hit.at >= 0 && now - hit.at < BOX_SESSION_CACHE_MS) return hit.account;
  cache.delete(token);
  let res: Response;
  try {
    res = await (d.fetch ?? fetch)(`${d.provider}${BOX_ME_PATH}`, {
      headers: { authorization: `Bearer ${token}`, origin: d.origin },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    user?: Record<string, unknown>;
    owner?: unknown;
  } | null;
  const id = text(body?.user?.id, 128);
  const email = text(body?.user?.email, 320);
  if (!id || !email) return null;
  const image = text(body?.user?.image, 2048);
  const account: BoxServerAccount = {
    id,
    email,
    name: text(body?.user?.name, 200) ?? "",
    // Only a picture the page can load: an absolute https URL (an upload's is, from lianki.com).
    image:
      image && image.startsWith("https://")
        ? image
        : image?.startsWith("/api/avatar/")
          ? `${d.provider}${image}`
          : null,
    owner: body?.owner === true,
  };
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(token, { at: now, account });
  return account;
}

/** The session shape better-auth's getSession answers, for the box's account. */
export function boxServerSession(a: BoxServerAccount, now = Date.now()) {
  const at = new Date(now);
  return {
    user: {
      id: a.id,
      email: a.email,
      name: a.name,
      image: a.image,
      emailVerified: true,
      createdAt: at,
      updatedAt: at,
    },
    session: {
      id: "box:server",
      userId: a.id,
      token: "",
      expiresAt: new Date(now + BOX_SESSION_CACHE_MS),
      createdAt: at,
      updatedAt: at,
      ipAddress: null,
      userAgent: null,
    },
  };
}

/** This box's origin from its env (devbox/start.sh sets BETTER_AUTH_BASE_URL), or null. */
export function boxOriginFromEnv(): string | null {
  const raw = process.env.BETTER_AUTH_BASE_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

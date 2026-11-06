/**
 * Custom frontends (docs/custom-frontend.md): a signed-in user on the
 * allowlist runs their own frontend on their own dev server, behind their own
 * Cloudflare tunnel, and views it at `lianki.com/<path>?live=<id>`. The page's
 * HTML and its /_next chunks come from the tunnel; /api and /auth always stay
 * on production, so their JS acts with their own session and permissions
 * only. Behind the flag `my-box` (the owner sees it while off).
 *
 * Safety rules (the shared spec, not the owner's #576 bridge):
 * - **Self only.** A preview is served only to the signed-in user who
 *   registered it. Anyone else (the owner too, or signed out) opening its
 *   `?live=<id>` gets the normal production page and the live cookie cleared.
 * - **Nothing of the viewer goes up**: no Cookie, Authorization, cf-*,
 *   x-forwarded-*, Referer, and never the owner's gate secret. Origin is the
 *   tunnel's.
 * - **A strict CSP on every response** (customCsp): scripts from lianki.com
 *   (the proxied chunks) and the tunnel only, and connections to lianki.com
 *   and the tunnel only, so the page's JS can talk to /api with the user's
 *   own cookies but not send their data to a third host.
 *
 * Pure and isomorphic (the Worker, the API routes and the tests share it): no
 * Next import, no D1 binding of its own.
 */

import { FLAG_OLD_KEYS } from "../flags";
import type { AuditDb } from "../security/audit-log";
import { audit } from "../security/audit-log";

/** The feature flag (lib/flags.ts). */
export const CUSTOM_FRONTEND_FLAG = "my-box";
/** A preview lives at most this long. */
export const CUSTOM_MAX_HOURS = 8;
/** Previews a user may have active at once (one conditional INSERT enforces it). */
export const CUSTOM_CAP = 3;
/** Registrations per user per hour (D1 counter, lib/security/throttle.ts). */
export const CUSTOM_CREATES_PER_HOUR = 20;
/**
 * Exact hosts allowed besides a quick tunnel's (`<label>.trycloudflare.com`):
 * a reviewed list, empty today. A named tunnel on a user's own domain goes
 * here, as its bare host.
 */
export const CUSTOM_FRONTEND_HOSTS: readonly string[] = [];

/** One label of a quick tunnel's host: letters, digits, single dashes. */
const QUICK_TUNNEL_HOST = /^[a-z0-9]+(-[a-z0-9]+)*\.trycloudflare\.com$/;

/**
 * A custom frontend's target: exactly `https://<host>` (a trailing "/" is
 * accepted and dropped), where <host> is one label under trycloudflare.com or
 * one of CUSTOM_FRONTEND_HOSTS. No port, path, query, fragment or userinfo,
 * lower case, at most 100 characters. Returns the bare origin, or null.
 */
export function customTarget(raw: unknown, hosts: readonly string[] = CUSTOM_FRONTEND_HOSTS) {
  if (typeof raw !== "string" || raw.length > 100) return null;
  const s = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const m = /^https:\/\/([a-z0-9.-]+)$/.exec(s);
  if (!m) return null;
  const host = m[1];
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
  if (u.hostname !== host || u.origin !== s) return null;
  if (!QUICK_TUNNEL_HOST.test(host) && !hosts.includes(host)) return null;
  return u.origin;
}

/** A preview id: 128 random bits, base64url, 22 characters. */
export const CUSTOM_ID = /^[A-Za-z0-9_-]{22}$/;

export function isCustomId(v: string | null | undefined): v is string {
  return typeof v === "string" && CUSTOM_ID.test(v);
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function newCustomId(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** The hours asked for: a number in (0, 8]; absent → 8. null when out of range. */
export function customHours(v: unknown): number | null {
  if (v === undefined || v === null) return CUSTOM_MAX_HOURS;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > CUSTOM_MAX_HOURS) return null;
  return v;
}

/* ------------------------------------------------------------------ store */

type Stmt = {
  bind(...v: unknown[]): {
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    run(): Promise<unknown>;
  };
};
export type CustomDb = { prepare(q: string): Stmt } & AuditDb;

export type CustomPreview = {
  id: string;
  userId: string;
  target: string;
  createdAt: number;
  expiresAt: number;
};

type Row = {
  id: string;
  user_id: string;
  target: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
};

const fromRow = (r: Row): CustomPreview => ({
  id: r.id,
  userId: r.user_id,
  target: r.target,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

const changes = (r: unknown) => Number((r as { meta?: { changes?: unknown } })?.meta?.changes ?? 0);

export async function isAllowed(db: CustomDb, userId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM live_frontend_allow WHERE user_id = ?1")
    .bind(userId)
    .first<{ ok: number }>();
  return row?.ok === 1;
}

export type CreateResult =
  | { ok: true; preview: CustomPreview }
  | { ok: false; error: "not-allowed" | "cap" };

/**
 * Register a preview. ONE conditional INSERT: the row goes in only while the
 * user has fewer than CUSTOM_CAP active previews and is on the allowlist (or
 * `owner`). D1 runs one statement at a time, so two concurrent registrations
 * can never both pass the count. Audited.
 */
export async function createPreview(
  db: CustomDb,
  o: { userId: string; target: string; hours: number; owner: boolean; now?: number },
): Promise<CreateResult> {
  const now = o.now ?? Date.now();
  const id = newCustomId();
  const exp = now + Math.round(Math.min(o.hours, CUSTOM_MAX_HOURS) * 3_600_000);
  const r = await db
    .prepare(
      `INSERT INTO live_preview (id, user_id, target, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE (SELECT COUNT(*) FROM live_preview
              WHERE user_id = ?2 AND revoked_at IS NULL AND expires_at > ?4) < ?6
         AND (?7 = 1 OR EXISTS (SELECT 1 FROM live_frontend_allow WHERE user_id = ?2))`,
    )
    .bind(id, o.userId, o.target, now, exp, CUSTOM_CAP, o.owner ? 1 : 0)
    .run();
  if (changes(r) !== 1) {
    const allowed = o.owner || (await isAllowed(db, o.userId));
    return { ok: false, error: allowed ? "cap" : "not-allowed" };
  }
  await audit(
    db,
    { kind: "live-preview.create", actor: o.userId, subject: id, detail: o.target },
    now,
  );
  return {
    ok: true,
    preview: { id, userId: o.userId, target: o.target, createdAt: now, expiresAt: exp },
  };
}

/** The user's active previews, newest first. */
export async function listPreviews(
  db: CustomDb,
  userId: string,
  now = Date.now(),
): Promise<CustomPreview[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM live_preview WHERE user_id = ?1 AND revoked_at IS NULL AND expires_at > ?2
       ORDER BY created_at DESC`,
    )
    .bind(userId, now)
    .all<Row>();
  return results.map(fromRow);
}

/** Every active preview (the owner's /dev page). */
export async function listAllPreviews(db: CustomDb, now = Date.now()) {
  const { results } = await db
    .prepare(
      `SELECT p.*, u.email AS email FROM live_preview p LEFT JOIN user u ON u.id = p.user_id
       WHERE p.revoked_at IS NULL AND p.expires_at > ?1 ORDER BY p.created_at DESC LIMIT 200`,
    )
    .bind(now)
    .all<Row & { email: string | null }>();
  return results.map((r) => ({ ...fromRow(r), email: r.email }));
}

/**
 * One active preview, for its registrant only: null for anyone else, and
 * when it has expired or been revoked, or its target no longer passes the
 * rules. `gate`: the flag is on, or the viewer is the owner; off, null, and
 * the user must also still be on the allowlist (or be the owner).
 */
export async function previewFor(
  db: CustomDb,
  id: string,
  viewer: { userId: string; owner: boolean; flagOn: boolean },
  now = Date.now(),
): Promise<CustomPreview | null> {
  if (!isCustomId(id)) return null;
  if (!viewer.flagOn && !viewer.owner) return null;
  const row = await db
    .prepare(
      `SELECT p.*, EXISTS (SELECT 1 FROM live_frontend_allow a WHERE a.user_id = p.user_id) AS allowed
       FROM live_preview p WHERE p.id = ?1`,
    )
    .bind(id)
    .first<Row & { allowed: number }>();
  if (!row || row.user_id !== viewer.userId) return null;
  if (row.revoked_at !== null || row.expires_at <= now) return null;
  if (!viewer.owner && row.allowed !== 1) return null;
  if (customTarget(row.target) !== row.target) return null;
  return fromRow(row);
}

/**
 * Revoke: the registrant's own (`userId`), or any (`owner`). True when a row
 * changed. Audited.
 */
export async function revokePreview(
  db: CustomDb,
  id: string,
  by: { userId: string; owner: boolean },
  now = Date.now(),
): Promise<boolean> {
  if (!isCustomId(id)) return false;
  const r = await db
    .prepare(
      `UPDATE live_preview SET revoked_at = ?2
       WHERE id = ?1 AND revoked_at IS NULL AND (?4 = 1 OR user_id = ?3)`,
    )
    .bind(id, now, by.userId, by.owner ? 1 : 0)
    .run();
  if (changes(r) !== 1) return false;
  await audit(db, { kind: "live-preview.revoke", actor: by.userId, subject: id }, now);
  return true;
}

/** The allowlist with each user's email (the owner's /dev page). */
export async function listAllowed(db: CustomDb) {
  const { results } = await db
    .prepare(
      `SELECT a.user_id AS userId, u.email AS email, u.name AS name, a.added_by AS addedBy,
              a.added_at AS addedAt
       FROM live_frontend_allow a LEFT JOIN user u ON u.id = a.user_id ORDER BY a.added_at DESC`,
    )
    .bind()
    .all<{
      userId: string;
      email: string | null;
      name: string | null;
      addedBy: string;
      addedAt: number;
    }>();
  return results;
}

/** Add a user by email (owner only, checked by the caller). The user id, or null when no such user. */
export async function allowByEmail(
  db: CustomDb,
  email: string,
  by: string,
  now = Date.now(),
): Promise<string | null> {
  const u = await db
    .prepare("SELECT id FROM user WHERE email = ?1 COLLATE NOCASE")
    .bind(email.trim())
    .first<{ id: string }>();
  if (!u) return null;
  await db
    .prepare(
      `INSERT INTO live_frontend_allow (user_id, added_by, added_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO NOTHING`,
    )
    .bind(u.id, by, now)
    .run();
  await audit(db, { kind: "live-frontend.allow", actor: by, subject: u.id }, now);
  return u.id;
}

/**
 * Remove a user (owner only). Their active previews are revoked in the same
 * call, so nothing of theirs is served after it (the Worker also re-checks
 * the allowlist on every request, within its 5 s cache).
 */
export async function disallow(
  db: CustomDb,
  userId: string,
  by: string,
  now = Date.now(),
): Promise<boolean> {
  const r = await db
    .prepare("DELETE FROM live_frontend_allow WHERE user_id = ?1")
    .bind(userId)
    .run();
  await db
    .prepare("UPDATE live_preview SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL")
    .bind(userId, now)
    .run();
  const removed = changes(r) === 1;
  if (removed) await audit(db, { kind: "live-frontend.disallow", actor: by, subject: userId }, now);
  return removed;
}

/* -------------------------------------------------------------- the page */

/**
 * The CSP on every response served for a custom frontend. Scripts: lianki.com
 * (the proxied /_next chunks), the tunnel (a Vite app's modules), inline ones
 * only with this response's nonce (the Worker adds it to every <script> in
 * the proxied HTML), and eval (dev builds' source maps and fast refresh).
 * Connections: lianki.com (its /api, with the user's own cookies; the HMR
 * socket) and the tunnel (its own HMR). Nothing else may be fetched,
 * framed, posted to or loaded as a worker.
 *
 * What CSP cannot stop: a top-level navigation to another site carrying data
 * in its URL. The page is the registrant's own code, shown to them only; the
 * CSP is defence in depth against a dependency or a tunnel turning on them.
 */
export function customCsp(target: string, site: string, nonce?: string): string {
  const t = new URL(target);
  const s = new URL(site);
  const tws = `wss://${t.host}`;
  const sws = `wss://${s.host}`;
  const script = ["'self'", t.origin, "'unsafe-eval'"];
  if (nonce) script.push(`'nonce-${nonce}'`);
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    `style-src 'self' 'unsafe-inline' ${t.origin}`,
    `img-src 'self' data: blob: ${t.origin}`,
    `font-src 'self' data: ${t.origin}`,
    `connect-src 'self' ${sws} ${t.origin} ${tws}`,
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/** A fresh nonce for one response's inline scripts. */
export function cspNonce(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/* ------------------------------------------------------------ the cookie */

/**
 * The live cookie for a custom frontend (the same `__Host-lk_live` as the
 * owner's, another form): `c.<id>.<user id>.<until ms>.<o>.<session>.<hmac>`.
 * `o` is 1 when the registrant was the owner; `<session>` is the first 22
 * characters of the SHA-256 of their session cookie, so the cookie is good
 * only with the session it was set for: sign out, or another account on the
 * same browser, and it stops matching. The HMAC key is LIVE_GATE_SECRET, with
 * its own label, and never leaves the Worker.
 */
export type CustomCookie = {
  id: string;
  userId: string;
  until: number;
  owner: boolean;
  session: string;
};

const enc = new TextEncoder();

async function mac(secret: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(
    new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`lk-live-custom|${data}`))),
  );
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The session cookie's value (`better-auth.session_token`, with its `__Host-` prefix on https). */
export function sessionToken(cookie: string | null): string | null {
  for (const part of (cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k === "__Host-better-auth.session_token" || k === "better-auth.session_token") {
      const v = part.slice(i + 1).trim();
      if (v) return v;
    }
  }
  return null;
}

export async function sessionTag(token: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`lk-live|${token}`)));
  return b64url(h).slice(0, 22);
}

type SessionMarkDb = {
  prepare(q: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } };
};

/** This session has opened a custom frontend: see db/migrations/0050_custom_live_session.sql. */
export async function markCustomSession(db: SessionMarkDb, tag: string, now: number) {
  await db
    .prepare(
      "INSERT INTO custom_live_session (tag, first_at, last_at) VALUES (?1, ?2, ?2) ON CONFLICT(tag) DO UPDATE SET last_at = ?2 RETURNING tag",
    )
    .bind(tag, now)
    .first();
}

export async function customSessionMarked(db: SessionMarkDb, tag: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT tag FROM custom_live_session WHERE tag = ?1")
    .bind(tag)
    .first();
  return row !== null;
}

export async function sealCustomCookie(secret: string, c: CustomCookie): Promise<string> {
  const body = `c.${c.id}.${c.userId}.${c.until}.${c.owner ? 1 : 0}.${c.session}`;
  return `${body}.${await mac(secret, body)}`;
}

export async function openCustomCookie(
  secret: string,
  v: string | undefined,
  now: number,
): Promise<CustomCookie | null> {
  const m =
    /^c\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{1,64})\.(\d{1,16})\.([01])\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(
      v ?? "",
    );
  if (!m) return null;
  const body = `c.${m[1]}.${m[2]}.${m[3]}.${m[4]}.${m[5]}`;
  if (!same(m[6], await mac(secret, body))) return null;
  const c = { id: m[1], userId: m[2], until: Number(m[3]), owner: m[4] === "1", session: m[5] };
  return c.until > now ? c : null;
}

/**
 * The Worker's per-request check for a custom frontend's subresource: the
 * row still active, still this user's, and (unless the owner's) the flag on
 * and the user still on the allowlist. One query; null for "not live". The
 * flag is read here with its own SQL, not lib/flags-store.ts, so it follows
 * FLAG_OLD_KEYS itself: a row under the new key wins, else the old key's.
 */
export async function activeForCookie(
  db: { prepare(q: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } } },
  c: CustomCookie,
  now: number,
): Promise<CustomPreview | null> {
  const row = await db
    .prepare(
      `SELECT p.*,
         EXISTS (SELECT 1 FROM live_frontend_allow a WHERE a.user_id = p.user_id) AS allowed,
         COALESCE(
           (SELECT enabled FROM feature_flags WHERE key = ?2),
           (SELECT enabled FROM feature_flags WHERE key = ?3)
         ) AS flag
       FROM live_preview p WHERE p.id = ?1`,
    )
    .bind(c.id, CUSTOM_FRONTEND_FLAG, FLAG_OLD_KEYS[CUSTOM_FRONTEND_FLAG])
    .first<Row & { allowed: number; flag: number | null }>();
  if (!row || row.user_id !== c.userId) return null;
  if (row.revoked_at !== null || row.expires_at <= now) return null;
  if (!c.owner && (row.allowed !== 1 || row.flag !== 1)) return null;
  if (customTarget(row.target) !== row.target) return null;
  return fromRow(row);
}

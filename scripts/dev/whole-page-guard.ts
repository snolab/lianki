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

/** lianki-push's build-announcement socket (app/components/NewVersionNotice.tsx). */
export const BUILD_ANNOUNCE_PATH = "/api/version/ws";

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
  // lianki.com's build announcements: the dev build's id never matches
  // production's, so the page would offer "New version · Refresh" forever.
  // Refused, the page's version check stops (it gives up on a fast failure).
  if (pathname === BUILD_ANNOUNCE_PATH) {
    return { kind: "deny", status: 403, reason: "build announcements are off on the dev server" };
  }
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

/**
 * lianki-push's paths (the debug chat hub, build announcements, the state
 * tree). They live on lianki.com, not in `next dev`, so the guard forwards
 * them there — owner session checked first — with lianki.com as the Origin
 * the hub insists on.
 */
export const HUB_PREFIX = "/api/version/";
export const HUB_ORIGIN = "https://lianki.com";

export function isHubPath(pathname: string): boolean {
  return pathname.startsWith(HUB_PREFIX);
}

/** Where the enter link lands first: copies the carried settings, then LANDING. */
export const LANDING_PATH = "/__dev/landing";

/**
 * localStorage keys carried from his lianki.com tab to the dev origin (storage
 * is per origin): the debug/agent widget switches and his preferences. Small
 * values only; caches (lk:c:*) and anything else stay behind.
 */
export function copyableKey(key: string, value: string): boolean {
  return /^lk:(debug|agent|pref)/.test(key) && value.length <= 4096;
}

/** The landing page: write the carried keys (from the URL fragment), turn debug on, go on. */
export function landingHtml(lab = "", origin = ""): string {
  const allow = copyableKey.toString();
  const repoint = toDevOrigin.toString();
  return `<!doctype html><meta charset="utf-8"><title>Lianki dev</title><script>
const copyableKey = ${allow};
const LAB_PREFIX = ${JSON.stringify(LAB_PREFIX)};
const toDevOrigin = ${repoint};
try {
  const o = JSON.parse(decodeURIComponent(location.hash.slice(1) || "%7B%7D"));
  for (const [k, v] of Object.entries(o))
    if (typeof v === "string" && copyableKey(k, v))
      localStorage.setItem(k, ${JSON.stringify(Boolean(lab))} ? toDevOrigin(v, ${JSON.stringify(lab)}, ${JSON.stringify(origin)}) : v);
} catch {}
localStorage.setItem("lk:debug", "1");
location.replace(${JSON.stringify(LANDING)});
</script>`;
}

/** The eval snippet send-login runs on his lianki.com tab: collect the keys, navigate. */
export function sendLoginCode(enterUrl: string): string {
  const allow = copyableKey.toString();
  return `const copyableKey = ${allow};
const o = {};
for (const k of Object.keys(localStorage)) { const v = localStorage.getItem(k) ?? ""; if (copyableKey(k, v)) o[k] = v; }
setTimeout(() => location.assign(${JSON.stringify(enterUrl)} + "#" + encodeURIComponent(JSON.stringify(o))), 300);
"navigating"`;
}

/**
 * The owner's local preview servers (widget, islands, …) live on the lab site,
 * `https://<mac>.ts.net/lianki-*` (tailscale serve). They answer CORS for
 * lianki.com only, so a dev page could not read them cross-origin ("Could not
 * load the tree"). The guard serves them on the dev origin instead — same
 * origin, no CORS — after the owner check.
 */
export const LAB_PREFIX = "/lianki-";

export function isLabPath(pathname: string): boolean {
  return pathname.startsWith(LAB_PREFIX);
}

/** A carried localStorage value pointing at the lab site, re-pointed at the dev origin. */
export function toDevOrigin(value: string, lab: string, origin: string): string {
  return value.startsWith(`${lab}${LAB_PREFIX}`) ? origin + value.slice(lab.length) : value;
}

/**
 * lianki.com routes the dev server cannot serve itself (no Workers AI
 * credentials on the Mac): read aloud and cloud STT. The guard sends them to
 * lianki.com with the dev bridge header, which those two routes accept as the
 * owner (lib/dev-bridge-user.ts; owner decision 2026-10-31 02:11 JST).
 */
export const BRIDGED_PATHS = ["/api/words/tts", "/api/debug/stt"];

export function isBridgedPath(pathname: string): boolean {
  return BRIDGED_PATHS.includes(pathname);
}

/** Merges this close together reach the served tree as one update (one reload). */
export const PUBLISH_QUIET_MS = 3000;

/**
 * Coalesces publish requests: run() once, PUBLISH_QUIET_MS after the last
 * request. A request during a run schedules one more run after it.
 */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private again = false;
  constructor(
    private run: () => Promise<void>,
    private quietMs = PUBLISH_QUIET_MS,
  ) {}

  request(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fire(), this.quietMs);
  }

  private async fire(): Promise<void> {
    this.running = true;
    try {
      await this.run();
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.request();
      }
    }
  }
}

/** A publish that brings any of these needs `intlayer build` (next dev misses them). */
export function needsIntlayerBuild(changedFiles: string[]): boolean {
  return changedFiles.some(
    (f) => /\.content\.(ts|tsx|js|mjs|json)$/.test(f) || f.startsWith("intlayer.config."),
  );
}

/**
 * Tailscale identity (owner decision, 2026-10-31 02:08 JST, typed "1同意"):
 * his own devices on the tailnet are let in without a one-time link.
 *
 * `tailscale serve` adds Tailscale-User-Login to what it proxies; the guard
 * believes it only on the loopback listener that tailscale serve targets
 * (`trusted`). On the LAN listener the header is a forgery and the request is
 * refused. Only `ownerLogin` (the Mac's own Tailscale user) passes.
 */
export const TS_LOGIN_HEADER = "tailscale-user-login";
export const TS_HEADERS = [TS_LOGIN_HEADER, "tailscale-user-name", "tailscale-user-profile-pic"];

export type TailnetIdentity = "owner" | "forged" | "none";

export function tailnetIdentity(
  login: string | string[] | undefined,
  trusted: boolean,
  ownerLogin: string,
): TailnetIdentity {
  const v = Array.isArray(login) ? login.join(",") : login;
  if (v === undefined) return "none";
  if (!trusted) return "forged";
  return ownerLogin !== "" && v.trim().toLowerCase() === ownerLogin.toLowerCase()
    ? "owner"
    : "none";
}

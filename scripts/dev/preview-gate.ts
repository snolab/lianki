/**
 * The gate in front of the whole-page dev server on its public tunnel,
 * https://preview.lianki.com (docs/dev-whole-page.md, "Off the tailnet").
 * cloudflared reaches only the guard's loopback tunnel listener, and every
 * request there passes this first. Pure decisions plus two injected calls
 * (verify, active), so unit/preview-gate.test.ts pins every rule.
 *
 * - No valid token, no entry: 503 for everything, static files included —
 *   except the dev site's own app files (GateDeps.pwa: manifest, service
 *   worker, badged icons), which hold no data and must load without cookies.
 * - A token is a dev access token the owner minted on lianki.com
 *   (lib/dev-access.ts), checked by lianki.com over the dev bridge. Browsers
 *   trade it once at /_lk/dev-auth (a form POST; from a link, the token rides
 *   in the #fragment and the page strips it at once) for an HttpOnly, Secure,
 *   SameSite=Lax, host-only cookie. Tools send `Authorization: Bearer`.
 * - The session cookie names its token id; the gate re-checks that id with
 *   lianki.com at most RECHECK_MS apart, so revoking the token ends the
 *   session. It lasts SESSION_MAX_MS at most, never past the token.
 * - The token signs in as the owner the dev server's login route mints, and
 *   nobody else: a token minted by any other account is refused.
 * - Only Host: <publicHost> is served. Tailscale identity headers are never
 *   believed here (they are stripped), so the tunnel can never pass for his
 *   tailnet device.
 * - A browser opening a page here without a session (a top-level navigation)
 *   gets the same 503 as a small page with one link: the owner-only entry on
 *   lianki.com (lib/dev-server-switch.ts, previewEntryUrl), which runs the
 *   profile menu's switch and comes back to the same path. Assets, APIs and
 *   sockets keep the plain 503.
 */

import { previewEntryUrl } from "../../lib/dev-server-switch";
import {
  LIVE_GATE_HEADER,
  filterTunnelHeaders,
  isServiceWorkerScript,
  tunnelHeaderDropped,
} from "../../lib/live-view/tunnel-headers";

export const AUTH_PATH = "/_lk/dev-auth";
export const UP_PATH = "/_lk/up";
export const SIGN_OUT_PATH = "/_lk/sign-out";
/** `__Host-`: Secure, Path=/, no Domain, so only this exact host ever gets it. */
export const SESSION_COOKIE = "__Host-lk_preview";
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
/** A session's token id is re-checked with lianki.com at most this far apart. */
export const RECHECK_MS = 30_000;
/**
 * Failed token checks per IP before 429. There is deliberately no global
 * failure lockout: one would let anyone with a few IPs lock the owner out
 * with no token at all. Load is bounded by VerifyQueue instead (below),
 * queues and never refuses a credential that would verify.
 */
export const FAILS_PER_IP = 10;
export const FAIL_WINDOW_MS = 10 * 60 * 1000;
/** Token checks in flight to lianki.com at once (VerifyQueue)… */
export const VERIFY_CONCURRENCY = 4;
/** …waiting behind them: VERIFY_MAX_PENDING waiting (not counting the ones running, so up to 36 in all), and VERIFY_PER_IP per IP counting waiting + running… */
export const VERIFY_MAX_PENDING = 32;
export const VERIFY_PER_IP = 2;
/** …and how long one may wait before it is answered 503. */
export const VERIFY_DEADLINE_MS = 5_000;
/** Where a handshake lands unless it names a path of its own. */
export const DEFAULT_NEXT = "/__dev/landing";
/** lianki.com, where the owner's profile menu posts handoffs from. */
export const PROD_ORIGIN = "https://lianki.com";

export type Verified = {
  id: string;
  email: string;
  kind: "token" | "handoff";
  sessionUntilMs: number;
};

export type GateDeps = {
  publicHost: string;
  /**
   * The account the dev server's login route signs in: the oldest active
   * `dev` grant (account_permission), asked of lianki.com ("" when it cannot be read: nobody passes).
   */
  ownerEmail: string | (() => Promise<string>);
  /** HMAC key for the session cookie (local; .dev-whole-page.json). */
  sessionKey: string;
  /**
   * LIVE_GATE_SECRET's local copy (.dev-whole-page.json `liveSecret`): the
   * lianki Worker's entry for the same-origin live preview
   * (lib/live-view/page-proxy.ts), sent in LIVE_GATE_HEADER. Unset or shorter
   * than LIVE_SECRET_MIN: that entry is shut.
   */
  liveSecret?: string;
  verify(token: string): Promise<Verified | null>;
  active(ids: string[]): Promise<string[]>;
  /**
   * The dev site's own app (lib/dev-site/pwa.ts): a path → its manifest,
   * service worker or badged icon, or null. Served without a session: Chrome
   * fetches a manifest and its icons without cookies, so behind the gate the
   * app could not be installed ("无法安装应用", 2026-11-15). They hold no data.
   */
  pwa?: (pathname: string) => { type: string; body: string | Uint8Array } | null;
  now?: () => number;
  log?: (msg: string) => void;
};

export type Headers = Record<string, string | string[] | undefined>;
export type GateRequest = {
  method: string;
  /** Path and query, as on the request line. */
  url: string;
  headers: Headers;
  /** The body, read only for the handshake POST. */
  body?: () => Promise<string>;
  /** Aborted when the client goes away: a queued token check is then dropped. */
  signal?: AbortSignal;
};
export type GateResult =
  | {
      kind: "respond";
      status: number;
      headers: Record<string, string | string[]>;
      body: string | Uint8Array;
    }
  | { kind: "forward"; tokenId: string; untilMs: number; via?: "worker" };

/** The Worker entry's pseudo token id (never a dev_access_token id: those are random base64url). */
export const WORKER_TOKEN_ID = "live-worker";
/** A socket opened through the Worker entry is closed after this long (the page reconnects). */
export const WORKER_SOCKET_MS = 60 * 60 * 1000;
/** A Worker secret shorter than this never matches. */
export const LIVE_SECRET_MIN = 32;

const NO_STORE = {
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/**
 * The gate's only service worker: it deletes this origin's caches and
 * unregisters itself. A worker the app registered on the preview origin before
 * the gate refused them (2026-11-05) kept answering /_next/static from its
 * cache-first store; dev chunk names do not change with their code, so the
 * page ran a day-old bundle (an icon map without `books`, a TypeError). A 403
 * only fails the worker's update check and leaves it running; this replaces it.
 * No fetch handler: from activation on, every request goes to the network.
 */
export const SW_KILL_SWITCH = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister()),
  ),
);
`;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(
    new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))),
  );
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export type Session = { tid: string; exp: number };

export async function sealSession(key: string, s: Session): Promise<string> {
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${body}.${await hmac(key, body)}`;
}

export async function openSession(
  key: string,
  v: string | undefined,
  now: number,
): Promise<Session | null> {
  if (!v) return null;
  const [body, sig] = v.split(".");
  if (!body || !sig || !safeEqual(sig, await hmac(key, body))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString()) as Session;
    if (typeof s.tid !== "string" || typeof s.exp !== "number" || s.exp <= now) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * A same-origin path to land on, or DEFAULT_NEXT. Browsers drop TAB, LF and
 * CR from a URL before parsing it, and read "\\" as "/", so "/\t/evil.example"
 * or "/\\evil.example" would leave the site: any control character or
 * backslash is refused outright. What is left must parse, against the
 * preview origin, to that same origin and a path with a single leading "/".
 */
export function safeNext(
  raw: string | null | undefined,
  publicHost = "preview.lianki.com",
): string {
  const v = raw ?? "";
  if (!v || v.length > 2000) return DEFAULT_NEXT;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return DEFAULT_NEXT;
  if (!v.startsWith("/") || v.startsWith("//")) return DEFAULT_NEXT;
  const base = `https://${publicHost}`;
  let u: URL;
  try {
    u = new URL(v, base);
  } catch {
    return DEFAULT_NEXT;
  }
  if (u.origin !== base) return DEFAULT_NEXT;
  const out = `${u.pathname}${u.search}${u.hash}`;
  if (!out.startsWith("/") || out.startsWith("//")) return DEFAULT_NEXT;
  return out;
}

/** The handshake page: takes the token from the #fragment (never sent anywhere), strips it, posts it. */
export function handshakeHtml(): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Lianki preview build</title>
<body style="font:16px system-ui;margin:2rem;max-width:32rem">
<p><b>Lianki preview build</b> (trial code, production data). Paste a dev access token from lianki.com/dev/tokens:</p>
<form method="post" action="${AUTH_PATH}" id="f"><input type="password" name="token" autocomplete="off" style="width:100%;font-size:16px"><input type="hidden" name="next" id="n"><p><button>Open</button></p></form>
<script>
(function () {
  var h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname);
  var t = h.get("token");
  if (h.get("next")) document.getElementById("n").value = h.get("next");
  if (t) { document.querySelector("[name=token]").value = t; document.getElementById("f").submit(); }
})();
</script>`;
}

/**
 * A top-level browser navigation (the address bar, a tapped link): GET,
 * Sec-Fetch-Mode: navigate, Sec-Fetch-Dest: document (when sent), and an
 * Accept that asks for HTML. Assets, fetches, frames and sockets are not.
 */
export function isNavigation(req: { method: string; headers: Headers }): boolean {
  if (req.method !== "GET") return false;
  if ((one(req.headers["sec-fetch-mode"]) ?? "").trim().toLowerCase() !== "navigate") return false;
  const dest = (one(req.headers["sec-fetch-dest"]) ?? "").trim().toLowerCase();
  if (dest && dest !== "document") return false;
  return /(^|,)\s*text\/html\s*(;|,|$)/i.test(one(req.headers.accept) ?? "");
}

const PAGE_CSS =
  ":root{color-scheme:light dark;--bg:oklch(0.98 0.005 250);--fg:oklch(0.25 0.02 250);--mute:oklch(0.5 0.02 250);--btn:oklch(0.55 0.18 255);--btn-fg:oklch(0.99 0 0)}" +
  "@media (prefers-color-scheme:dark){:root{--bg:oklch(0.18 0.01 250);--fg:oklch(0.93 0.01 250);--mute:oklch(0.7 0.02 250);--btn:oklch(0.65 0.16 255);--btn-fg:oklch(0.15 0.01 250)}}" +
  "body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}" +
  "main{max-width:24rem;padding:2rem 1rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.25rem 0;color:var(--mute)}" +
  "a{display:inline-block;margin-top:1.5rem;padding:.75rem 1.25rem;border-radius:999px;background:var(--btn);color:var(--btn-fg);text-decoration:none;font-weight:600}";
const PAGE_CSS_HASH = new Bun.CryptoHasher("sha256").update(PAGE_CSS).digest("base64");
/** No script, no external anything: only the one inline style, by hash. */
export const CLOSED_PAGE_CSP = `default-src 'none'; style-src 'sha256-${PAGE_CSS_HASH}'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`;

const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The 503 page for a navigation without a session: the way in is lianki.com, for the owner. */
export function closedPageHtml(pathAndQuery: string): string {
  const href = escAttr(previewEntryUrl(pathAndQuery));
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>Lianki 预览版</title><style>${PAGE_CSS}</style>
<main><h1>Lianki 预览版 · Preview build</h1>
<p>这是开发者自用的预览版，需要从 lianki.com 进入。</p>
<p lang="en">This is the owner's preview build. Enter it from lianki.com.</p>
<a href="${href}" rel="noreferrer">从 lianki.com 进入预览版 / Enter via lianki.com</a></main>`;
}

/** Failure counting for the handshake and bearer checks, per IP. */
export class Fails {
  private hits = new Map<string, number[]>();
  constructor(private now: () => number) {}
  private recent(k: string): number[] {
    const cut = this.now() - FAIL_WINDOW_MS;
    const v = (this.hits.get(k) ?? []).filter((t) => t > cut);
    if (v.length) this.hits.set(k, v);
    else this.hits.delete(k);
    return v;
  }
  /** Blocked once its recent failures plus its attempts still in flight reach the limit. */
  blocked(ip: string, inFlight = 0): boolean {
    return this.recent(`ip:${ip}`).length + inFlight >= FAILS_PER_IP;
  }
  add(ip: string) {
    const v = this.recent(`ip:${ip}`);
    v.push(this.now());
    this.hits.set(`ip:${ip}`, v);
  }
}

export type QueueRefusal = "busy" | "ip" | "timeout" | "aborted";
export type QueueResult<T> = { ok: true; value: T } | { ok: false; why: QueueRefusal };

/**
 * Token checks to lianki.com: at most `concurrency` in flight; a bounded
 * queue behind them (`maxPending` waiting, not counting the running ones; `perIp` per IP counting both
 * waiting and running); every waiter has a deadline and is dropped the
 * moment its client goes away; and the per-IP admission is checked again
 * when a waiter's turn comes. Refusals are immediate answers, never a
 * backlog that runs after its clients have left.
 */
export class VerifyQueue {
  private running = 0;
  private pending: {
    ip: string;
    go: () => void;
    fail: (why: QueueRefusal) => void;
  }[] = [];
  private perIpCount = new Map<string, number>();

  constructor(
    private o: {
      concurrency: number;
      maxPending: number;
      perIp: number;
      deadlineMs: number;
      /** May this IP try now? `others`: its other attempts waiting or running. */
      admit: (ip: string, others: number) => boolean;
      setTimer?: (f: () => void, ms: number) => unknown;
      clearTimer?: (t: unknown) => void;
    },
  ) {}

  /** This IP's attempts waiting or running. */
  count(ip: string): number {
    return this.perIpCount.get(ip) ?? 0;
  }

  /** Waiting and running in all (tests and logs). */
  size() {
    return { running: this.running, pending: this.pending.length };
  }

  private inc(ip: string, by: number) {
    const n = this.count(ip) + by;
    if (n > 0) this.perIpCount.set(ip, n);
    else this.perIpCount.delete(ip);
  }

  async run<T>(ip: string, f: () => Promise<T>, signal?: AbortSignal): Promise<QueueResult<T>> {
    if (signal?.aborted) return { ok: false, why: "aborted" };
    if (!this.o.admit(ip, this.count(ip)) || this.count(ip) >= this.o.perIp)
      return { ok: false, why: "ip" };
    if (this.running >= this.o.concurrency || this.pending.length) {
      if (this.pending.length >= this.o.maxPending) return { ok: false, why: "busy" };
      this.inc(ip, 1);
      const setT = this.o.setTimer ?? ((g, ms) => setTimeout(g, ms));
      const clearT = this.o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
      const why = await new Promise<QueueRefusal | null>((resolve) => {
        const w = {
          ip,
          go: () => {
            done();
            resolve(null);
          },
          fail: (r: QueueRefusal) => {
            done();
            resolve(r);
          },
        };
        const leave = (r: QueueRefusal) => {
          const i = this.pending.indexOf(w);
          if (i >= 0) this.pending.splice(i, 1);
          w.fail(r);
        };
        const timer = setT(() => leave("timeout"), this.o.deadlineMs);
        const onAbort = () => leave("aborted");
        signal?.addEventListener("abort", onAbort, { once: true });
        const done = () => {
          clearT(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        this.pending.push(w);
      });
      if (why) {
        this.inc(ip, -1);
        return { ok: false, why };
      }
      // Its turn (next() reserved the slot): the client may have gone, or its
      // IP filled up meanwhile.
      if (signal?.aborted || !this.o.admit(ip, this.count(ip) - 1)) {
        this.running--;
        this.inc(ip, -1);
        this.next();
        return { ok: false, why: signal?.aborted ? "aborted" : "ip" };
      }
    } else {
      this.inc(ip, 1);
      this.running++;
    }
    try {
      return { ok: true, value: await f() };
    } finally {
      this.running--;
      this.inc(ip, -1);
      this.next();
    }
  }

  /** Give a free slot to the next waiter, reserving it now so nothing jumps the queue. */
  private next() {
    if (this.running >= this.o.concurrency) return;
    const w = this.pending.shift();
    if (!w) return;
    this.running++;
    w.go();
  }
}

/**
 * Upgraded sockets (HMR, the hub's chat) outlive the request that was gated,
 * so they are watched: each is registered with its token id and session end.
 * Per token id there is ONE re-check timer, every RECHECK_MS (the same cadence
 * as page requests): a revoked token or a failed re-check (lianki.com
 * unreachable) closes every socket of that token. And ONE one-shot timer at
 * the earliest session end among its sockets closes those exactly then, and
 * re-arms for the next. Both stop with the token's last socket.
 */
export class SocketWatch {
  private byToken = new Map<
    string,
    {
      timer: unknown;
      end?: { at: number; timer: unknown };
      socks: Map<number, { until: number; close: () => void }>;
    }
  >();
  private nextId = 1;
  constructor(
    private d: {
      active: (ids: string[]) => Promise<string[]>;
      now?: () => number;
      every?: (f: () => void, ms: number) => unknown;
      stop?: (t: unknown) => void;
      once?: (f: () => void, ms: number) => unknown;
      cancel?: (t: unknown) => void;
      log?: (msg: string) => void;
    },
  ) {}

  private now() {
    return (this.d.now ?? Date.now)();
  }
  private once(f: () => void, ms: number) {
    return (this.d.once ?? ((g, m) => setTimeout(g, m)))(f, ms);
  }
  private cancel(t: unknown) {
    (this.d.cancel ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(t);
  }

  /** Watch one socket; returns its unwatch (call it when the socket closes). */
  add(tokenId: string, untilMs: number, close: () => void): () => void {
    if (untilMs <= this.now()) {
      close();
      return () => {};
    }
    let t = this.byToken.get(tokenId);
    if (!t) {
      const every = this.d.every ?? ((f, ms) => setInterval(f, ms));
      t = { timer: undefined, socks: new Map() };
      this.byToken.set(tokenId, t);
      t.timer = every(() => void this.check(tokenId), RECHECK_MS);
    }
    const id = this.nextId++;
    t.socks.set(id, { until: untilMs, close });
    this.arm(tokenId);
    return () => this.drop(tokenId, id);
  }

  /** Sockets watched now, and token timers running (for tests and logs). */
  count() {
    let socks = 0;
    for (const t of this.byToken.values()) socks += t.socks.size;
    return { socks, timers: this.byToken.size };
  }

  /** The one-shot timer at the earliest session end of this token's sockets. */
  private arm(tokenId: string) {
    const t = this.byToken.get(tokenId);
    if (!t) return;
    let at = Infinity;
    for (const s of t.socks.values()) at = Math.min(at, s.until);
    if (t.end && t.end.at === at) return;
    if (t.end) this.cancel(t.end.timer);
    t.end = undefined;
    if (at === Infinity) return;
    t.end = {
      at,
      timer: this.once(() => this.expire(tokenId, true), Math.max(0, at - this.now())),
    };
  }

  /**
   * Close the sockets whose session has ended, then re-arm. `fired`: called by
   * the one-shot timer itself, which is spent; otherwise (the 30 s check) the
   * pending one-shot is left to arm(), which keeps it if the earliest end is
   * unchanged and cancels it before replacing it — never an orphan timer.
   */
  private expire(tokenId: string, fired = false) {
    const t = this.byToken.get(tokenId);
    if (!t) return;
    if (fired) t.end = undefined;
    for (const [id, s] of [...t.socks])
      if (s.until <= this.now()) {
        this.drop(tokenId, id);
        s.close();
      }
    this.arm(tokenId);
  }

  private drop(tokenId: string, id: number) {
    const t = this.byToken.get(tokenId);
    if (!t) return;
    t.socks.delete(id);
    if (!t.socks.size) {
      (this.d.stop ?? ((x) => clearInterval(x as ReturnType<typeof setInterval>)))(t.timer);
      if (t.end) this.cancel(t.end.timer);
      this.byToken.delete(tokenId);
    } else this.arm(tokenId);
  }

  /** Close every socket of a token (revoked, or the re-check failed). */
  closeToken(tokenId: string, why: string) {
    const t = this.byToken.get(tokenId);
    if (!t) return;
    this.d.log?.(`gate: closing ${t.socks.size} socket(s) of ${tokenId} (${why})`);
    for (const [id, s] of [...t.socks]) {
      this.drop(tokenId, id);
      s.close();
    }
  }

  async check(tokenId: string): Promise<void> {
    const t = this.byToken.get(tokenId);
    if (!t) return;
    // Ended sessions close on their own (the one-shot timer does it too).
    this.expire(tokenId);
    if (!this.byToken.has(tokenId)) return;
    let ok = false;
    try {
      ok = (await this.d.active([tokenId])).includes(tokenId);
    } catch {
      ok = false; // fail closed
    }
    if (!ok) this.closeToken(tokenId, "revoked, expired or not re-checked");
  }
}

export function createGate(d: GateDeps) {
  const now = d.now ?? Date.now;
  const log = d.log ?? (() => {});
  const fails = new Fails(now);
  const queue = new VerifyQueue({
    concurrency: VERIFY_CONCURRENCY,
    maxPending: VERIFY_MAX_PENDING,
    perIp: VERIFY_PER_IP,
    deadlineMs: VERIFY_DEADLINE_MS,
    // Attempts in flight count towards the IP's limit, at entry and at its turn.
    admit: (ip, others) => !fails.blocked(ip, others),
  });
  /** A token check through the queue: the verification, or why it was not run. */
  async function verify(
    t: string,
    ip: string,
    signal?: AbortSignal,
  ): Promise<{ v: Verified | null } | { refused: QueueRefusal }> {
    const r = await queue.run(
      ip,
      async () => {
        try {
          return await d.verify(t);
        } catch {
          return null;
        }
      },
      signal,
    );
    return r.ok ? { v: r.value } : { refused: r.why };
  }
  const refusedAnswer = (why: QueueRefusal) =>
    why === "ip"
      ? respond(429, "429 — too many token attempts from here; wait a moment.\n", {
          "retry-after": "60",
        })
      : (log(`gate: 503 (token check ${why})`),
        respond(503, "503 — Lianki dev server: busy, try again.\n", { "retry-after": "5" }));
  /** token id → when it was last confirmed active. */
  const confirmed = new Map<string, number>();
  /** Bearer tokens (by sha-256) → their verification, briefly. */
  const bearer = new Map<string, { v: Verified; at: number }>();

  const respond = (
    status: number,
    body: string | Uint8Array,
    headers: Record<string, string | string[]> = {},
  ): GateResult => ({
    kind: "respond",
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE, ...headers },
    body,
  });
  const closed = (why: string) => {
    log(`gate: 503 (${why})`); // the reason only, never a token
    return respond(503, "503 — Lianki dev server: a dev access token is required.\n");
  };
  /** The same 503; a page with the way in (via lianki.com) for a browser navigation. */
  const closedFor = (req: GateRequest, why: string) => {
    if (!isNavigation(req)) return closed(why);
    log(`gate: 503 page (${why})`);
    const u = new URL(req.url, "http://x");
    return respond(503, closedPageHtml(`${u.pathname}${u.search}`), {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CLOSED_PAGE_CSP,
      "x-frame-options": "DENY",
    });
  };

  async function stillActive(tid: string): Promise<boolean> {
    const at = confirmed.get(tid);
    if (at !== undefined && now() - at < RECHECK_MS) return true;
    let ok = false;
    try {
      ok = (await d.active([tid])).includes(tid);
    } catch {
      ok = false; // lianki.com unreachable: fail closed
    }
    if (ok) confirmed.set(tid, now());
    else confirmed.delete(tid);
    return ok;
  }

  const okFor = async (v: Verified | null) => {
    if (!v) return false;
    const owner = typeof d.ownerEmail === "string" ? d.ownerEmail : await d.ownerEmail();
    return Boolean(owner) && v.email.toLowerCase() === owner.toLowerCase();
  };

  async function handshake(req: GateRequest, ip: string): Promise<GateResult> {
    if (req.method === "GET") {
      if (new URL(req.url, "http://x").searchParams.has("token"))
        // A token in a query string reaches access logs and history: refused unread.
        return respond(400, "Put the token after # (or paste it), never in the query.\n");
      return respond(200, handshakeHtml(), {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
    }
    if (req.method !== "POST") return respond(405, "405\n");
    const origin = one(req.headers.origin);
    if (
      origin &&
      origin !== `https://${d.publicHost}` &&
      origin !== PROD_ORIGIN &&
      origin !== "null"
    )
      return closed("handshake from another site");
    if (fails.blocked(ip))
      return respond(429, "429 — too many failed tokens; wait 10 minutes.\n", {
        "retry-after": "600",
      });
    const form = new URLSearchParams((await req.body?.()) ?? "");
    const token = form.get("token") ?? form.get("handoff") ?? "";
    const next = safeNext(form.get("next"), d.publicHost);
    const r = await verify(token.trim(), ip, req.signal);
    if ("refused" in r) return refusedAnswer(r.refused);
    const v = r.v;
    if (!(await okFor(v)) || !v) {
      fails.add(ip);
      return closed("handshake: bad, used, expired or revoked token");
    }
    const exp = Math.min(v.sessionUntilMs, now() + SESSION_MAX_MS);
    const cookie = await sealSession(d.sessionKey, { tid: v.id, exp });
    confirmed.set(v.id, now());
    log(`gate: signed in (${v.kind} ${v.id})`);
    return respond(303, "", {
      location: next,
      "set-cookie": `${SESSION_COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((exp - now()) / 1000))}`,
      // Entering starts clean: a browser that kept hours-old chunks or a redirect
      // (Cloudflare's 4 h browser TTL, before no-store) looped on the way in
      // without ever asking us again (2026-11-14, Windows). This POST is the one
      // request such a browser still sends, so it carries the reset. The cache
      // only: "storage" also wiped localStorage — lk:debug, his settings — and the
      // chat disappeared with it.
      "clear-site-data": '"cache"',
    });
  }

  return {
    async handle(req: GateRequest): Promise<GateResult> {
      const host = (one(req.headers.host) ?? "").trim().toLowerCase();
      if (host !== d.publicHost) return closed("wrong host");
      const ip = (one(req.headers["cf-connecting-ip"]) ?? "?").trim();
      const path = new URL(req.url, "http://x").pathname;
      // The dev site's manifest, service worker and icons: public, no session.
      const app = req.method === "GET" || req.method === "HEAD" ? d.pwa?.(path) : null;
      if (app)
        return respond(200, req.method === "HEAD" ? "" : app.body, { "content-type": app.type });
      // Any other service worker from dev code would outlive the preview and control
      // every later page of the origin: never served here, signed in or not.
      // In its place, a worker that removes itself and its caches: a 403
      // leaves one registered earlier in place for good, serving stale chunks.
      if (isServiceWorkerScript(path, one(req.headers["service-worker"])))
        return respond(200, SW_KILL_SWITCH, {
          "content-type": "text/javascript; charset=utf-8",
        });
      if (path === UP_PATH)
        // The profile menu's one check when it opens: the gate answers (the
        // tunnel is up), and still with 503 — nothing here is a way in.
        return respond(503, "gate up\n", {
          "x-lianki-gate": "1",
          "access-control-allow-origin": PROD_ORIGIN,
          "access-control-expose-headers": "x-lianki-gate",
        });
      if (path === AUTH_PATH) return handshake(req, ip);
      if (path === SIGN_OUT_PATH)
        return respond(303, "", {
          location: PROD_ORIGIN,
          "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        });

      // The lianki Worker, for the same-origin live preview: its own secret,
      // never a cookie. It has already checked the owner's session and the
      // signed pointer; here it is let through as the owner, like a token.
      const worker = one(req.headers[LIVE_GATE_HEADER]);
      if (worker !== undefined) {
        if (fails.blocked(ip)) return respond(429, "429\n", { "retry-after": "600" });
        const s = d.liveSecret ?? "";
        if (s.length < LIVE_SECRET_MIN || !safeEqual(worker.trim(), s)) {
          fails.add(ip);
          return closed("worker: bad secret");
        }
        return {
          kind: "forward",
          tokenId: WORKER_TOKEN_ID,
          untilMs: now() + WORKER_SOCKET_MS,
          via: "worker",
        };
      }

      const auth = one(req.headers.authorization) ?? "";
      if (auth) {
        const m = /^Bearer\s+(lkdev_[A-Za-z0-9_-]+)$/.exec(auth.trim());
        if (!m) return closed("bad authorization");
        const key = new Bun.CryptoHasher("sha256").update(m[1]).digest("hex");
        const hit = bearer.get(key);
        // A token verified moments ago is served at once, never queued.
        let v = hit && now() - hit.at < RECHECK_MS ? hit.v : null;
        if (!v) {
          if (fails.blocked(ip)) return respond(429, "429\n", { "retry-after": "600" });
          const r = await verify(m[1], ip, req.signal);
          if ("refused" in r) return refusedAnswer(r.refused);
          v = r.v;
          if (v) bearer.set(key, { v, at: now() });
        }
        if (!(await okFor(v)) || !v) {
          bearer.delete(key);
          fails.add(ip);
          return closed("bearer: bad token");
        }
        if (v.sessionUntilMs <= now()) return closed("bearer: expired");
        return { kind: "forward", tokenId: v.id, untilMs: v.sessionUntilMs };
      }

      const s = await openSession(
        d.sessionKey,
        readCookie(one(req.headers.cookie), SESSION_COOKIE),
        now(),
      );
      if (!s) return closedFor(req, "no session");
      if (!(await stillActive(s.tid))) return closedFor(req, "token revoked or expired");
      return { kind: "forward", tokenId: s.tid, untilMs: s.exp };
    },
  };
}

/**
 * What goes upstream from the tunnel: no token, no gate cookie, no browser
 * better-auth cookie (the guard adds the owner's session itself), no
 * Tailscale identity. Preserve the authenticated public Host/Origin so the
 * app's same-origin checks see the origin the browser actually opened.
 */
export function upstreamHeaders(
  h: Headers,
  o: { publicHost: string; origin: string; drop: string[] },
): Headers {
  const out: Headers = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (key === "authorization" || key.startsWith("tailscale-") || key.startsWith("cf-")) continue;
    if (key === LIVE_GATE_HEADER) continue; // the Worker's secret never goes past the gate
    if (key === "forwarded" || key.startsWith("x-forwarded-")) continue;
    if (o.drop.includes(key)) continue;
    out[key] = v;
  }
  const cookies = (one(h.cookie) ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter(
      (c) =>
        c && !c.startsWith(`${SESSION_COOKIE}=`) && !/^(__Secure-|__Host-)?better-auth\./.test(c),
    );
  if (cookies.length) out.cookie = cookies.join("; ");
  else delete out.cookie;
  out.host = o.publicHost;
  const pub = `https://${o.publicHost}`;
  const org = one(h.origin);
  if (org === pub) out.origin = pub;
  else if (org) out.origin = "null"; // retain invalid-origin evidence; never fall back to Referer
  const ref = one(h.referer);
  if (ref?.startsWith(`${pub}/`)) out.referer = ref;
  else delete out.referer;
  return out;
}

/**
 * What goes back down: nothing that changes the browser's state for the
 * origin (lib/live-view/tunnel-headers.ts): no Set-Cookie at all (the gate's
 * own cookie is set by the gate, never by the app, and a browser on the
 * tunnel never holds an owner session of its own, so revoking the token is
 * the end of it), no Clear-Site-Data, CSP, CORS, HSTS or
 * Service-Worker-Allowed (the guard adds its own frame-ancestors after this).
 * Redirects to the dev server's own origin are pointed at the tunnel.
 */
export function downstreamHeaders(h: Headers, o: { publicHost: string; origin: string }): Headers {
  const out: Headers = filterTunnelHeaders({ ...h });
  const loc = one(h.location);
  if (loc?.startsWith(o.origin))
    out.location = `https://${o.publicHost}${loc.slice(o.origin.length)}`;
  return out;
}

const TOKEN_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * An upstream response head (a websocket's 101 above all), filtered like
 * downstreamHeaders: the status line, then only well-formed `name: value`
 * lines whose name may pass. A folded continuation line is dropped too, so
 * it cannot ride on a dropped header. `head` is everything before the blank
 * line; the result ends with it.
 */
export function filterResponseHead(head: string): string {
  const [status = "", ...lines] = head.split("\r\n");
  const kept = lines.filter((l) => {
    const i = l.indexOf(":");
    return i > 0 && TOKEN_NAME.test(l.slice(0, i)) && !tunnelHeaderDropped(l.slice(0, i));
  });
  return `${[status, ...kept].join("\r\n")}\r\n\r\n`;
}

/** The longest upstream response head read before its socket is given up. */
export const MAX_HEAD_BYTES = 16 * 1024;

/**
 * Splits an upgraded upstream socket's first bytes into its response head
 * (filtered, filterResponseHead) and what follows. Feed it every chunk:
 * `null` while the head is incomplete, then the bytes to write downstream
 * (the filtered head and the rest of that chunk), and every later chunk
 * unchanged. `"too-large"`: no head within MAX_HEAD_BYTES; close both ends.
 */
export function upgradeHeadFilter(max = MAX_HEAD_BYTES) {
  let buf = new Uint8Array(0);
  let done = false;
  return (chunk: Uint8Array): Uint8Array | null | "too-large" => {
    if (done) return chunk;
    const all = new Uint8Array(buf.length + chunk.length);
    all.set(buf);
    all.set(chunk, buf.length);
    const end = blankLine(all);
    if (end < 0 ? all.length > max : end > max) return "too-large";
    if (end < 0) {
      buf = all;
      return null;
    }
    done = true;
    buf = new Uint8Array(0);
    let text = "";
    for (const b of all.subarray(0, end)) text += String.fromCharCode(b); // latin1, byte for byte
    const head = Uint8Array.from(filterResponseHead(text), (c) => c.charCodeAt(0) & 0xff);
    const rest = all.subarray(end + 4);
    const out = new Uint8Array(head.length + rest.length);
    out.set(head);
    out.set(rest, head.length);
    return out;
  };
}

function blankLine(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++)
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  return -1;
}

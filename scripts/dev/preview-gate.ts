/**
 * The gate in front of the whole-page dev server on its public tunnel,
 * https://preview.lianki.com (docs/dev-whole-page.md, "Off the tailnet").
 * cloudflared reaches only the guard's loopback tunnel listener, and every
 * request there passes this first. Pure decisions plus two injected calls
 * (verify, active), so unit/preview-gate.test.ts pins every rule.
 *
 * - No valid token, no entry: 503 for everything, static files included.
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
 */

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
 * with no token at all. Load is bounded by VERIFY_CONCURRENCY instead, which
 * queues and never refuses a credential that would verify.
 */
export const FAILS_PER_IP = 10;
export const FAIL_WINDOW_MS = 10 * 60 * 1000;
/** Token checks in flight to lianki.com at once; more wait their turn. */
export const VERIFY_CONCURRENCY = 4;
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
  /** The account the dev server's login route signs in (OWNER_EMAILS[0]). */
  ownerEmail: string;
  /** HMAC key for the session cookie (local; .dev-whole-page.json). */
  sessionKey: string;
  verify(token: string): Promise<Verified | null>;
  active(ids: string[]): Promise<string[]>;
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
};
export type GateResult =
  | { kind: "respond"; status: number; headers: Record<string, string | string[]>; body: string }
  | { kind: "forward"; tokenId: string; untilMs: number };

const NO_STORE = {
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

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
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Lianki dev server</title>
<body style="font:16px system-ui;margin:2rem;max-width:32rem">
<p><b>Lianki dev server</b> (production data). Paste a dev access token from lianki.com/dev/tokens:</p>
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

/** Failure counting for the handshake and bearer checks. */
export class Fails {
  private hits = new Map<string, number[]>();
  constructor(private now: () => number) {}
  private recent(k: string): number[] {
    const cut = this.now() - FAIL_WINDOW_MS;
    const v = (this.hits.get(k) ?? []).filter((t) => t > cut);
    this.hits.set(k, v);
    return v;
  }
  blocked(ip: string): boolean {
    return this.recent(`ip:${ip}`).length >= FAILS_PER_IP;
  }
  add(ip: string) {
    this.recent(`ip:${ip}`).push(this.now());
  }
}

/** At most `n` calls at once; the rest wait (nothing is refused). */
export function limiter(n: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(f: () => Promise<T>): Promise<T> => {
    if (running >= n) await new Promise<void>((r) => waiting.push(r));
    running++;
    try {
      return await f();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/**
 * Upgraded sockets (HMR, the hub's chat) outlive the request that was gated,
 * so they are watched: each is registered with its token id and session end,
 * and ONE timer per token id re-checks that id with lianki.com every
 * RECHECK_MS (the same cadence as page requests). A revoked token, a failed
 * re-check (lianki.com unreachable) or an ended session closes every socket
 * of that token. The timer stops with the token's last socket.
 */
export class SocketWatch {
  private byToken = new Map<
    string,
    { timer: unknown; socks: Map<number, { until: number; close: () => void }> }
  >();
  private nextId = 1;
  constructor(
    private d: {
      active: (ids: string[]) => Promise<string[]>;
      now?: () => number;
      every?: (f: () => void, ms: number) => unknown;
      stop?: (t: unknown) => void;
      log?: (msg: string) => void;
    },
  ) {}

  private now() {
    return (this.d.now ?? Date.now)();
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
    return () => this.drop(tokenId, id);
  }

  /** Sockets watched now, and token timers running (for tests and logs). */
  count() {
    let socks = 0;
    for (const t of this.byToken.values()) socks += t.socks.size;
    return { socks, timers: this.byToken.size };
  }

  private drop(tokenId: string, id: number) {
    const t = this.byToken.get(tokenId);
    if (!t) return;
    t.socks.delete(id);
    if (!t.socks.size) {
      (this.d.stop ?? ((x) => clearInterval(x as ReturnType<typeof setInterval>)))(t.timer);
      this.byToken.delete(tokenId);
    }
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
    // Sessions that ended close on their own, whatever lianki.com says.
    for (const [id, s] of [...t.socks])
      if (s.until <= this.now()) {
        this.drop(tokenId, id);
        s.close();
      }
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
  const verifyLimit = limiter(VERIFY_CONCURRENCY);
  const verify = (t: string) => verifyLimit(() => d.verify(t));
  /** token id → when it was last confirmed active. */
  const confirmed = new Map<string, number>();
  /** Bearer tokens (by sha-256) → their verification, briefly. */
  const bearer = new Map<string, { v: Verified; at: number }>();

  const respond = (
    status: number,
    body: string,
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

  const okFor = (v: Verified | null) =>
    Boolean(v && v.email.toLowerCase() === d.ownerEmail.toLowerCase());

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
    let v: Verified | null = null;
    try {
      v = await verify(token.trim());
    } catch {
      v = null;
    }
    if (!okFor(v) || !v) {
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
    });
  }

  return {
    async handle(req: GateRequest): Promise<GateResult> {
      const host = (one(req.headers.host) ?? "").trim().toLowerCase();
      if (host !== d.publicHost) return closed("wrong host");
      const ip = (one(req.headers["cf-connecting-ip"]) ?? "?").trim();
      const path = new URL(req.url, "http://x").pathname;
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

      const auth = one(req.headers.authorization) ?? "";
      if (auth) {
        const m = /^Bearer\s+(lkdev_[A-Za-z0-9_-]+)$/.exec(auth.trim());
        if (!m) return closed("bad authorization");
        if (fails.blocked(ip)) return respond(429, "429\n", { "retry-after": "600" });
        const key = new Bun.CryptoHasher("sha256").update(m[1]).digest("hex");
        const hit = bearer.get(key);
        let v = hit && now() - hit.at < RECHECK_MS ? hit.v : null;
        if (!v) {
          try {
            v = await verify(m[1]);
          } catch {
            v = null;
          }
          if (v) bearer.set(key, { v, at: now() });
        }
        if (!okFor(v) || !v) {
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
      if (!s) return closed("no session");
      if (!(await stillActive(s.tid))) return closed("token revoked or expired");
      return { kind: "forward", tokenId: s.tid, untilMs: s.exp };
    },
  };
}

/**
 * What goes upstream from the tunnel: no token, no gate cookie, no browser
 * better-auth cookie (the guard adds the owner's session itself), no
 * Tailscale identity, and the dev server's own origin as Host/Origin.
 */
export function upstreamHeaders(
  h: Headers,
  o: { publicHost: string; origin: string; drop: string[] },
): Headers {
  const out: Headers = {};
  const originHost = new URL(o.origin).host;
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (key === "authorization" || key.startsWith("tailscale-") || key.startsWith("cf-")) continue;
    if (key === "x-forwarded-host" || key === "x-forwarded-proto" || key === "x-forwarded-for")
      continue;
    if (o.drop.includes(key)) continue;
    out[key] = v;
  }
  const cookies = (one(h.cookie) ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter(
      (c) => c && !c.startsWith(`${SESSION_COOKIE}=`) && !/^(__Secure-)?better-auth\./.test(c),
    );
  if (cookies.length) out.cookie = cookies.join("; ");
  else delete out.cookie;
  out.host = originHost;
  const pub = `https://${o.publicHost}`;
  const org = one(h.origin);
  if (org === pub) out.origin = o.origin;
  else if (org) delete out.origin; // another site's Origin never reaches the app
  const ref = one(h.referer);
  if (ref?.startsWith(`${pub}/`)) out.referer = o.origin + ref.slice(pub.length);
  else delete out.referer;
  return out;
}

/**
 * What goes back down: no better-auth cookie (a browser on the tunnel never
 * holds an owner session of its own, so revoking the token is the end of
 * it), and redirects to the dev server's own origin pointed at the tunnel.
 */
export function downstreamHeaders(h: Headers, o: { publicHost: string; origin: string }): Headers {
  const out: Headers = { ...h };
  const sc = h["set-cookie"];
  const list = Array.isArray(sc) ? sc : sc ? [sc] : [];
  const kept = list.filter((c) => !/^(__Secure-)?better-auth\./.test(c.trim()));
  if (kept.length) out["set-cookie"] = kept;
  else delete out["set-cookie"];
  const loc = one(h.location);
  if (loc?.startsWith(o.origin))
    out.location = `https://${o.publicHost}${loc.slice(o.origin.length)}`;
  return out;
}

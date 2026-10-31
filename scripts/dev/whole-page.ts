#!/usr/bin/env bun
/**
 * The whole-page dev server: the app from this working tree, with fast
 * refresh, against PRODUCTION D1 — for the owner's phone on the home LAN.
 * docs/dev-whole-page.md has the why, the security model and the runbook.
 *
 *   bun scripts/dev/whole-page.ts serve [--host 192.168.31.96] [--port 3100] [--origin https://<mac>.ts.net:8443]
 *       --origin: the address the phone opens, when it is not http://<host>:<port>
 *       — the `tailscale serve` HTTPS front (docs/dev-whole-page.md, "HTTPS").
 *       Starts `next dev` on 127.0.0.1:<port+1> (remote D1/R2 via
 *       wrangler.dev-whole-page.jsonc) and the guard proxy on <host>:<port>,
 *       a private-LAN address only. Loopback control port: <port+2>.
 *
 *   bun scripts/dev/whole-page.ts publish [--port 3100]
 *       After merging into preview/live (tree/preview): the served worktree
 *       fast-forwards to it 3 s after the last publish — one update per burst.
 *
 *   bun scripts/dev/whole-page.ts send-login [--port 3100] [--target Android]
 *       Issues a one-time enter link and navigates the owner's debug-mode
 *       Lianki tab to it through scripts/dev/eval.ts (an existing grant only,
 *       never pairs). The token is never printed: it goes from the control
 *       port straight into eval's stdin.
 *
 * Guard rules: scripts/dev/whole-page-guard.ts. Secrets (auth, device, guard)
 * are generated once into .dev-whole-page.json (gitignored, 0600).
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { DEV_BRIDGE_HEADER } from "../../lib/dev-bridge";
import { devWholePageOrigin } from "../../lib/dev-whole-page";
import { ownerEmails } from "../../lib/owner";
import {
  DEVICE_COOKIE,
  ENTER_PATH,
  EnterTokens,
  GUARD_HEADER,
  HUB_ORIGIN,
  isBridgedPath,
  needsIntlayerBuild,
  isLabPath,
  Debouncer,
  LANDING_PATH,
  isHubPath,
  landingHtml,
  sendLoginCode,
  TS_HEADERS,
  TS_LOGIN_HEADER,
  FRAME_ANCESTORS,
  tailnetIdentity,
  type SessionInfo,
  decide,
  deviceCookieValue,
  isPrivateLanHost,
  readCookie,
  sessionIsOwner,
  verifyDevice,
} from "./whole-page-guard";
import {
  SESSION_COOKIE,
  SocketWatch,
  type Verified,
  createGate,
  downstreamHeaders,
  upstreamHeaders,
} from "./preview-gate";

const STATE_FILE = ".dev-whole-page.json";
const SESSION_CACHE_MS = 60_000;
const YEAR_S = 365 * 24 * 60 * 60;

type State = {
  authSecret: string;
  deviceSecret: string;
  guardSecret: string;
  /** DEV_BRIDGE_SECRET's only other copy (the lianki Worker's): lib/dev-bridge.ts. */
  bridgeSecret: string;
  /** Signs the tunnel gate's session cookie (scripts/dev/preview-gate.ts). */
  previewKey: string;
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function loadState(): State {
  const hex = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const old: Partial<State> = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
    : {};
  const state: State = {
    authSecret: old.authSecret ?? hex(),
    deviceSecret: old.deviceSecret ?? hex(),
    guardSecret: old.guardSecret ?? hex(),
    bridgeSecret: old.bridgeSecret ?? hex(),
    previewKey: old.previewKey ?? hex(),
  };
  if (JSON.stringify(state) !== JSON.stringify(old)) {
    writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
    chmodSync(STATE_FILE, 0o600);
  }
  return state;
}

/** OWNER_EMAILS from wrangler.jsonc's vars — the same list production gates on. */
function ownerList(): string {
  const m = /"OWNER_EMAILS":\s*"([^"]*)"/.exec(readFileSync("wrangler.jsonc", "utf8"));
  return m?.[1] ?? "";
}

async function serve() {
  const host = arg("host", "192.168.31.96");
  const port = Number(arg("port", "3100"));
  const inner = port + 1;
  const control = port + 2;
  const tsPort = port + 3;
  // His Tailscale login: the one this Mac is signed in as, unless overridden.
  const tsLogin = arg(
    "tailscale-login",
    (() => {
      try {
        const j = JSON.parse(Bun.spawnSync(["tailscale", "status", "--json"]).stdout.toString());
        return String(j.User?.[String(j.Self?.UserID)]?.LoginName ?? "");
      } catch {
        return "";
      }
    })(),
  );
  if (!isPrivateLanHost(host)) throw new Error(`--host must be a private LAN IPv4, got ${host}`);
  for (const f of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    // Next would load it and could switch on Resend, Stripe or MongoDB.
    if (existsSync(f))
      throw new Error(`${f} exists; move it aside first (no side effects allowed)`);
  }

  const state = loadState();
  const owners = ownerList();
  if (!ownerEmails(owners).length) throw new Error("OWNER_EMAILS is empty in wrangler.jsonc");
  const origin = new URL(arg("origin", `http://${host}:${port}`)).origin;
  if (
    !devWholePageOrigin({
      LIANKI_DEV_WHOLE_PAGE: "1",
      NODE_ENV: "development",
      BETTER_AUTH_BASE_URL: origin,
    }).length
  ) {
    throw new Error(
      `--origin must be http(s) on a private LAN IP or https on *.ts.net, got ${origin}`,
    );
  }
  const secure = origin.startsWith("https:") ? "; Secure" : "";
  // The lab site (tailscale serve on :443) whose /lianki-* previews the guard
  // serves on this origin: the --origin host without its port, when on *.ts.net.
  const originUrl = new URL(origin);
  const lab = arg(
    "lab",
    originUrl.hostname.endsWith(".ts.net") ? `https://${originUrl.hostname}` : "",
  );

  // A clean env: only what the app needs. No RESEND_*/EMAIL_FROM (no mail),
  // no STRIPE_* (no payments), no MONGODB_URI, no OAuth secrets.
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "development",
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TERM: process.env.TERM ?? "dumb",
    NEXT_TELEMETRY_DISABLED: "1",
    LIANKI_DEV_WHOLE_PAGE: "1",
    LIANKI_DEV_GUARD_SECRET: state.guardSecret,
    DB_BACKEND: "d1",
    // Alias `mongodb` to its throwing stub, as the deployed Worker does: the
    // dev server can never reach MongoDB (and next dev under bun cannot load
    // the real driver as an external anyway).
    CF_BUILD: "1",
    OWNER_EMAILS: owners,
    BETTER_AUTH_BASE_URL: origin,
    AUTH_SECRET: state.authSecret,
  };
  const next = spawn("node_modules/.bin/next", ["dev", "-H", "127.0.0.1", "-p", String(inner)], {
    env,
    stdio: "inherit",
  });
  next.on("exit", (code) => {
    console.error(`[whole-page] next dev exited (${code})`);
    process.exit(code ?? 1);
  });

  const tokens = new EnterTokens();
  const device = await deviceCookieValue(state.deviceSecret);

  // The public tunnel (docs/dev-whole-page.md, "Off the tailnet"): only with
  // --public-host, on a loopback listener that only cloudflared targets.
  const publicHost = arg("public-host", "").toLowerCase();
  if (publicHost && !/^[a-z0-9-]+\.lianki\.com$/.test(publicHost))
    throw new Error(`--public-host must be a lianki.com subdomain, got ${publicHost}`);
  const verifyCall = async (body: unknown) => {
    const r = await fetch(`${HUB_ORIGIN}/api/dev-access/verify`, {
      method: "POST",
      headers: { [DEV_BRIDGE_HEADER]: state.bridgeSecret, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return r;
  };
  const activeCall = async (ids: string[]) => {
    const r = await verifyCall({ ids });
    if (!r.ok) throw new Error(`verify answered ${r.status}`);
    return ((await r.json()) as { active: string[] }).active;
  };
  const gate = publicHost
    ? createGate({
        publicHost,
        ownerEmail: ownerEmails(owners)[0] ?? "",
        sessionKey: state.previewKey,
        verify: async (token) => {
          const r = await verifyCall({ token });
          return r.ok ? ((await r.json()) as Verified) : null;
        },
        active: activeCall,
        log: (m) => console.error(`[whole-page] ${m}`),
      })
    : undefined;
  // Upgraded sockets on the tunnel: re-checked per token, closed on revoke (preview-gate.ts).
  const watch = new SocketWatch({
    active: activeCall,
    log: (m) => console.error(`[whole-page] ${m}`),
  });
  const sessions = new Map<string, { owner: boolean; exp: number }>();

  async function ownerSession(cookie: string | undefined): Promise<boolean> {
    if (!cookie) return false;
    const hit = sessions.get(cookie);
    if (hit && hit.exp > Date.now()) return hit.owner;
    const res = await fetch(`http://127.0.0.1:${inner}/api/auth/get-session`, {
      headers: { cookie, host: new URL(origin).host },
    });
    const info = (res.ok ? await res.json().catch(() => null) : null) as SessionInfo;
    const owner = sessionIsOwner(info, ownerEmails(owners));
    sessions.set(cookie, { owner, exp: Date.now() + SESSION_CACHE_MS });
    return owner;
  }

  function deny(res: http.ServerResponse, reason: string) {
    res.writeHead(403, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(`403 — Lianki dev server (owner only): ${reason}\n`);
  }

  function forwardHeaders(h: http.IncomingHttpHeaders) {
    const out = { ...h };
    delete out[GUARD_HEADER];
    delete out[DEV_BRIDGE_HEADER];
    for (const h of TS_HEADERS) delete out[h];
    return out;
  }

  /** To the lab site: its host, and no cookies or Origin of ours. */
  function labHeaders(h: http.IncomingHttpHeaders) {
    const out = forwardHeaders(h);
    out.host = new URL(lab).host;
    delete out.cookie;
    delete out.origin;
    delete out.referer;
    return out;
  }

  /** To lianki-push: its host and the Origin it insists on; the owner was already checked. */
  function hubHeaders(h: http.IncomingHttpHeaders) {
    const out = forwardHeaders(h);
    out.host = new URL(HUB_ORIGIN).host;
    out.origin = HUB_ORIGIN;
    // The dev bridge: lianki.com cannot read this origin's session cookie, so
    // the owner is proven with DEV_BRIDGE_SECRET instead (lib/dev-bridge.ts).
    out[DEV_BRIDGE_HEADER] = state.bridgeSecret;
    delete out.cookie;
    delete out["x-forwarded-host"];
    delete out["x-forwarded-proto"];
    delete out["x-forwarded-for"];
    return out;
  }

  async function enter(url: URL, res: http.ServerResponse) {
    if (!tokens.consume(url.searchParams.get("t"))) {
      console.error("[whole-page] enter: refused (bad, used or expired link)");
      return deny(res, "this link is used or expired");
    }
    return signIn(res, LANDING_PATH, "enter: device paired, owner signed in");
  }

  /** The guard's own owner session, "name=value", minted once and re-minted if it lapses. */
  let ownerCookie: string | undefined;
  async function mintOwnerCookie(): Promise<string | undefined> {
    const login = await fetch(`http://127.0.0.1:${inner}/api/dev-whole-page/login`, {
      method: "POST",
      headers: { [GUARD_HEADER]: state.guardSecret, host: new URL(origin).host, origin },
    });
    const first = login.ok ? login.headers.getSetCookie()[0] : undefined;
    return first?.split(";")[0];
  }

  /** `cookie` with his session in it, unless it already carries a working one. */
  async function withOwnerSession(cookie: string | undefined): Promise<string> {
    if (await ownerSession(cookie)) return cookie ?? "";
    if (!ownerCookie || !(await ownerSession(ownerCookie))) {
      ownerCookie = await mintOwnerCookie();
      if (ownerCookie) console.error("[whole-page] tailnet: owner session minted for his devices");
    }
    if (!ownerCookie) return cookie ?? "";
    const name = ownerCookie.split("=")[0];
    const rest = (cookie ?? "")
      .split(";")
      .map((c) => c.trim())
      .filter((c) => c && !c.startsWith(`${name}=`));
    return [...rest, ownerCookie].join("; ");
  }

  /** Framable by lianki.com only (the owner's iframe overlay), never by others. */
  function framable(h: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = { ...h };
    delete out["x-frame-options"];
    out["content-security-policy"] = FRAME_ANCESTORS;
    return out;
  }

  /** Pin the device, mint the owner's session, and go on to `location`. */
  async function signIn(res: http.ServerResponse, location: string, note: string) {
    const login = await fetch(`http://127.0.0.1:${inner}/api/dev-whole-page/login`, {
      method: "POST",
      headers: { [GUARD_HEADER]: state.guardSecret, host: new URL(origin).host, origin },
    });
    if (!login.ok) {
      console.error(`[whole-page] enter: login route answered ${login.status}`);
      return deny(res, `sign-in failed (${login.status})`);
    }
    sessions.clear();
    console.error(`[whole-page] ${note}`);
    res.writeHead(302, {
      location,
      "cache-control": "no-store",
      "set-cookie": [
        `${DEVICE_COOKIE}=${device}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR_S}${secure}`,
        ...login.headers.getSetCookie(),
      ],
    });
    res.end();
  }

  // `trusted`: the loopback listener that tailscale serve targets, the only
  // place a Tailscale-User-Login header is believed (whole-page-guard.ts).
  const handle =
    (trusted: boolean) => async (req: http.IncomingMessage, res: http.ServerResponse) => {
      try {
        const url = new URL(req.url ?? "/", origin);
        let deviceOk = await verifyDevice(
          readCookie(req.headers.cookie, DEVICE_COOKIE),
          state.deviceSecret,
        );
        const ts = tailnetIdentity(req.headers[TS_LOGIN_HEADER], trusted, tsLogin);
        if (ts === "forged")
          return deny(res, "a Tailscale identity is only believed via tailscale serve");
        // His tailnet device: the identity is the device proof, and the guard
        // supplies his session server-side, so the browser needs no cookie at
        // all — which is what makes the page work inside a lianki.com iframe,
        // where iOS Safari blocks third-party cookies.
        if (ts === "owner") {
          deviceOk = true;
          req.headers.cookie = await withOwnerSession(req.headers.cookie);
        }
        const d = decide(url.pathname, deviceOk);
        if (d.kind === "enter") return await enter(url, res);
        if (d.kind === "deny") return deny(res, d.reason);
        if (d.kind === "owner" && !(await ownerSession(req.headers.cookie))) {
          return deny(res, "not the owner's session — open a fresh enter link");
        }
        if (url.pathname === LANDING_PATH) {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          return res.end(landingHtml(lab, origin));
        }
        return proxy(req, res, url, framable);
      } catch (e) {
        console.error("[whole-page] guard error:", (e as Error).message);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    };

  /** Forward to next dev, the hub or the lab site; `down` shapes the response headers. */
  function proxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    down: (h: http.IncomingHttpHeaders) => http.OutgoingHttpHeaders,
  ) {
    const hub = isHubPath(url.pathname) || isBridgedPath(url.pathname);
    const labPath = Boolean(lab) && isLabPath(url.pathname);
    const remote = hub || labPath;
    const up = (remote ? https : http).request(
      labPath
        ? {
            host: new URL(lab).host,
            port: 443,
            method: req.method,
            path: req.url,
            headers: labHeaders(req.headers),
          }
        : hub
          ? {
              host: new URL(HUB_ORIGIN).host,
              port: 443,
              method: req.method,
              path: req.url,
              headers: hubHeaders(req.headers),
            }
          : {
              host: "127.0.0.1",
              port: inner,
              method: req.method,
              path: req.url,
              headers: forwardHeaders(req.headers),
            },
      (r) => {
        res.writeHead(r.statusCode ?? 502, down(r.headers));
        r.pipe(res);
      },
    );
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(String(e.message));
    });
    req.pipe(up);
  }

  /** Swap a request's headers in place (the gate's upstream view of them). */
  function setHeaders(req: http.IncomingMessage, h: Record<string, string | string[] | undefined>) {
    for (const k of Object.keys(req.headers)) delete req.headers[k];
    for (const [k, v] of Object.entries(h)) if (v !== undefined) req.headers[k] = v;
  }

  function readBody(req: http.IncomingMessage, max = 8192): Promise<string> {
    return new Promise((resolve, reject) => {
      let n = 0;
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        n += c.length;
        if (n > max) {
          reject(new Error("body too large"));
          req.destroy();
        } else parts.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
      req.on("error", reject);
    });
  }

  const tunnelDrop = [GUARD_HEADER, DEV_BRIDGE_HEADER];

  /**
   * The public tunnel's listener (preview.lianki.com via cloudflared): the
   * gate first (scripts/dev/preview-gate.ts) — 503 without a valid dev token —
   * then his owner session, added server-side, as for his tailnet devices.
   */
  async function tunnelHandle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      if (!gate) {
        res.writeHead(503, { "cache-control": "no-store" });
        return res.end();
      }
      const g = await gate.handle({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: () => readBody(req),
      });
      if (g.kind === "respond") {
        res.writeHead(g.status, g.headers);
        return res.end(g.body);
      }
      const url = new URL(req.url ?? "/", origin);
      if (url.pathname === "/api/auth/sign-out") {
        // Signing out on the tunnel ends the tunnel session, not his owner session.
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        });
        return res.end('{"success":true}');
      }
      setHeaders(req, upstreamHeaders(req.headers, { publicHost, origin, drop: tunnelDrop }));
      req.headers.cookie = await withOwnerSession(req.headers.cookie);
      const d = decide(url.pathname, true);
      if (d.kind === "enter") return deny(res, "enter links are for the LAN and tailnet only");
      if (d.kind === "deny") return deny(res, d.reason);
      if (d.kind === "owner" && !(await ownerSession(req.headers.cookie)))
        return deny(res, "the owner session could not be made");
      if (url.pathname === LANDING_PATH) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        return res.end(landingHtml(lab, origin));
      }
      return proxy(
        req,
        res,
        url,
        (h) =>
          downstreamHeaders(framable(h) as Record<string, string | string[] | undefined>, {
            publicHost,
            origin,
          }) as http.OutgoingHttpHeaders,
      );
    } catch (e) {
      console.error("[whole-page] tunnel error:", (e as Error).message);
      if (!res.headersSent) res.writeHead(503, { "cache-control": "no-store" });
      res.end();
    }
  }

  async function tunnelUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const g = gate
      ? await gate.handle({ method: "GET", url: req.url ?? "/", headers: req.headers })
      : undefined;
    if (!g || g.kind !== "forward") {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    const url = new URL(req.url ?? "/", origin);
    setHeaders(req, upstreamHeaders(req.headers, { publicHost, origin, drop: tunnelDrop }));
    req.headers.cookie = await withOwnerSession(req.headers.cookie);
    const d = decide(url.pathname, true);
    const ok =
      d.kind === "pass" || (d.kind === "owner" && (await ownerSession(req.headers.cookie)));
    if (!ok) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    const up = pipeUpgrade(req, socket, head, url);
    // Gated once at the upgrade is not enough: the socket lives on, so it is
    // closed when its token is revoked, its re-check fails or its session ends.
    const unwatch = watch.add(g.tokenId, g.untilMs, () => {
      socket.destroy();
      up.destroy();
    });
    socket.on("close", unwatch);
    up.on("close", unwatch);
  }

  // Websockets: HMR (device cookie) to next dev; the hub's (device + owner) to
  // lianki-push on lianki.com.
  const upgrade =
    (trusted: boolean) => async (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", origin);
      const ts = tailnetIdentity(req.headers[TS_LOGIN_HEADER], trusted, tsLogin);
      if (ts === "forged") {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      if (ts === "owner") req.headers.cookie = await withOwnerSession(req.headers.cookie);
      const deviceOk =
        ts === "owner" ||
        (await verifyDevice(readCookie(req.headers.cookie, DEVICE_COOKIE), state.deviceSecret));
      const d = decide(url.pathname, deviceOk);
      const ok =
        d.kind === "pass" || (d.kind === "owner" && (await ownerSession(req.headers.cookie)));
      if (!ok) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      pipeUpgrade(req, socket, head, url);
    };

  function pipeUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL): Duplex {
    const hub = isHubPath(url.pathname);
    const headers = hub ? hubHeaders(req.headers) : forwardHeaders(req.headers);
    const hubHost = new URL(HUB_ORIGIN).host;
    const connectUp = (onReady: () => void) =>
      hub
        ? tls.connect(443, hubHost, { servername: hubHost }, onReady)
        : net.connect(inner, "127.0.0.1", onReady);
    const up = connectUp(() => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        for (const val of Array.isArray(v) ? v : [v])
          if (val !== undefined) lines.push(`${k}: ${val}`);
      }
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
    return up;
  }

  // The LAN listener (never believes a Tailscale identity) and the loopback one
  // that `tailscale serve --https=8443` targets (believes it, for his login only).
  const lan = http.createServer(handle(false));
  lan.on("upgrade", upgrade(false));
  lan.listen(port, host, () =>
    console.error(`[whole-page] guard on ${origin} → next dev 127.0.0.1:${inner}`),
  );
  const tailnet = http.createServer(handle(true));
  tailnet.on("upgrade", upgrade(true));
  tailnet.listen(tsPort, "127.0.0.1", () =>
    console.error(
      `[whole-page] tailnet listener 127.0.0.1:${tsPort} (owner login: ${tsLogin || "none"})`,
    ),
  );

  if (gate) {
    const tunnelPort = port + 4;
    const tunnel = http.createServer(tunnelHandle);
    tunnel.on("upgrade", tunnelUpgrade);
    tunnel.listen(tunnelPort, "127.0.0.1", () =>
      console.error(
        `[whole-page] tunnel listener 127.0.0.1:${tunnelPort} for https://${publicHost} (dev token required)`,
      ),
    );
  }

  // Publishing: next dev serves THIS worktree, which follows the merge branch
  // (--follow, default preview/live) only when asked, PUBLISH_QUIET_MS after
  // the last ask — a burst of agents' merges reaches his page as one update,
  // not one reload per merge (owner, 2026-10-31: the page kept refreshing).
  const follow = arg("follow", "preview/live");
  const publisher = new Debouncer(async () => {
    const before = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
    const p = Bun.spawnSync(["git", "merge", "--ff-only", "--quiet", follow]);
    const msg = p.success
      ? "published"
      : `publish FAILED: ${p.stderr.toString().trim().split("\n")[0]}`;
    const head = Bun.spawnSync(["git", "log", "--oneline", "-1"]).stdout.toString().trim();
    console.error(`[whole-page] ${msg} (${follow} → ${head})`);
    if (!p.success) return;
    // next dev does not rebuild intlayer's dictionaries for new or changed
    // *.content.ts that arrive by a merge, and the page throws until someone
    // runs `intlayer build` (twice on 2026-10-31). Rebuild them here, at once.
    const changed = Bun.spawnSync(["git", "diff", "--name-only", before, "HEAD"]).stdout.toString();
    if (needsIntlayerBuild(changed.split("\n"))) {
      const b = Bun.spawnSync(["bunx", "intlayer", "build"], { env: { ...process.env, ...env } });
      console.error(`[whole-page] intlayer build ${b.success ? "done" : "FAILED"}`);
    }
  });

  // Loopback only: one-time enter tokens for send-login, and publish requests.
  http
    .createServer((req, res) => {
      if (req.method === "POST" && req.url === "/publish") {
        publisher.request();
        res.writeHead(202);
        return res.end();
      }
      if (req.method !== "POST" || req.url !== "/enter-token") {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ url: `${origin}${ENTER_PATH}?t=${tokens.issue()}` }));
    })
    .listen(control, "127.0.0.1");
}

async function sendLogin() {
  const port = Number(arg("port", "3100"));
  const target = arg("target", "Android");
  const r = await fetch(`http://127.0.0.1:${port + 2}/enter-token`, { method: "POST" });
  if (!r.ok) throw new Error(`control port answered ${r.status} — is "serve" running?`);
  const { url } = (await r.json()) as { url: string };
  // Navigate a moment after returning, so eval's result is a plain string and
  // the link never comes back in its output.
  const code = sendLoginCode(url);
  const child = spawn("bun", ["scripts/dev/eval.ts", "--no-pair", "--target", target, "-"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.end(code);
  child.on("exit", (c) => process.exit(c ?? 1));
}

async function publish() {
  const port = Number(arg("port", "3100"));
  const r = await fetch(`http://127.0.0.1:${port + 2}/publish`, { method: "POST" });
  if (r.status !== 202) throw new Error(`control port answered ${r.status} — is "serve" running?`);
  console.error("queued: the dev server takes preview/live after 3 s of quiet");
}

const cmd = process.argv[2];
if (cmd === "serve") await serve();
else if (cmd === "send-login") await sendLogin();
else if (cmd === "publish") await publish();
else {
  console.error(
    "usage: bun scripts/dev/whole-page.ts serve|send-login|publish [--host H] [--port P] [--target T] [--follow BRANCH]",
  );
  process.exit(2);
}

#!/usr/bin/env bun
/**
 * The whole-page dev server: the app from this working tree, with fast
 * refresh, against PRODUCTION D1 — for the owner's phone on the home LAN.
 * docs/dev-whole-page.md has the why, the security model and the runbook.
 *
 *   bun scripts/dev/whole-page.ts serve [--host 192.168.31.96] [--port 3100]
 *       Starts `next dev` on 127.0.0.1:<port+1> (remote D1/R2 via
 *       wrangler.dev-whole-page.jsonc) and the guard proxy on <host>:<port>,
 *       a private-LAN address only. Loopback control port: <port+2>.
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
import net from "node:net";
import { ownerEmails } from "../../lib/owner";
import {
  DEVICE_COOKIE,
  ENTER_PATH,
  EnterTokens,
  GUARD_HEADER,
  LANDING,
  type SessionInfo,
  decide,
  deviceCookieValue,
  isPrivateLanHost,
  readCookie,
  sessionIsOwner,
  verifyDevice,
} from "./whole-page-guard";

const STATE_FILE = ".dev-whole-page.json";
const SESSION_CACHE_MS = 60_000;
const YEAR_S = 365 * 24 * 60 * 60;

type State = { authSecret: string; deviceSecret: string; guardSecret: string };

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function loadState(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const hex = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const state = { authSecret: hex(), deviceSecret: hex(), guardSecret: hex() };
  writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);
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
  if (!isPrivateLanHost(host)) throw new Error(`--host must be a private LAN IPv4, got ${host}`);
  for (const f of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    // Next would load it and could switch on Resend, Stripe or MongoDB.
    if (existsSync(f))
      throw new Error(`${f} exists; move it aside first (no side effects allowed)`);
  }

  const state = loadState();
  const owners = ownerList();
  if (!ownerEmails(owners).length) throw new Error("OWNER_EMAILS is empty in wrangler.jsonc");
  const origin = `http://${host}:${port}`;

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
  const sessions = new Map<string, { owner: boolean; exp: number }>();

  async function ownerSession(cookie: string | undefined): Promise<boolean> {
    if (!cookie) return false;
    const hit = sessions.get(cookie);
    if (hit && hit.exp > Date.now()) return hit.owner;
    const res = await fetch(`http://127.0.0.1:${inner}/api/auth/get-session`, {
      headers: { cookie, host: `${host}:${port}` },
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
    return out;
  }

  async function enter(url: URL, res: http.ServerResponse) {
    if (!tokens.consume(url.searchParams.get("t"))) {
      console.error("[whole-page] enter: refused (bad, used or expired link)");
      return deny(res, "this link is used or expired");
    }
    const login = await fetch(`http://127.0.0.1:${inner}/api/dev-whole-page/login`, {
      method: "POST",
      headers: { [GUARD_HEADER]: state.guardSecret, host: `${host}:${port}`, origin },
    });
    if (!login.ok) {
      console.error(`[whole-page] enter: login route answered ${login.status}`);
      return deny(res, `sign-in failed (${login.status})`);
    }
    sessions.clear();
    console.error("[whole-page] enter: device paired, owner signed in");
    res.writeHead(302, {
      location: LANDING,
      "cache-control": "no-store",
      "set-cookie": [
        `${DEVICE_COOKIE}=${device}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR_S}`,
        ...login.headers.getSetCookie(),
      ],
    });
    res.end();
  }

  const proxy = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", origin);
      const deviceOk = await verifyDevice(
        readCookie(req.headers.cookie, DEVICE_COOKIE),
        state.deviceSecret,
      );
      const d = decide(url.pathname, deviceOk);
      if (d.kind === "enter") return await enter(url, res);
      if (d.kind === "deny") return deny(res, d.reason);
      if (d.kind === "owner" && !(await ownerSession(req.headers.cookie))) {
        return deny(res, "not the owner's session — open a fresh enter link");
      }
      const up = http.request(
        {
          host: "127.0.0.1",
          port: inner,
          method: req.method,
          path: req.url,
          headers: forwardHeaders(req.headers),
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      up.on("error", (e) => {
        if (!res.headersSent) res.writeHead(502);
        res.end(String(e.message));
      });
      req.pipe(up);
    } catch (e) {
      console.error("[whole-page] guard error:", (e as Error).message);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  // HMR's websocket: device cookie required, then piped through.
  proxy.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", origin);
    const deviceOk = await verifyDevice(
      readCookie(req.headers.cookie, DEVICE_COOKIE),
      state.deviceSecret,
    );
    if (decide(url.pathname, deviceOk).kind !== "pass") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const up = net.connect(inner, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(forwardHeaders(req.headers))) {
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
  });

  proxy.listen(port, host, () =>
    console.error(`[whole-page] guard on ${origin} → next dev 127.0.0.1:${inner}`),
  );

  // Loopback only: hands out one-time enter tokens to send-login.
  http
    .createServer((req, res) => {
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
  const code = `setTimeout(() => location.assign(${JSON.stringify(url)}), 300); "navigating"`;
  const child = spawn("bun", ["scripts/dev/eval.ts", "--no-pair", "--target", target, "-"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.end(code);
  child.on("exit", (c) => process.exit(c ?? 1));
}

const cmd = process.argv[2];
if (cmd === "serve") await serve();
else if (cmd === "send-login") await sendLogin();
else {
  console.error(
    "usage: bun scripts/dev/whole-page.ts serve|send-login [--host H] [--port P] [--target T]",
  );
  process.exit(2);
}

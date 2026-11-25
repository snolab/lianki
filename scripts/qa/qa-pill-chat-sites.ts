#!/usr/bin/env bun
/**
 * Per-site Li threads (docs/userscript-li-chat.md, "Per-site threads"; flag
 * ext.pill-chat-per-origin) end to end on local servers only:
 *
 * - the main Worker (the OpenNext build, local D1) under its own name, and
 *   lianki-push (a copy of workers/push/wrangler.jsonc) bound to it both ways,
 *   in ONE `wrangler dev --local` session behind a small router Worker that
 *   splits paths as lianki.com's routes do (/api/version/* to lianki-push).
 *   Two separate `wrangler dev` sessions do not work here: through wrangler's
 *   dev registry the session started first keeps answering 503 "Worker … not
 *   found" on its binding to the later one, even once it says [connected]
 *   (wrangler 4.151; restarting it breaks the other direction instead). That
 *   was the local-only 503 on /api/chat/sites (docs/userscript-li-chat.md);
 * - a throwaway Ed25519 key made for this run: the main Worker's STT_TICKET_KEY,
 *   lianki-push's PARTNER_TICKET_PUB (never a real secret);
 * - a small front on http://localhost:<A> standing in for lianki.com's routes:
 *   /api/version/* to lianki-push (its WebSocket's Origin written as
 *   https://lianki.com when it came from the local app origin, as the browser
 *   writes it in production), everything else to the main Worker;
 * - two host sites, https://site-a.test:<p> and https://site-b.test:<p> (a
 *   self-signed certificate made for the run; Chromium's host resolver maps both
 *   to 127.0.0.1), each with the REAL src/pill-chat.ts
 *   gate and frame shell in an isolated world (pill-chat-fixture.ts), and the
 *   real /embed/partner frame from the local Worker.
 *
 * GM_xmlhttpRequest is played by Playwright: the shell's ticket and flag
 * requests from the host page are fetched with the context's lianki cookie and
 * no CORS, as a userscript manager does.
 *
 * Checks, for a normal account (account ticket) and for a dev account (the
 * owner's partner ticket): the Li entry is on both sites; Allow once mints a
 * ticket bound to that site (ho, th); each site's line lands in its own thread
 * and never in the other's or the account's own; A's ticket in a frame on B,
 * or with ?ho=B, is refused before its jti is spent; /api/chat/sites and
 * /chat/sites list both; with the flag off /api/chat/sites is 404.
 *
 *   bun scripts/qa/qa-pill-chat-sites.ts [outDir]
 *
 * Silent: muted headless Chromium, fake mic, nothing plays.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium, type BrowserContext, type Frame, type Page } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { b64url, fromB64url } from "../../lib/stt-ticket";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = process.argv[2] || `${ROOT}/test-results/pill-chat-sites`;
mkdirSync(OUT, { recursive: true });
const QA = `${ROOT}/.wrangler/qa-sites`;
const STATE = `${QA}/state`;
// A fresh local D1 and hub storage every run: nothing from an earlier run is counted.
rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });

const fail: string[] = [];
const check = (ok: unknown, what: string, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? ` (${detail})` : ""}`);
  if (!ok) fail.push(what);
};
const log = (s: string) => console.log(`[qa-sites] ${s}`);
const wait = async <T>(f: () => Promise<T> | T, ms = 15_000): Promise<T | null> => {
  for (let t = 0; t < ms; t += 250) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
const freePort = () => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port;
  s.stop(true);
  if (!p) throw new Error("no free port");
  return p;
};

// ── A throwaway ticket key for this run ─────────────────────────────────────
const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));

/** The one dev session (the router): main Worker paths and lianki-push paths alike. */
const M = freePort();
const H = M;
const A = freePort();
const SITE_PORT = freePort();
const APP = `http://localhost:${A}`;
// https, as nearly every site is: a frame is a secure context only when every
// ancestor is one (crypto.randomUUID, which the frame's send uses, needs it).
const SITE_A = `https://site-a.test:${SITE_PORT}`;
const SITE_B = `https://site-b.test:${SITE_PORT}`;
/** A plain-http site, probed only for what the frame can do there (information). */
const HTTP_PORT = freePort();
const SITE_HTTP = `http://site-c.test:${HTTP_PORT}`;
const MAIN_NAME = "lianki-qasites";
const PUSH_NAME = "lianki-push-qasites";

// ── Configs: the real ones, renamed and bound to each other ─────────────────
mkdirSync(`${QA}/main`, { recursive: true });
mkdirSync(`${QA}/push`, { recursive: true });
writeFileSync(
  `${QA}/main/wrangler.jsonc`,
  JSON.stringify({
    name: MAIN_NAME,
    main: `${ROOT}/worker.ts`,
    compatibility_date: "2025-05-05",
    compatibility_flags: ["nodejs_compat", "enable_request_signal"],
    assets: { directory: `${ROOT}/.open-next/assets`, binding: "ASSETS" },
    vars: { DB_BACKEND: "d1", BETTER_AUTH_BASE_URL: APP },
    services: [{ binding: "PUSH", service: PUSH_NAME }],
    d1_databases: [
      {
        binding: "DB",
        database_name: "lianki",
        database_id: "a2c6b8cf-8a94-4cdc-99fd-bbbf6b679f4c",
        migrations_dir: `${ROOT}/db/migrations`,
      },
    ],
    r2_buckets: [{ binding: "BLOBS", bucket_name: "lianki-blobs" }],
  }),
);
writeFileSync(
  `${QA}/main/.dev.vars`,
  [
    "NODE_ENV=development",
    "DB_BACKEND=d1",
    "DEV_EMAIL_PASSWORD_AUTH=1",
    "AUTH_SECRET=dev-qa-secret-not-for-production",
    `BETTER_AUTH_BASE_URL=${APP}`,
    `STT_TICKET_KEY=${JSON.stringify(jwk)}`,
    "",
  ].join("\n"),
);
const pushCfg = await Bun.file(`${ROOT}/workers/push/wrangler.jsonc`).text();
const pushJson = JSON.parse(
  pushCfg
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1")
    .replace(/"\$schema"[^\n]*\n/, ""),
);
writeFileSync(
  `${QA}/push/wrangler.jsonc`,
  JSON.stringify({
    ...pushJson,
    name: PUSH_NAME,
    // index.ts also exports a plain constant (KEEP_FINGERPRINTS), which local workerd
    // refuses as an entrypoint: this entry re-exports only the Worker and its objects.
    main: `${QA}/push/entry.ts`,
    routes: [],
    services: [
      { binding: "MAIN", service: MAIN_NAME },
      { binding: "SESSIONS", service: MAIN_NAME, entrypoint: "DebugSessions" },
    ],
  }),
);
writeFileSync(
  `${QA}/push/entry.ts`,
  `export { default, VersionHub, DebugHub, ProgressHub, ReadStreamHub, SttRegistry } from "${ROOT}/workers/push/src/index.ts";\n`,
);
writeFileSync(`${QA}/push/.dev.vars`, `PARTNER_TICKET_PUB=${pub}\n`);
// The router (the primary Worker on the port): lianki.com's split by path.
// /internal/* goes to lianki-push too, so the QA can ask the hub's own list on
// the binding's hostname (Host: lianki-push), as the main Worker does.
mkdirSync(`${QA}/router`, { recursive: true });
writeFileSync(
  `${QA}/router/index.js`,
  `export default {
  fetch(req, env) {
    const p = new URL(req.url).pathname;
    const push = p.startsWith("/api/version/") || p.startsWith("/internal/");
    return (push ? env.PUSH : env.MAIN).fetch(req);
  },
};
`,
);
const ROUTER_CFG = `${QA}/router/wrangler.jsonc`;
writeFileSync(
  ROUTER_CFG,
  JSON.stringify({
    name: "lianki-qasites-router",
    main: `${QA}/router/index.js`,
    compatibility_date: "2025-05-05",
    services: [
      { binding: "MAIN", service: MAIN_NAME },
      { binding: "PUSH", service: PUSH_NAME },
    ],
  }),
);

const MAIN_CFG = `${QA}/main/wrangler.jsonc`;
const sql = (command: string) => {
  const r = spawnSync(
    "bunx",
    [
      "wrangler",
      "d1",
      "execute",
      "lianki",
      "--local",
      "-c",
      MAIN_CFG,
      "--persist-to",
      STATE,
      "--json",
      "--command",
      command,
    ],
    { encoding: "utf8", cwd: ROOT },
  );
  if (r.status !== 0) throw new Error(`local d1: ${r.stderr || r.stdout}`);
  try {
    return (JSON.parse(r.stdout)[0]?.results ?? []) as Record<string, unknown>[];
  } catch {
    return [];
  }
};

log("D1 migrate (local, own state dir)");
{
  const migrate = () =>
    spawnSync(
      "bunx",
      [
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "lianki",
        "--local",
        "-c",
        MAIN_CFG,
        "--persist-to",
        STATE,
      ],
      { encoding: "utf8", cwd: ROOT, env: { ...process.env, CI: "1" } },
    );
  // A fresh state dir has once stopped part way (exit 1, nothing on stderr); the rest applies on a second go.
  const r = migrate().status === 0 ? { status: 0, stderr: "", stdout: "" } : migrate();
  if (r.status !== 0) throw new Error(`migrate: ${r.stderr || r.stdout}`);
}

const procs: ChildProcess[] = [];
const serverLog: string[] = [];
const startWrangler = (cfgs: string[], port: number, tag: string) => {
  const p = spawn(
    "bunx",
    [
      "wrangler",
      "dev",
      ...cfgs.flatMap((c) => ["-c", c]),
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--local",
      "--persist-to",
      STATE,
      "--inspector-port",
      String(freePort()),
      "--show-interactive-dev-session=false",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DB_BACKEND: "d1" } },
  );
  const keep = (b: Buffer) => {
    for (const l of b.toString().split("\n")) if (l.trim()) serverLog.push(`[${tag}] ${l}`);
  };
  p.stdout?.on("data", keep);
  p.stderr?.on("data", keep);
  procs.push(p);
  return p;
};
const stopAll = () => {
  for (const p of procs)
    try {
      p.kill("SIGTERM");
    } catch {}
};
process.on("exit", stopAll);
process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

const ready = async (url: string, ms = 180_000) =>
  wait(async () => {
    try {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      return r.status > 0;
    } catch {
      return false;
    }
  }, ms);

log(`main Worker ${MAIN_NAME} + lianki-push ${PUSH_NAME}, one session on :${M}`);
startWrangler([ROUTER_CFG, MAIN_CFG, `${QA}/push/wrangler.jsonc`], M, "dev");
if (!(await ready(`http://127.0.0.1:${M}/`))) {
  console.log(serverLog.slice(-40).join("\n"));
  throw new Error("main Worker not ready");
}
if (!(await ready(`http://127.0.0.1:${H}/api/version/x`))) {
  console.log(serverLog.slice(-40).join("\n"));
  throw new Error("lianki-push not ready");
}

// ── The front: lianki.com's routes on localhost:A ───────────────────────────
type Up = { ws: WebSocket; buf: (string | ArrayBuffer)[] };
const hubRefusals: string[] = [];
const front = Bun.serve<Up>({
  port: A,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  async fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/api/version/") && req.headers.get("upgrade") === "websocket") {
      const origin = req.headers.get("origin");
      // As in production: the frame on lianki.com sends Origin https://lianki.com.
      const asOrigin = origin === APP ? "https://lianki.com" : (origin ?? "");
      const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const headers: Record<string, string> = { origin: asOrigin };
      const cookie = req.headers.get("cookie");
      if (cookie) headers.cookie = cookie;
      const up = new WebSocket(`ws://127.0.0.1:${H}${u.pathname}${u.search}`, {
        protocols,
        headers,
      } as unknown as string[]);
      up.binaryType = "arraybuffer";
      const buf: (string | ArrayBuffer)[] = [];
      up.onmessage = (e) => buf.push(e.data as string);
      const opened = await new Promise<boolean>((ok) => {
        up.onopen = () => ok(true);
        up.onerror = () => ok(false);
        up.onclose = () => ok(false);
      });
      if (!opened) {
        hubRefusals.push(`${u.search}`);
        return new Response("forbidden", { status: 403 });
      }
      const sub = protocols[0];
      if (
        srv.upgrade(req, {
          data: { ws: up, buf },
          headers: sub ? { "sec-websocket-protocol": sub } : {},
        })
      )
        return undefined;
      up.close();
      return new Response("upgrade failed", { status: 500 });
    }
    const headers = new Headers(req.headers);
    headers.set("host", `localhost:${A}`);
    const res = await fetch(`http://127.0.0.1:${M}${u.pathname}${u.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    });
    const out = new Headers(res.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(await res.arrayBuffer(), { status: res.status, headers: out });
  },
  websocket: {
    open(ws) {
      const { ws: up, buf } = ws.data;
      for (const m of buf) ws.send(m);
      buf.length = 0;
      up.onmessage = (e) => ws.send(e.data as string);
      up.onclose = (e) => ws.close(e.code >= 1000 && e.code < 5000 ? e.code : 1000, e.reason);
    },
    message(ws, m) {
      ws.data.ws.send(m);
    },
    close(ws) {
      ws.data.ws.close();
    },
  },
});

// ── Host sites ──────────────────────────────────────────────────────────────
const QA_DIR = new URL(".", import.meta.url).pathname;
const fixtureJs = await Bun.build({
  entrypoints: [`${QA_DIR}pill-chat-fixture.ts`],
  target: "browser",
  format: "iife",
}).then((o) => {
  if (!o.success) throw new Error(o.logs.join("\n"));
  return o.outputs[0].text();
});
const CERT = `${QA}/site.crt`;
const KEY = `${QA}/site.key`;
{
  const r = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      KEY,
      "-out",
      CERT,
      "-subj",
      "/CN=site-a.test",
      "-addext",
      "subjectAltName=DNS:site-a.test,DNS:site-b.test",
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`openssl: ${r.stderr}`);
}
const sitePage = (req: Request) => {
  const host = (req.headers.get("host") ?? "").split(":")[0];
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${host}</title></head><body style="font:16px system-ui;padding:16px"><h1>${host}</h1><p>An ordinary site.</p></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
};
const site = Bun.serve({
  port: SITE_PORT,
  hostname: "127.0.0.1",
  tls: { cert: Bun.file(CERT), key: Bun.file(KEY) },
  fetch: sitePage,
});
const httpSite = Bun.serve({ port: HTTP_PORT, hostname: "127.0.0.1", fetch: sitePage });

// ── Accounts and flags (local D1 only) ──────────────────────────────────────
const RUN = Math.random().toString(36).slice(2, 8);
const USER = `qa+sites-${RUN}@lianki.test`;
const DEV = `qa+sites-dev-${RUN}@lianki.test`;
const PW = "qa-test-pass-1234";
const setFlags = (perOrigin: boolean) => {
  sql(
    "DELETE FROM feature_flags WHERE key IN ('ext.pill-chat','ext.pill-chat-users','ext.pill-chat-per-origin')",
  );
  sql(
    `INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('ext.pill-chat', 1, datetime('now'), 'qa'), ('ext.pill-chat-users', 1, datetime('now'), 'qa'), ('ext.pill-chat-per-origin', ${perOrigin ? 1 : 0}, datetime('now'), 'qa')`,
  );
};
setFlags(true);

const browser = await launchSilent(chromium, {
  args: [
    `--host-resolver-rules=MAP site-a.test 127.0.0.1, MAP site-b.test 127.0.0.1, MAP site-c.test 127.0.0.1`,
  ],
});

const decode = (ticket: string) => {
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(ticket.split(".")[0])));
  } catch {
    return null;
  }
};

type Account = {
  name: string;
  email: string;
  id: string;
  ctx: BrowserContext;
  cookie: string;
  /** Tickets the shell got, by host origin. */
  tickets: Map<string, string[]>;
  /** Next ticket answer for this host origin is replaced by this one (the swap check). */
  swap: Map<string, string>;
};

async function account(name: string, email: string, dev: boolean): Promise<Account> {
  // The sites' certificate is self-signed for this run.
  const ctx = await newSilentContext(browser, {
    viewport: { width: 390, height: 844 },
    ignoreHTTPSErrors: true,
  });
  const su = await ctx.request.post(`${APP}/api/auth/sign-up/email`, {
    headers: { origin: APP, "content-type": "application/json" },
    data: { email, password: PW, name: `QA ${name}` },
  });
  check(su.ok(), `${name}: the QA account signs up`, `${su.status()}`);
  if (dev) {
    const at = Date.now();
    sql(
      `INSERT OR REPLACE INTO account_permission (email, permission, granted_by, granted_at) VALUES ('${email}', 'dev', 'qa', ${at})`,
    );
  }
  const cookie = (await ctx.cookies(APP)).map((c) => `${c.name}=${c.value}`).join("; ");
  const me = await ctx.request.get(`${APP}/api/auth/get-session`);
  const id = String(
    ((await me.json().catch(() => null)) as { user?: { id?: string } } | null)?.user?.id ?? "",
  );
  const acc: Account = { name, email, id, ctx, cookie, tickets: new Map(), swap: new Map() };
  // GM_xmlhttpRequest: the shell's requests from a host page go with the lianki cookie, no CORS.
  await ctx.route(`${APP}/api/**`, async (route) => {
    const req = route.request();
    const from = req.headers()["origin"];
    const path = new URL(req.url()).pathname;
    const gm = ["/api/ext/pill-chat", "/api/chat/li-ticket", "/api/debug/partner-ticket"];
    if (!from || from === APP || !gm.includes(path)) return route.continue();
    const cors = {
      "access-control-allow-origin": from,
      "access-control-allow-headers": "x-lianki-userscript, x-lianki-host-origin",
      "access-control-allow-methods": "GET, POST",
    };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const h: Record<string, string> = { ...req.headers(), cookie: acc.cookie };
    delete h.origin;
    delete h.referer;
    const res = await route.fetch({ headers: h });
    let body = await res.text();
    if (path !== "/api/ext/pill-chat" && res.ok()) {
      const ho = req.headers()["x-lianki-host-origin"] ?? "";
      const t = JSON.parse(body).ticket as string;
      acc.tickets.set(ho, [...(acc.tickets.get(ho) ?? []), t]);
      const swap = acc.swap.get(ho);
      if (swap) {
        acc.swap.delete(ho);
        body = JSON.stringify({ ticket: swap, exp: 0 });
      }
    }
    return route.fulfill({
      status: res.status(),
      body,
      headers: { ...cors, "content-type": "application/json" },
    });
  });
  return acc;
}

/** The host page with the real gate in an isolated world, as the userscript runs. */
async function hostPage(acc: Account, origin: string) {
  const p = await acc.ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      console.log(`  (console ${m.type()}) ${m.text().slice(0, 200)}`);
  });
  const socks: { url: string; got: string[]; closed: boolean }[] = [];
  p.on("websocket", (ws) => {
    if (!ws.url().includes("/api/version/debug")) return;
    const s = { url: ws.url(), got: [] as string[], closed: false };
    socks.push(s);
    ws.on("framereceived", (f) => s.got.push(String(f.payload)));
    ws.on("framesent", (f) => s.got.push(`OUT ${String(f.payload)}`));
    ws.on("close", () => (s.closed = true));
    ws.on("socketerror", () => (s.closed = true));
  });
  const cdp = await acc.ctx.newCDPSession(p);
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `globalThis.__QA_APP__=${JSON.stringify(APP)};\n${fixtureJs}`,
    worldName: "lianki-userscript",
  });
  await p.goto(`${origin}/`);
  await p.waitForTimeout(300);
  return { p, errors, socks };
}

const overlays = (p: Page) => p.evaluate(() => document.querySelectorAll("html > div").length);
const tapLi = (p: Page) => p.mouse.click(390 - 16 - 30, 844 - 16 - 22);
const frameOf = (p: Page) => p.frames().find((f) => f.url().startsWith(`${APP}/embed/partner`));

async function allowOnce(p: Page): Promise<Frame | null> {
  await tapLi(p);
  await p.waitForTimeout(250);
  // Focus starts on ×; Tab → Always, Tab → Allow once.
  await p.keyboard.press("Tab");
  await p.keyboard.press("Tab");
  await p.keyboard.press("Enter");
  return (await wait(() => frameOf(p) ?? null, 20_000)) ?? null;
}

const statusOpen = (socks: { got: string[] }[]) =>
  socks.some((s) => s.got.some((g) => g.includes('"friend-status"') && g.includes('"open"')));
const frameText = (f: Frame) =>
  f.evaluate(() => document.querySelector("[data-debug-chat]")?.textContent ?? "").catch(() => "");

async function say(f: Frame, p: Page, text: string) {
  const input = f.locator('[data-testid="debug-chat-input"]');
  await input.waitFor({ timeout: 20_000 });
  await input.click();
  await p.keyboard.type(text);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(1500);
  const left = await f
    .evaluate(() => ({
      value: (document.querySelector('[data-testid="debug-chat-input"]') as HTMLTextAreaElement)
        ?.value,
      active:
        document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName,
      secure: isSecureContext,
      uuid: typeof crypto.randomUUID,
    }))
    .catch((e) => ({ value: `eval failed ${e}`, active: "" }));
  console.log(`  (info) after Enter: input ${JSON.stringify(left)}`);
}

const shot = async (p: Page, name: string) => {
  for (const scheme of ["light", "dark"] as const) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
  }
  await p.emulateMedia({ colorScheme: "light" });
};

/** A raw socket to lianki-push, as a browser would open it. */
const probe = (o: { ticket?: string; origin: string; query: string; cookie?: string }) =>
  new Promise<{ open: boolean; got: string[] }>((done) => {
    const got: string[] = [];
    const headers: Record<string, string> = { origin: o.origin };
    if (o.cookie) headers.cookie = o.cookie;
    const ws = new WebSocket(`ws://127.0.0.1:${H}/api/version/debug?${o.query}`, {
      protocols: o.ticket ? ["lianki-partner", o.ticket] : [],
      headers,
    } as unknown as string[]);
    let open = false;
    ws.onmessage = (e) => got.push(String(e.data));
    ws.onopen = () => {
      open = true;
      setTimeout(() => {
        ws.close();
        done({ open, got });
      }, 2500);
    };
    ws.onerror = () => done({ open, got });
    ws.onclose = () => done({ open, got });
  });

/** A fresh ticket for this host origin, asked as the userscript asks (outside any page). */
async function mint(acc: Account, ho: string, path: string) {
  const r = await fetch(`${APP}${path}`, {
    method: "POST",
    headers: { cookie: acc.cookie, "x-lianki-userscript": "1", "x-lianki-host-origin": ho },
  });
  return r.ok ? ((await r.json()) as { ticket: string }).ticket : null;
}

async function scenario(acc: Account, ticketPath: string, base: (id: string) => string) {
  const N = acc.name;
  const lines: Record<string, string> = {
    [SITE_A]: `qa ${N} on A ${RUN}`,
    [SITE_B]: `qa ${N} on B ${RUN}`,
  };
  const pages: Record<string, { p: Page; f: Frame | null; socks: { got: string[] }[] }> = {};
  for (const [origin, tag] of [
    [SITE_A, "a"],
    [SITE_B, "b"],
  ] as const) {
    const { p, errors, socks } = await hostPage(acc, origin);
    check((await overlays(p)) === 1, `${N} ${tag}: the pill's Li entry is on ${origin}`);
    if (tag === "a") await p.screenshot({ path: `${OUT}/${N}-site-a-li-button.png` });
    await tapLi(p);
    await p.waitForTimeout(300);
    const prompt = (await overlays(p)) === 2;
    check(prompt, `${N} ${tag}: a real tap shows the per-site prompt`);
    if (tag === "a") await shot(p, `${N}-site-a-prompt`);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    const f = await allowOnce(p);
    check(!!f, `${N} ${tag}: Allow once opens the lianki frame`);
    // The frame asks the shell for its ticket after it loads.
    const t = await wait(() => (acc.tickets.get(origin) ?? []).at(-1) ?? null, 20_000);
    const pl = t ? decode(t) : null;
    check(
      pl?.ho === origin && typeof pl?.th === "string" && pl.th.length === 22,
      `${N} ${tag}: the ticket is bound to ${origin}`,
      pl ? `ho=${pl.ho} th=${String(pl.th).slice(0, 6)}… aud=${pl.aud}` : "no ticket",
    );
    const opened = await wait(() => statusOpen(socks), 20_000);
    check(
      opened,
      `${N} ${tag}: the hub opens the frame's socket (friend-status open)`,
      socks.map((s) => s.url.replace(/ho=[^&]+/, "ho=…")).join(" ") || "no socket",
    );
    if (f) {
      await say(f, p, lines[origin]);
      const shown = await wait(async () => (await frameText(f)).includes(lines[origin]), 15_000);
      check(shown, `${N} ${tag}: the line shows in this site's panel`);
      // The hub's echo of the line (a "chat" frame carrying it back), not just the composer's own copy.
      const echoed = await wait(
        () =>
          socks.some((s) => s.got.some((g) => !g.startsWith("OUT ") && g.includes(lines[origin]))),
        15_000,
      );
      check(echoed, `${N} ${tag}: the hub stores and echoes the line on this site's socket`);
      if (!echoed)
        console.log(
          `  (info) traffic: ${socks
            .flatMap((s) => s.got)
            .map((g) => g.slice(0, 160))
            .join(" | ")}`,
        );
    }
    check(errors.length === 0, `${N} ${tag}: no page errors`, errors.join("; "));
    pages[origin] = { p, f, socks };
  }
  await new Promise((r) => setTimeout(r, 2000));
  for (const [me, other] of [
    [SITE_A, SITE_B],
    [SITE_B, SITE_A],
  ]) {
    const f = pages[me].f;
    const text = f ? await frameText(f) : "";
    check(
      text.includes(lines[me]) && !text.includes(lines[other]),
      `${N}: ${me}'s panel holds its own line only`,
    );
  }
  // A fresh visit to A: the hub replays A's thread (its line, never B's).
  {
    const { p, socks } = await hostPage(acc, SITE_A);
    const f = await allowOnce(p);
    await wait(() => statusOpen(socks), 20_000);
    const hist = await wait(
      () => socks.flatMap((s) => s.got).find((g) => g.includes('"type":"history"')) ?? null,
      15_000,
    );
    check(
      !!hist && hist.includes(lines[SITE_A]) && !hist.includes(lines[SITE_B]),
      `${N}: a new visit to A replays A's thread (its line, not B's)`,
      hist ? `history frame ${hist.length} bytes` : "no history frame",
    );
    console.log(`  (info) history frame: ${hist?.slice(0, 400)}`);
    const shown = f ? (await frameText(f)).includes(lines[SITE_A]) : false;
    console.log(`  (info) the replayed line is in the panel's DOM: ${shown}`);
    await shot(p, `${N}-site-a-panel`);
    await p.close();
  }
  await shot(pages[SITE_B].p, `${N}-site-b-panel`);

  // The account's own thread (a lianki.com cookie socket): neither line.
  const own = await probe({
    origin: "https://lianki.com",
    query: "label=qa-own",
    cookie: acc.cookie,
  });
  const ownText = own.got.join("\n");
  check(
    own.open &&
      ownText.includes('"type":"history"') &&
      !ownText.includes(lines[SITE_A]) &&
      !ownText.includes(lines[SITE_B]),
    `${N}: the account's own thread holds neither site's line`,
    `open=${own.open} frames=${own.got.length}`,
  );

  // A's ticket in a frame on B: refused, B's panel does not open.
  {
    const ta = await mint(acc, SITE_A, ticketPath);
    acc.swap.set(SITE_B, ta ?? "");
    const before = hubRefusals.length;
    const { p, socks } = await hostPage(acc, SITE_B);
    await allowOnce(p);
    await new Promise((r) => setTimeout(r, 4000));
    check(
      !statusOpen(socks) && hubRefusals.length > before,
      `${N}: A's ticket in a frame on B is refused by the hub`,
      `refusals ${hubRefusals.length - before}, sockets ${socks.length}`,
    );
    await p.screenshot({ path: `${OUT}/${N}-swap-refused.png` });
    await p.close();
    // Not spent by the refusal: the same ticket still opens on A, once.
    const good = await probe({
      ticket: ta ?? "",
      origin: "https://lianki.com",
      query: `label=qa&ho=${encodeURIComponent(SITE_A)}`,
    });
    check(good.open, `${N}: that ticket was not spent by the refusal (opens on A)`);
  }
  {
    const ta = await mint(acc, SITE_A, ticketPath);
    const wrongHo = await probe({
      ticket: ta ?? "",
      origin: "https://lianki.com",
      query: `label=qa&ho=${encodeURIComponent(SITE_B)}`,
    });
    check(!wrongHo.open, `${N}: A's ticket with ?ho=B is refused`);
    const fromSite = await probe({
      ticket: ta ?? "",
      origin: SITE_A,
      query: `label=qa&ho=${encodeURIComponent(SITE_A)}`,
    });
    check(
      !fromSite.open,
      `${N}: A's ticket from the site's own origin (not lianki.com) is refused`,
    );
    const noHo = await probe({ ticket: ta ?? "", origin: "https://lianki.com", query: "label=qa" });
    check(!noHo.open, `${N}: A's ticket with no ?ho= is refused`);
  }

  // His list on lianki.com: the main Worker's route over the PUSH binding.
  const api = await acc.ctx.request.get(`${APP}/api/chat/sites`);
  const body = api.ok() ? ((await api.json()) as { threads: { origin: string }[] }) : null;
  const origins = (body?.threads ?? []).map((t) => t.origin);
  const listedByApi = origins.includes(SITE_A) && origins.includes(SITE_B) && origins.length === 2;
  check(
    listedByApi,
    `${N}: /api/chat/sites lists both sites`,
    `${api.status()} ${origins.join(", ")}`,
  );
  // The hub's own answer to that binding call (/internal/sub-threads, answered on the
  // binding's hostname alone), asked on its port with that Host: the same handler.
  const hubBase = base(acc.id);
  const hubRes = await fetch(
    `http://127.0.0.1:${H}/internal/sub-threads?base=${encodeURIComponent(hubBase)}`,
    { headers: { host: "lianki-push" } },
  );
  const hubBody = hubRes.ok ? await hubRes.text() : "";
  const hubOrigins = hubRes.ok
    ? ((JSON.parse(hubBody) as { threads: { origin: string }[] }).threads ?? []).map(
        (t) => t.origin,
      )
    : [];
  check(
    hubOrigins.includes(SITE_A) && hubOrigins.includes(SITE_B) && hubOrigins.length === 2,
    `${N}: the hub's sub-thread list (base ${hubBase === "owner" ? "owner" : "the user id"}) holds both sites`,
    `${hubRes.status} ${hubOrigins.join(", ")}`,
  );
  console.log(`  (info) hub list: ${hubBody.slice(0, 600)}`);
  const sp = await acc.ctx.newPage();
  await sp.goto(`${APP}/chat/sites`).catch(() => {});
  const listed = await wait(async () => {
    const t = (await sp.textContent("body").catch(() => "")) ?? "";
    return t.includes("site-a.test") && t.includes("site-b.test");
  }, 30_000);
  check(listed, `${N}: the /chat/sites page lists both sites`);
  await shot(sp, `${N}-chat-sites`);
  await sp.close();
  for (const { p } of Object.values(pages)) await p.close();
}

let accounts: Account[] = [];
try {
  const user = await account("user", USER, false);
  const dev = await account("owner", DEV, true);
  accounts = [user, dev];
  log("normal account (account ticket, /api/chat/li-ticket)");
  await scenario(user, "/api/chat/li-ticket", (id) => id);
  // A plain-http site: the frame is not a secure context (no crypto.randomUUID),
  // and a typed line still goes out (partner-client.ts mints ids with uuid.ts).
  {
    const { p, socks } = await hostPage(user, SITE_HTTP);
    const f = await allowOnce(p);
    await wait(() => statusOpen(socks), 20_000);
    const env = f
      ? await f.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID }))
      : null;
    console.log(
      `  (info) frame on ${SITE_HTTP}: ${JSON.stringify(env)}, socket open ${statusOpen(socks)}`,
    );
    if (f) {
      await say(f, p, `qa http ${RUN}`);
      const sent = socks.some((s) =>
        s.got.some((g) => g.startsWith("OUT ") && g.includes(`qa http ${RUN}`)),
      );
      check(sent, `user: a line typed on ${SITE_HTTP} (not a secure context) goes out`);
      const echoed = await wait(
        () =>
          socks.some((s) =>
            s.got.some((g) => !g.startsWith("OUT ") && g.includes(`qa http ${RUN}`)),
          ),
        15_000,
      );
      check(echoed, `user: the hub echoes the http site's line`);
    } else check(false, `user: the frame opens on ${SITE_HTTP}`);
    await p.screenshot({ path: `${OUT}/user-http-site-panel.png` });
    await p.close();
  }
  if (!process.env.QA_SITES_QUICK) {
    log("dev account (the owner's partner ticket, /api/debug/partner-ticket)");
    await scenario(dev, "/api/debug/partner-ticket", () => "owner");
  }

  // The history (D1 chat_line) names the thread, never the origin.
  const rows = sql(`SELECT thread, text FROM chat_line WHERE text LIKE '%${RUN}%'`);
  const bad = rows.filter((r) => !String(r.thread).includes("~"));
  check(
    rows.length > 0 && bad.length === 0 && rows.every((r) => !String(r.thread).includes("site-")),
    "the account history keeps each site line under a site thread id, never the origin",
    `${rows.length} rows: ${rows.map((r) => r.thread).join(", ")}`,
  );

  // Flag off: the list is gone.
  setFlags(false);
  log("flag off; waiting out the 30 s flag cache");
  await new Promise((r) => setTimeout(r, 32_000));
  const off = await user.ctx.request.get(`${APP}/api/chat/sites`);
  check(off.status() === 404, "flag off: /api/chat/sites is 404", `${off.status()}`);
} finally {
  try {
    sql(
      "DELETE FROM feature_flags WHERE key IN ('ext.pill-chat','ext.pill-chat-users','ext.pill-chat-per-origin')",
    );
    sql(`DELETE FROM account_permission WHERE email = '${DEV}'`);
  } catch {}
  for (const a of accounts) await a.ctx.close().catch(() => {});
  await browser.close();
  front.stop(true);
  site.stop(true);
  httpSite.stop(true);
  writeFileSync(`${OUT}/servers.log`, serverLog.join("\n"));
  stopAll();
}
if (fail.length) {
  console.error(`\n${fail.length} check(s) failed:\n- ${fail.join("\n- ")}`);
  process.exit(1);
}
console.log("\nper-site Li threads: all checks passed");
process.exit(0);

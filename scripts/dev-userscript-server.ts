#!/usr/bin/env bun
/**
 * Lianki dev userscript server — install the loader once, then every save is
 * pushed to every attached browser over a long poll.
 *
 *   bun run dev:loader                      # quick tunnel, bundle talks to lianki.com
 *   bun run dev:loader --app http://localhost:3000
 *   bun run dev:loader --origin https://dev.lianki.com   # you run a named tunnel
 *   bun run dev:loader --no-tunnel          # localhost only
 *
 * Serves (contract documented in docs/dev-userscript-loader.md):
 *   GET  /loader.user.js       the loader, with origins/version filled in
 *   GET  /wait?id&rev          long poll — parks until the build changes
 *   GET  /bundle.js?id&rev     the current build
 *   POST /error?id             error sink from attached clients
 *   GET  /                     status page
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderLoader } from "./dev-loader-render";

const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(ROOT, "src/lianki.user.ts");
const TEMPLATE = resolve(ROOT, "scripts/dev-loader.user.js");
const WATCH_DIR = resolve(ROOT, "src");

const argv = Bun.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || !argv[i + 1] ? fallback : argv[i + 1];
};
const has = (name: string) => argv.includes(`--${name}`);

const PORT = Number(flag("port", "3003"));
// What the BUNDLE talks to for the API. Not the tunnel — the loader shadows
// GM_info.script.downloadURL with this, because the bundle derives its API
// origin from that field.
const APP_ORIGIN = flag("app", "https://lianki.com").replace(/\/+$/, "");
const FIXED_ORIGIN = flag("origin", "").replace(/\/+$/, "");
// A named tunnel (`--tunnel lianki-dev --origin https://dev.lianki.com`) keeps
// the hostname across restarts, so an install survives. Without a name we spawn
// a quick tunnel, whose hostname dies with the process. With --origin but no
// name, you are running the tunnel yourself and we spawn nothing.
const TUNNEL_NAME = flag("tunnel", "");
const WANT_TUNNEL = TUNNEL_NAME ? true : !FIXED_ORIGIN && !has("no-tunnel");

if (TUNNEL_NAME && !FIXED_ORIGIN) {
  console.error(
    `--tunnel ${TUNNEL_NAME} needs --origin too: a named tunnel's hostname lives\n` +
      `in its DNS route, which cloudflared never prints. e.g.\n` +
      `  bun run dev:loader --tunnel ${TUNNEL_NAME} --origin https://dev.lianki.com`,
  );
  process.exit(1);
}

let origin = FIXED_ORIGIN || `http://localhost:${PORT}`;

// ── build ───────────────────────────────────────────────────────────────────

let bundle = "";
let rev = "";
let version = "0.0.0";
let buildError: string | null = null;
let builds = 0;

const hash = (s: string) => Bun.hash(s).toString(36).slice(0, 6);

async function build(): Promise<boolean> {
  const t0 = performance.now();
  try {
    const out = await Bun.build({
      entrypoints: [ENTRY],
      target: "browser",
      format: "iife",
      // Sourcemaps would double the payload for something that is eval'd as an
      // anonymous script anyway — the manager cannot map it back.
      sourcemap: "none",
    });
    if (!out.success) throw new Error(out.logs.map(String).join("\n"));
    const code = await out.outputs[0].text();
    // Read the version from the source header rather than the build output:
    // the bundler is free to drop leading comments.
    version = (readFileSync(ENTRY, "utf8").match(/^\/\/\s*@version\s+(\S+)/m) || [])[1] || "0.0.0";
    buildError = null;
    builds++;
    const next = hash(code);
    const changed = next !== rev;
    bundle = code;
    rev = next;
    const ms = Math.round(performance.now() - t0);
    log(
      changed
        ? `build #${builds} → rev ${rev} (v${version}, ${(code.length / 1024) | 0} KB, ${ms}ms)`
        : `build #${builds} → unchanged (${ms}ms)`,
    );
    return changed;
  } catch (err) {
    buildError = String((err as Error)?.message ?? err);
    log(`build FAILED — keeping rev ${rev || "(none)"}\n${buildError}`);
    return false;
  }
}

// ── clients ─────────────────────────────────────────────────────────────────

type Client = {
  id: string;
  first: number;
  last: number;
  page: string;
  loads: number;
  errors: number;
};
const clients = new Map<string, Client>();

function touch(id: string, page = "") {
  if (!id) return;
  let c = clients.get(id);
  if (!c) {
    c = { id, first: Date.now(), last: 0, page, loads: 0, errors: 0 };
    clients.set(id, c);
    log(`client ${id} attached`);
  }
  c.last = Date.now();
  if (page) c.page = page;
  return c;
}

// ── long poll ───────────────────────────────────────────────────────────────

const waiters = new Set<(rev: string) => void>();
const HOLD_MS = 30_000; // must stay under the loader's 35s request timeout

function wake() {
  // Copy first: each callback deletes itself from the set as it resolves.
  for (const w of [...waiters]) w(rev);
  waiters.clear();
}

// ── server ──────────────────────────────────────────────────────────────────

const text = (body: string, type = "text/plain; charset=utf-8", extra: HeadersInit = {}) =>
  new Response(body, {
    headers: {
      "content-type": type,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...extra,
    },
  });

function startServer() {
  return Bun.serve({
    port: PORT,
    // "::" not "0.0.0.0": cloudflared resolves an ingress of http://localhost
    // to [::1] first, and an IPv4-only bind makes it 502 with
    // "dial tcp [::1]:<port>: connect: connection refused". Linux dual-stack
    // sockets accept IPv4-mapped connections too, so this covers both.
    hostname: "::",
    // Default is 10s, which would cut every long poll short.
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      const id = url.searchParams.get("id") ?? "";

      if (url.pathname === "/loader.user.js") {
        touch(id);
        // .user.js + a JS content type is what makes a manager offer to install.
        return text(
          renderLoader({ origin, appOrigin: APP_ORIGIN, version, rev }),
          "text/javascript; charset=utf-8",
        );
      }

      if (url.pathname === "/bundle.js") {
        const c = touch(id);
        if (c) c.loads++;
        if (!bundle) return new Response("build not ready\n" + (buildError ?? ""), { status: 503 });
        return text(bundle, "text/javascript; charset=utf-8", { "x-lianki-rev": rev });
      }

      if (url.pathname === "/wait") {
        touch(id);
        if ((url.searchParams.get("rev") ?? "") !== rev) return text(rev);
        // Park until the next changed build, then answer with the new rev. On
        // timeout answer with the CURRENT rev — the loader compares and re-polls.
        const parked = await new Promise<string>((resolvePoll) => {
          const done = (r: string) => {
            clearTimeout(timer);
            waiters.delete(done);
            resolvePoll(r);
          };
          const timer = setTimeout(() => done(rev), HOLD_MS);
          waiters.add(done);
          req.signal.addEventListener("abort", () => done(rev), { once: true });
        });
        return text(parked);
      }

      if (url.pathname === "/error" && req.method === "POST") {
        const c = touch(id);
        if (c) c.errors++;
        let body: { what?: string; detail?: string; page?: string } = {};
        try {
          body = await req.json();
        } catch {
          body = { detail: await req.text() };
        }
        if (c && body.page) c.page = body.page;
        log(
          `✗ ${id || "?"} ${body.what ?? "error"} @ ${body.page ?? "?"}\n   ${body.detail ?? ""}`,
        );
        return text("ok");
      }

      if (url.pathname === "/health") {
        return Response.json({
          rev,
          version,
          origin,
          app: APP_ORIGIN,
          clients: clients.size,
          buildError,
        });
      }

      if (url.pathname === "/") {
        const rows = [...clients.values()]
          .sort((a, b) => b.last - a.last)
          .map(
            (c) =>
              `<tr><td>${c.id}</td><td>${((Date.now() - c.last) / 1000) | 0}s ago</td>` +
              `<td>${c.loads}</td><td>${c.errors}</td><td>${escapeHtml(c.page)}</td></tr>`,
          )
          .join("");
        return text(
          `<!doctype html><meta charset=utf-8><title>lianki dev loader</title>
<style>body{font:14px/1.5 ui-monospace,monospace;margin:2rem;max-width:60rem}
td,th{padding:.2rem .8rem .2rem 0;text-align:left}a{color:inherit}
code{background:#8881;padding:.1rem .3rem;border-radius:3px}</style>
<h1>lianki dev loader</h1>
<p>install once → <a href="${origin}/loader.user.js">${origin}/loader.user.js</a></p>
<p>rev <code>${rev}</code> · v${version} · build #${builds} · bundle talks to <code>${APP_ORIGIN}</code></p>
${buildError ? `<pre style="color:#c00">${escapeHtml(buildError)}</pre>` : ""}
<h2>clients (${clients.size})</h2>
<table><tr><th>id<th>seen<th>loads<th>errors<th>page</tr>${rows || "<tr><td>none yet</td></tr>"}</table>`,
          "text/html; charset=utf-8",
        );
      }

      return new Response("not found", { status: 404 });
    },
  });
}

const escapeHtml = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

function log(msg: string) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] ${msg}`);
}

// ── watch ───────────────────────────────────────────────────────────────────

let debounce: ReturnType<typeof setTimeout> | null = null;

function startWatch() {
  watch(WATCH_DIR, { recursive: true }, (_e, file) => {
    if (file && !/\.(ts|js|css|json)$/.test(file)) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      if (await build()) {
        log(`pushing rev ${rev} to ${waiters.size} parked client(s)`);
        wake();
      }
    }, 120);
  });
}

// ── tunnel ──────────────────────────────────────────────────────────────────

let tunnel: ChildProcess | null = null;

function startTunnel() {
  const args = TUNNEL_NAME
    ? ["tunnel", "--no-autoupdate", "run", "--url", `http://localhost:${PORT}`, TUNNEL_NAME]
    : ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`];
  log(
    TUNNEL_NAME
      ? `starting named tunnel ${TUNNEL_NAME} → ${origin}…`
      : "starting cloudflare quick tunnel…",
  );
  tunnel = spawn("cloudflared", args, { stdio: ["ignore", "pipe", "pipe"] });
  // cloudflared prints the hostname several seconds BEFORE the edge can route
  // to it. Announcing on the URL alone sends you to install a loader from a
  // host that still 404s, so hold the banner until a connection registers.
  let announced = false;
  let routable = false;
  const scan = (chunk: Buffer) => {
    const s = chunk.toString();
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== origin) origin = m[0];
    if (/Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(s)) routable = true;
    // A named tunnel prints no URL — its hostname came from --origin, so a
    // registered connection is the only signal there is.
    if (!announced && routable && (TUNNEL_NAME || origin.includes("trycloudflare.com"))) {
      announced = true;
      void announceWhenReachable();
    }
    if (/ERR|error/i.test(s) && !/Request failed/i.test(s)) process.stderr.write(s);
  };
  tunnel.stdout?.on("data", scan);
  tunnel.stderr?.on("data", scan);
  tunnel.on("exit", (code) => log(`cloudflared exited (${code}) — loader origin is now stale`));
}

// Registration is not reachability: the edge needs a few more seconds to route
// the hostname. Probe our own public URL first, so the printed install link
// works the moment it appears instead of 404ing on the first tap.
async function announceWhenReachable(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return banner(true);
    } catch {}
    await Bun.sleep(1000);
  }
  // Announce anyway — the tunnel is usually fine and it is THIS machine that
  // cannot see it (a resolver that has negative-cached the fresh hostname, no
  // IPv4 answer, corporate DNS). Say so rather than pretending it is ready.
  banner(false);
}

function banner(reachable = true) {
  const line = "─".repeat(64);
  console.log(`\n${line}
  install once:  ${origin}/loader.user.js
  status page:   ${origin}/
  bundle → API:  ${APP_ORIGIN}
  rev ${rev} · v${version}
${
  origin.includes("trycloudflare.com")
    ? "  NOTE quick tunnel: this hostname dies with this process, and the\n" +
      "       installed loader has it baked in. For an install that survives\n" +
      "       restarts use a named tunnel + --origin (see docs).\n"
    : ""
}${
    reachable
      ? ""
      : "  WARN this machine could not reach that URL (the tunnel is probably up —\n" +
        "       local DNS often has not picked up the fresh hostname yet). Try it\n" +
        "       from the target browser before debugging the server.\n"
  }  Disable the production Lianki userscript while this is installed.
${line}\n`);
}

// Importable for tests (unit/dev-loader.test.ts) — only the CLI entry starts
// a server, spawns cloudflared, or touches the filesystem watcher.
if (import.meta.main) {
  await build();
  const server = startServer();
  startWatch();
  if (WANT_TUNNEL) startTunnel();
  else banner();
  log(`listening on http://localhost:${PORT}`);

  process.on("SIGINT", () => {
    tunnel?.kill();
    server.stop(true);
    process.exit(0);
  });
}

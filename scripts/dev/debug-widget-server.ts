#!/usr/bin/env bun
/**
 * Hot-load the debug chat widget onto the owner's lianki.com pages
 * (docs/dev-debug-widget.md): build DebugChat on its own, watch packages/debug-chat (and app/components, lib), and tell
 * the pages to re-import it after each change. The page stays on lianki.com;
 * only the widget comes from here.
 *
 *   bun scripts/dev/debug-widget-server.ts --port 5180 --tailnet /lianki-widget
 *       # the default lane: `tailscale serve` (tailnet only, never funnel) at
 *       # https://<this machine>.ts.net/lianki-widget, removed again on exit
 *   bun scripts/dev/debug-widget-server.ts --port 5180 --no-tunnel   # localhost only
 *   bun scripts/dev/debug-widget-server.ts --port 5180 \
 *     --tunnel lianki-dev-mac --origin https://dev-mac.lianki.com  # a Cloudflare named tunnel
 *
 * Serves:
 *   GET /debug-chat.js   the widget (ESM; React comes from the page), CORS for lianki.com
 *   GET /events          SSE: `hello` with the current rev on connect, `reload` after a
 *                        rebuild that changed it — the page holds one EventSource
 *   GET /harness         a local host page for tests (no lianki-push needed)
 *   GET /health          {rev, origin, buildError, clients}
 *
 * Then, on the owner's page (debug mode):
 *   localStorage.setItem("lk:debug-widget-src", "<origin>/debug-chat.js"); location.reload()
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { ROOT, allowOrigin, buildHarness, buildWidget, sse } from "./debug-widget-build";

const argv = Bun.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  const next = argv[i + 1];
  return i === -1 || !next || next.startsWith("--") ? fallback : next;
};
const PORT = Number(flag("port", "5180"));
const TUNNEL = flag("tunnel");
/** `--tailnet /path`: mount this server there with `tailscale serve`. */
const TAILNET = flag("tailnet").replace(/\/+$/, "");
if (TAILNET && !/^\/[\w.-]+(\/[\w.-]+)*$/.test(TAILNET)) {
  console.error(`--tailnet wants a path like /lianki-widget, not ${TAILNET}`);
  process.exit(1);
}
/** This machine's tailnet name, e.g. my-mac.example-tailnet.ts.net. */
function tailnetHost(): string {
  const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tailscale status failed: ${r.stderr || r.error}`);
  return String((JSON.parse(r.stdout) as { Self: { DNSName: string } }).Self.DNSName).replace(
    /\.$/,
    "",
  );
}
let ORIGIN = flag("origin").replace(/\/+$/, "") || `http://localhost:${PORT}`;
if (TAILNET) ORIGIN = `https://${tailnetHost()}${TAILNET}`;
if (TUNNEL && !flag("origin")) {
  console.error(
    `--tunnel ${TUNNEL} needs --origin too (its hostname lives in the DNS route), e.g.\n` +
      `  bun scripts/dev/debug-widget-server.ts --tunnel ${TUNNEL} --origin https://dev-mac.lianki.com`,
  );
  process.exit(1);
}

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

let code = "";
let rev = "";
let buildError: string | null = null;
let inputs: string[] = [];

/** Rebuild; true when the output changed (only then are pages told). */
async function build(): Promise<boolean> {
  const t0 = performance.now();
  try {
    const b = await buildWidget();
    buildError = null;
    inputs = b.inputs;
    const changed = b.rev !== rev;
    code = b.code;
    rev = b.rev;
    log(
      `build → ${changed ? `rev ${rev}` : "unchanged"} (${(code.length / 1024) | 0} KB, ${Math.round(performance.now() - t0)} ms)`,
    );
    return changed;
  } catch (e) {
    buildError = (e as Error).message;
    log(`build FAILED — keeping rev ${rev || "(none)"}\n${buildError}`);
    return false;
  }
}

// ── SSE clients ───────────────────────────────────────────────────────────────
const clients = new Set<ReadableStreamDefaultController<string>>();
const push = (event: string, data: string) => {
  for (const c of clients)
    try {
      c.enqueue(sse(event, data));
    } catch {
      clients.delete(c);
    }
};

function cors(req: Request): Record<string, string> {
  return {
    "access-control-allow-origin": allowOrigin(req.headers.get("origin")),
    "access-control-allow-private-network": "true",
    vary: "Origin",
    "cache-control": "no-store",
  };
}

function startServer() {
  return Bun.serve({
    port: PORT,
    // cloudflared dials http://localhost, which resolves to [::1] first.
    hostname: "::",
    // An SSE stream is idle between rebuilds: never cut it here.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const h = cors(req);
      if (req.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            ...h,
            "access-control-allow-methods": "GET",
            "access-control-allow-headers": "*",
          },
        });
      if (url.pathname === "/debug-chat.js") {
        if (!code)
          return new Response(`build not ready\n${buildError ?? ""}`, { status: 503, headers: h });
        return new Response(code, {
          headers: { ...h, "content-type": "text/javascript; charset=utf-8", "x-lianki-rev": rev },
        });
      }
      if (url.pathname === "/events") {
        let me: ReadableStreamDefaultController<string>;
        const stream = new ReadableStream<string>({
          start(c) {
            me = c;
            clients.add(c);
            c.enqueue(`retry: 2000\n${sse("hello", rev)}`);
            log(`page attached (${clients.size})`);
          },
          cancel() {
            clients.delete(me);
            log(`page detached (${clients.size})`);
          },
        });
        req.signal.addEventListener("abort", () => clients.delete(me));
        return new Response(stream, { headers: { ...h, "content-type": "text/event-stream" } });
      }
      if (url.pathname === "/harness")
        return new Response(
          `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width">` +
            `<title>debug widget harness</title><style>:root{--background:oklch(0.98 0.01 85);--foreground:oklch(0.2 0.01 60)}</style>` +
            `<div id=root></div><script type=module src="harness.js"></script>`,
          { headers: { ...h, "content-type": "text/html; charset=utf-8" } },
        );
      if (url.pathname === "/harness.js")
        return new Response(await buildHarness(), {
          headers: { ...h, "content-type": "text/javascript; charset=utf-8" },
        });
      if (url.pathname === "/health")
        return Response.json(
          { rev, origin: ORIGIN, buildError, clients: clients.size },
          { headers: h },
        );
      return new Response("not found", { status: 404, headers: h });
    },
  });
}

/** Watch what the widget is built from (the build's own inputs), rebuild, push `reload`. */
function startWatch() {
  let t: ReturnType<typeof setTimeout> | undefined;
  const dirs = ["packages/debug-chat", "app/components", "lib"].map((d) => resolve(ROOT, d));
  for (const dir of dirs)
    watch(dir, { recursive: true }, (_e, file) => {
      if (!file || !inputs.includes(resolve(dir, file))) return;
      clearTimeout(t);
      t = setTimeout(async () => {
        if (await build()) {
          log(`reload → ${clients.size} page(s)`);
          push("reload", rev);
        }
      }, 120);
    });
}

/** `tailscale serve` (never funnel): this port at <host><path>, tailnet only. */
function startTailnet() {
  const r = spawnSync(
    "tailscale",
    ["serve", "--bg", "--set-path", TAILNET, `http://127.0.0.1:${PORT}`],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    log(`tailscale serve failed: ${r.stderr || r.error}`);
    process.exit(1);
  }
  log(`tailnet: ${ORIGIN}/debug-chat.js (tailscale serve, tailnet only)`);
}
function stopTailnet() {
  spawnSync("tailscale", ["serve", "--set-path", TAILNET, "off"], { encoding: "utf8" });
  log(`tailnet mapping ${TAILNET} removed`);
}

let tunnel: ChildProcess | null = null;
let stopping = false;
function startTunnel() {
  log(`starting named tunnel ${TUNNEL} → ${ORIGIN}…`);
  tunnel = spawn(
    "cloudflared",
    ["tunnel", "--no-autoupdate", "run", "--url", `http://localhost:${PORT}`, TUNNEL],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const scan = (b: Buffer) => {
    const s = b.toString();
    if (/Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(s))
      log(`tunnel up: ${ORIGIN}/debug-chat.js`);
    if (/ERR|error/i.test(s) && !/Request failed/i.test(s)) process.stderr.write(s);
  };
  tunnel.stdout?.on("data", scan);
  tunnel.stderr?.on("data", scan);
  tunnel.on("error", (e) => {
    log(`cloudflared did not start (${e.message}) — is it installed? See docs/dev-debug-widget.md`);
    process.exit(1);
  });
  tunnel.on("exit", (c) => {
    if (stopping) return;
    // Without its tunnel nobody can reach this server: exit rather than look healthy.
    log(`cloudflared exited (${c}) — exiting`);
    process.exit(1);
  });
}

if (import.meta.main) {
  await build();
  const server = startServer();
  startWatch();
  if (TUNNEL) startTunnel();
  if (TAILNET) startTailnet();
  log(`listening on http://localhost:${PORT} · harness http://localhost:${PORT}/harness`);
  console.log(
    `\n  On the owner's page (debug mode), in the console or with eval.ts:\n` +
      `    localStorage.setItem("lk:debug-widget-src", "${ORIGIN}/debug-chat.js"); location.reload()\n` +
      `  Back to the built-in chat:\n` +
      `    localStorage.removeItem("lk:debug-widget-src"); location.reload()\n`,
  );
  const stop = () => {
    stopping = true;
    tunnel?.kill();
    if (TAILNET) stopTailnet();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

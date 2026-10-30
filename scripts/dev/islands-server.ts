#!/usr/bin/env bun
/**
 * Hot islands (docs/dev-hot-islands.md): build lib/islands/entry.ts from the
 * working tree, watch app/, lib/ and packages/, and tell the owner's pages
 * which islands to re-import after each save. The page stays on lianki.com;
 * only the islands come from here.
 *
 *   bun scripts/dev/islands-server.ts --port 5181 --tailnet /lianki-islands
 *       # tailnet only (`tailscale serve`, never funnel), removed on exit
 *   bun scripts/dev/islands-server.ts --port 5181            # localhost only
 *   ... --entry <file>      build another entry (tests)
 *   ... --no-typecheck      push without running tsgo first
 *
 * Serves:
 *   GET /islands.js   the islands module (ESM; shared modules come from the page)
 *   GET /events       SSE: `hello <rev>` on connect; `slot-reload {rev, names}`
 *                     after a rebuild, naming only the islands whose code changed
 *   GET /health       {rev, origin, buildError, clients, fingerprints}
 *
 * Then, on the owner's page (debug mode, with a code-run grant):
 *   localStorage.setItem("lk:slots-src", "<origin>/islands.js"); location.reload()
 */
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { ROOT, allowOrigin, sse } from "./debug-widget-build";
import { ISLANDS_ENTRY, buildIslands, changedIslands, typeErrorFiles } from "./islands-build";
import { serveOnTailnet, tailnetHost, unserveOnTailnet, validTailnetPath } from "./tailnet";

const argv = Bun.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  const next = argv[i + 1];
  return i === -1 || !next || next.startsWith("--") ? fallback : next;
};
const PORT = Number(flag("port", "5181"));
const ENTRY = flag("entry") ? resolve(flag("entry")) : ISLANDS_ENTRY;
const TYPECHECK = !argv.includes("--no-typecheck");
const TAILNET = flag("tailnet").replace(/\/+$/, "");
if (TAILNET && !validTailnetPath(TAILNET)) {
  console.error(`--tailnet wants a path like /lianki-islands, not ${TAILNET}`);
  process.exit(1);
}
const ORIGIN = TAILNET ? `https://${tailnetHost()}${TAILNET}` : `http://localhost:${PORT}`;
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

let code = "";
let rev = "";
let buildError: string | null = null;
let inputs: string[] = [];
let fingerprints: Record<string, string> = {};
let entryHash = "";

/** tsgo over the project; the files it reports errors in, and its output. */
async function typecheck(): Promise<{ files: string[]; output: string }> {
  const p = spawn(resolve(ROOT, "node_modules/.bin/tsgo"), ["--noEmit"], { cwd: ROOT });
  let output = "";
  p.stdout.on("data", (b) => (output += b));
  p.stderr.on("data", (b) => (output += b));
  await new Promise((r) => p.on("close", r));
  return { files: typeErrorFiles(output), output };
}

/**
 * Rebuild. Returns the islands to reload ([] = all of them), or null when
 * nothing changed, or the build or the typecheck of its inputs failed (the
 * last good build stays).
 */
async function build(): Promise<string[] | null> {
  const t0 = performance.now();
  try {
    const [b, tc] = await Promise.all([
      buildIslands(ENTRY),
      TYPECHECK ? typecheck() : Promise.resolve({ files: [], output: "" }),
    ]);
    const bad = tc.files.filter((f) => b.inputs.includes(f));
    if (bad.length) {
      const lines = tc.output
        .split("\n")
        .filter((l) => bad.some((f) => l.startsWith(f.slice(ROOT.length + 1))));
      throw new Error(`typecheck failed — an island breaks its contract?\n${lines.join("\n")}`);
    }
    buildError = null;
    if (b.rev === rev) {
      log(`build → unchanged (${Math.round(performance.now() - t0)} ms)`);
      return null;
    }
    let names = changedIslands(fingerprints, b.fingerprints, b.entryHash !== entryHash);
    // Something every island shares changed (the contract, CSS): reload them all.
    if (!names.length) names = Object.keys(b.fingerprints);
    code = b.code;
    rev = b.rev;
    inputs = b.inputs;
    fingerprints = b.fingerprints;
    entryHash = b.entryHash;
    log(
      `build → rev ${rev} [${names.join(", ") || "all"}] (${(code.length / 1024) | 0} KB, ${Math.round(performance.now() - t0)} ms)`,
    );
    return names;
  } catch (e) {
    buildError = (e as Error).message;
    log(`build FAILED — keeping rev ${rev || "(none)"}\n${buildError}`);
    return null;
  }
}

const clients = new Set<ReadableStreamDefaultController<string>>();
const push = (event: string, data: string) => {
  for (const c of clients)
    try {
      c.enqueue(sse(event, data));
    } catch {
      clients.delete(c);
    }
};

const cors = (req: Request): Record<string, string> => ({
  "access-control-allow-origin": allowOrigin(req.headers.get("origin")),
  "access-control-allow-private-network": "true",
  vary: "Origin",
  "cache-control": "no-store",
});

function startServer() {
  return Bun.serve({
    port: PORT,
    hostname: "::",
    idleTimeout: 0,
    fetch(req) {
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
      if (url.pathname === "/islands.js") {
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
      if (url.pathname === "/health")
        return Response.json(
          { rev, origin: ORIGIN, buildError, clients: clients.size, fingerprints },
          { headers: h },
        );
      return new Response("not found", { status: 404, headers: h });
    },
  });
}

/** Watch the working tree (and the entry's folder); rebuild on a change to a build input. */
function startWatch() {
  let t: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  const dirs = new Set(["app", "lib", "packages"].map((d) => resolve(ROOT, d)));
  if (!ENTRY.startsWith(`${ROOT}/`)) dirs.add(dirname(ENTRY));
  for (const dir of dirs)
    watch(dir, { recursive: true }, (_e, file) => {
      if (!file) return;
      const path = resolve(dir, file);
      if (path !== ENTRY && !inputs.includes(path)) return;
      clearTimeout(t);
      t = setTimeout(() => {
        queue = queue.then(async () => {
          const names = await build();
          if (!names) return;
          log(`slot-reload → ${clients.size} page(s)`);
          push("slot-reload", JSON.stringify({ rev, names }));
        });
      }, 120);
    });
}

if (import.meta.main) {
  await build();
  const server = startServer();
  startWatch();
  if (TAILNET) {
    const err = serveOnTailnet(TAILNET, PORT);
    if (err) {
      log(`tailscale serve failed: ${err}`);
      process.exit(1);
    }
  }
  log(`listening on http://localhost:${PORT} · module ${ORIGIN}/islands.js`);
  console.log(
    `\n  On the owner's page (debug mode, code-run grant live), in the console:\n` +
      `    localStorage.setItem("lk:slots-src", "${ORIGIN}/islands.js"); location.reload()\n` +
      `  Back to built-in islands:\n` +
      `    localStorage.removeItem("lk:slots-src"); location.reload()\n`,
  );
  const stop = () => {
    if (TAILNET) unserveOnTailnet(TAILNET);
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

#!/usr/bin/env bun
/**
 * Run JavaScript on the owner's debug-mode Lianki pages (the installed PWA on
 * /words, say), after the owner allows it on the page. docs/monitoring.md,
 * "Remote eval (owner debug)", has the whole flow and its security model.
 *
 *   bun scripts/dev/eval.ts serve [--label "…"]
 *       Pair once and hold the session (an hour at most): prints a short code
 *       that the page's prompt shows too — the owner taps "Allow for 1 hour"
 *       if they match. Keep it running (in the background); the commands
 *       below then go through it without asking again.
 *
 *   bun scripts/dev/eval.ts [--target <text>] '<code>'      (or - for stdin)
 *       Run code on every open debug page (or those whose label — path + user
 *       agent — contains <text>) and print each page's result as JSON. With
 *       no `serve` session running, it pairs for this one command.
 *
 * `code` is an expression (`document.title`) or a function body (`return x`);
 * `await` works in both. No secret is stored anywhere: approval is per
 * socket, on the owner's device. LIANKI_URL overrides https://lianki.com.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const BASE = (process.env.LIANKI_URL ?? "https://lianki.com").replace(/\/+$/, "");
const SESSION = join(homedir(), ".config", "lianki", "eval-session.json");
/** How long to wait for the pages' results after sending. */
const RESULT_MS = 20_000;
const PAIR_MS = 2 * 60_000;

type Msg = Record<string, unknown> & { type?: string };

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const label = flag("--label") ?? `lianki main lane on ${hostname()}`;
const target = flag("--target");

/** Open the controller socket and wait for the owner's answer. */
function pair(): Promise<WebSocket> {
  const url = `${BASE.replace(/^http/, "ws")}/api/version/debug/control?label=${encodeURIComponent(label)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const give = setTimeout(() => {
      ws.close();
      reject(new Error("no answer on the page within 2 minutes"));
    }, PAIR_MS);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "pending")
        console.error(`Pairing as "${label}". On the page, allow code  ${m.code}`);
      else if (m.type === "approved") {
        clearTimeout(give);
        ws.onmessage = null;
        console.error(`Approved until ${new Date(Number(m.until)).toLocaleTimeString()}.`);
        resolve(ws);
      } else if (m.type === "error" || m.type === "denied" || m.type === "expired") {
        clearTimeout(give);
        reject(new Error(String(m.error ?? m.type)));
      }
    };
    ws.onclose = (e) => {
      clearTimeout(give);
      reject(new Error(`socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`));
    };
  });
}

/** Send one command over an approved socket; resolve with every page's result. */
function run(ws: WebSocket, code: string, target?: string): Promise<Msg[]> {
  return new Promise((resolve, reject) => {
    let id: string | undefined;
    let expected = Infinity;
    const results: Msg[] = [];
    const done = () => {
      clearTimeout(give);
      ws.removeEventListener("message", on);
      resolve(results);
    };
    const give = setTimeout(done, RESULT_MS);
    const on = (e: MessageEvent) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "sent" && !id) {
        id = String(m.id);
        expected = Number(m.delivered);
        console.error(`eval ${id}: delivered to ${expected} page(s)`);
      } else if (m.type === "result" && m.id === id) results.push(m);
      else if (m.type === "error" || m.type === "expired" || m.type === "revoked") {
        clearTimeout(give);
        ws.removeEventListener("message", on);
        return reject(new Error(String(m.error ?? m.type)));
      }
      if (results.length >= expected) done();
    };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ type: "eval", code, target }));
  });
}

async function serve() {
  const ws = await pair();
  const token = randomBytes(24).toString("hex");
  let queue = Promise.resolve();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.headers.get("x-token") !== token) return new Response("forbidden", { status: 403 });
      const body = (await req.json()) as { code: string; target?: string };
      // One command at a time, so results are matched to the right request.
      const out = queue.then(() => run(ws, body.code, body.target));
      queue = out.then(
        () => undefined,
        () => undefined,
      );
      try {
        return Response.json({ results: await out });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 502 });
      }
    },
  });
  mkdirSync(join(homedir(), ".config", "lianki"), { recursive: true });
  writeFileSync(SESSION, JSON.stringify({ port: server.port, token, pid: process.pid }));
  chmodSync(SESSION, 0o600);
  console.error(`Session held on 127.0.0.1:${server.port} — run commands in another shell.`);
  const end = (why: string) => {
    console.error(`Session ended: ${why}`);
    rmSync(SESSION, { force: true });
    process.exit(0);
  };
  ws.addEventListener("close", (e) => end(`socket closed (${e.code})`));
  process.on("SIGINT", () => end("interrupted"));
  process.on("SIGTERM", () => end("terminated"));
}

/** A running `serve`, if there is one. */
async function viaSession(code: string): Promise<Msg[] | null> {
  if (!existsSync(SESSION)) return null;
  const { port, token } = JSON.parse(readFileSync(SESSION, "utf8")) as {
    port: number;
    token: string;
  };
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "x-token": token, "content-type": "application/json" },
      body: JSON.stringify({ code, target }),
    });
  } catch {
    rmSync(SESSION, { force: true });
    return null;
  }
  const out = (await res.json()) as { results?: Msg[]; error?: string };
  if (!res.ok) throw new Error(out.error ?? `session answered ${res.status}`);
  return out.results ?? [];
}

async function main() {
  if (args[0] === "serve") return serve();
  const code = args[0] === "-" ? await Bun.stdin.text() : args[0];
  if (!code?.trim()) {
    console.error("usage: bun scripts/dev/eval.ts [--target <text>] '<code>' | - | serve");
    process.exit(2);
  }
  let results = await viaSession(code);
  if (!results) {
    const ws = await pair();
    results = await run(ws, code, target);
    ws.close();
  }
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => r.ok !== true)) process.exitCode = 1;
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

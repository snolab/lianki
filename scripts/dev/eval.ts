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
 *   bun scripts/dev/eval.ts chat [--label "…"] [--out <path>]
 *       Listen to every chat thread: the owner's and each friend's (any
 *       signed-in user on a debug page). Pairs if there is no saved grant —
 *       prints {"type":"pending","code"} to stdout; the owner taps "Allow chat
 *       for 30 days" — then prints each new owner or friend message as one
 *       JSON line {"type":"chat","id","thread","email","from","text","at","label"}
 *       (thread "owner" or the friend's user id; label = page path + user
 *       agent), and {"type":"friend-new","userId","email","at"} when someone
 *       writes for the first time. Also appended to --out. Reconnects on
 *       close, backing off.
 *
 *   bun scripts/dev/eval.ts say [--to <thread|email>] "text"      (or - for stdin)
 *       Reply with the saved grant, and exit: to the owner by default, or to
 *       a friend's thread by user id or email.
 *
 *   bun scripts/dev/eval.ts serve --for <email> [--label "…"]
 *   bun scripts/dev/eval.ts --for <email> [--target <text>] '<code>'
 *       The same, on a friend's own debug pages ("Preview"): needs the saved
 *       chat grant, and the friend's tap on "Allow for 1 hour" on their
 *       device — tell them the printed code in the chat. That session reaches
 *       only their pages, never the owner's; it cannot chat.
 *
 * The chat grant token is kept in .debug-chat-token.json at the root of the
 * main checkout (gitignored, mode 600; LIANKI_CHAT_TOKEN_FILE overrides), so
 * every worktree shares it. "End" on the page revokes it.
 *
 * `code` is an expression (`document.title`) or a function body (`return x`);
 * `await` works in both. Eval approval is per socket, on the owner's device:
 * no secret is stored for it. LIANKI_URL overrides https://lianki.com.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const BASE = (process.env.LIANKI_URL ?? "https://lianki.com").replace(/\/+$/, "");
/** The running `serve`'s port and token: one file for the owner, one per friend. */
const sessionFile = (forEmail?: string) =>
  join(
    homedir(),
    ".config",
    "lianki",
    forEmail
      ? `eval-session-${forEmail.toLowerCase().replace(/[^a-z0-9@._-]/g, "_")}.json`
      : "eval-session.json",
  );
/** How long to wait for the pages' results after sending. */
const RESULT_MS = 20_000;
const PAIR_MS = 2 * 60_000;

type Msg = Record<string, unknown> & { type?: string };

/** The chat grant token, shared by every worktree: the main checkout's root. */
function tokenFile() {
  if (process.env.LIANKI_CHAT_TOKEN_FILE) return resolve(process.env.LIANKI_CHAT_TOKEN_FILE);
  const git = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: import.meta.dir,
  });
  const common = git.success ? git.stdout.toString().trim() : "";
  const root = common ? dirname(common) : join(import.meta.dir, "..", "..");
  return join(root, ".debug-chat-token.json");
}
const TOKEN_FILE = tokenFile();
const loadToken = () => {
  try {
    return (JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as { token?: string }).token;
  } catch {
    return undefined;
  }
};
const saveToken = (token: string, until: number) => {
  writeFileSync(TOKEN_FILE, JSON.stringify({ token, until: new Date(until).toISOString() }));
  chmodSync(TOKEN_FILE, 0o600);
};
/** Resuming a grant without --label keeps the label it was approved under. */
const controlUrl = (token?: string, forEmail?: string) =>
  `${BASE.replace(/^http/, "ws")}/api/version/debug/control?label=${encodeURIComponent(token ? (labelFlag ?? "") : label)}${forEmail ? `&for=${encodeURIComponent(forEmail)}` : ""}`;
/**
 * Bun's WebSocket takes headers, so the grant goes in one, never in the URL
 * (the repo type-checks with the DOM lib's constructor, hence the cast).
 * `forEmail` asks for a pairing on that friend's pages, which needs the grant.
 */
const openControl = (token?: string, forEmail?: string) =>
  token
    ? new WebSocket(controlUrl(token, forEmail), {
        headers: { "x-debug-token": token },
      } as unknown as string[])
    : new WebSocket(controlUrl());

const args = process.argv.slice(2);
// --help is not code to run on the owner's pages: print the usage above.
if (args[0] === "--help" || args[0] === "-h") {
  const src = readFileSync(new URL(import.meta.url).pathname, "utf8");
  console.log(src.slice(src.indexOf("/**"), src.indexOf("*/") + 2));
  process.exit(0);
}
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const labelFlag = flag("--label");
const label = labelFlag ?? `lianki main lane on ${hostname()}`;
const target = flag("--target");
const out = flag("--out");
const to = flag("--to");
const forEmail = flag("--for");
const SESSION = sessionFile(forEmail);

/** Open the controller socket and wait for the owner's answer. */
function pair(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    if (forEmail) {
      const token = loadToken();
      if (!token)
        return reject(
          new Error(`--for needs the chat grant in ${TOKEN_FILE}: run \`eval.ts chat\` first`),
        );
      ws = openControl(token, forEmail);
    } else ws = openControl();
    const give = setTimeout(() => {
      ws.close();
      reject(new Error("no answer on the page within 2 minutes"));
    }, PAIR_MS);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "pending" && forEmail)
        console.error(
          `Asking ${forEmail} for a 1-hour preview. Tell them in the chat to allow code  ${m.code}\n` +
            `  e.g. bun scripts/dev/eval.ts say --to ${forEmail} "Tap Allow on the preview request with code ${m.code}"`,
        );
      else if (m.type === "pending")
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

/**
 * Listen to the owner's chat: one JSON line per new owner message, on stdout
 * and appended to --out. Resumes with the saved grant; pairs when there is
 * none (or it was refused). Reconnects only when the socket closes.
 */
function chat(out?: string) {
  const seen = new Set<string>();
  let first = true;
  let backoff = 1_000;
  const print = (v: Record<string, unknown>) => {
    const line = JSON.stringify(v);
    console.log(line);
    if (out) appendFileSync(out, `${line}\n`);
  };
  const emit = (m: Msg) => {
    if (m.from === "agent" || typeof m.id !== "string" || seen.has(m.id)) return;
    seen.add(m.id);
    print({
      type: "chat",
      id: m.id,
      thread: m.thread ?? "owner",
      email: m.email ?? null,
      from: m.from,
      text: m.text,
      at: new Date(Number(m.at)).toISOString(),
      label: m.label,
    });
  };
  const connect = () => {
    const token = loadToken();
    const ws = openControl(token);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "pending") {
        console.log(JSON.stringify({ type: "pending", code: m.code, label }));
        console.error(
          `Pairing as "${label}". On the page, tap "Allow chat for 30 days" for code  ${m.code}`,
        );
      } else if (m.type === "approved") {
        backoff = 1_000;
        if (typeof m.token === "string") saveToken(m.token, Number(m.until));
        const until = new Date(Number(m.until)).toISOString();
        console.error(
          `${m.resumed ? "Resumed" : "Approved"} (${m.scope}) until ${until}.${
            m.scope === "eval" ? " No grant saved: a reconnect after this will ask again." : ""
          }`,
        );
      } else if (m.type === "history" && Array.isArray(m.messages)) {
        // What was said before this listener started is not new; what was
        // said while it was reconnecting is.
        for (const h of m.messages as Msg[])
          if (first && typeof h.id === "string") seen.add(h.id);
          else emit(h);
        first = false;
      } else if (m.type === "chat" && m.message) emit(m.message as Msg);
      else if (m.type === "friend-new")
        print({
          type: "friend-new",
          userId: m.userId,
          email: m.email,
          at: new Date(Number(m.at)).toISOString(),
        });
      else if (m.type === "error") console.error(`hub: ${m.error}`);
    };
    ws.onclose = (e) => {
      if (e.code === 4498) {
        // The grant is gone (ended, or expired): forget it and pair afresh.
        rmSync(TOKEN_FILE, { force: true });
        console.error("Saved chat grant refused; pairing again.");
        return connect();
      }
      if (e.code === 4401 || e.code === 4403) {
        if (e.code === 4401) rmSync(TOKEN_FILE, { force: true });
        console.error(e.code === 4401 ? "Ended on the page." : "Denied on the page.");
        process.exit(0);
      }
      console.error(`socket closed (${e.code}); reconnecting in ${backoff / 1000}s`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    };
  };
  connect();
}

/** Reply with the saved grant (to the owner, or `to` a friend); resolves once the hub has it. */
function say(text: string, to?: string): Promise<Msg> {
  const token = loadToken();
  if (!token)
    return Promise.reject(new Error(`no chat grant in ${TOKEN_FILE}: run \`eval.ts chat\` first`));
  return new Promise((resolve, reject) => {
    const ws = openControl(token);
    const give = setTimeout(() => {
      ws.close();
      reject(new Error("no answer from the hub within 15 s"));
    }, 15_000);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "approved")
        ws.send(JSON.stringify(to ? { type: "say", text, to } : { type: "say", text }));
      else if (m.type === "said") {
        clearTimeout(give);
        ws.close();
        resolve(m);
      } else if (m.type === "error") {
        clearTimeout(give);
        reject(new Error(String(m.error)));
      }
    };
    ws.onclose = (e) => {
      clearTimeout(give);
      if (e.code === 4498) rmSync(TOKEN_FILE, { force: true });
      reject(new Error(`socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`));
    };
  });
}

async function main() {
  if (args[0] === "serve") return serve();
  if (args[0] === "chat") return chat(out);
  if (args[0] === "say") {
    const text = (args[1] === "-" ? await Bun.stdin.text() : (args[1] ?? "")).trim();
    if (!text) {
      console.error('usage: bun scripts/dev/eval.ts say [--to <thread|email>] "text" | -');
      process.exit(2);
    }
    console.log(JSON.stringify(await say(text, to)));
    return;
  }
  const code = args[0] === "-" ? await Bun.stdin.text() : args[0];
  if (!code?.trim()) {
    console.error(
      "usage: bun scripts/dev/eval.ts [--for <email>] [--target <text>] '<code>' | - | serve [--for <email>] | chat [--out <file>] | say [--to <thread|email>] <text>",
    );
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

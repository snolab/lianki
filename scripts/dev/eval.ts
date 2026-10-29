#!/usr/bin/env bun
/**
 * Run JavaScript on the owner's debug-mode Lianki pages (the installed PWA on
 * /words, say), after the owner allows it on the page. docs/monitoring.md,
 * "Remote eval (owner debug)", has the whole flow and its security model.
 *
 *   bun scripts/dev/eval.ts serve [--label "…"] [--no-pair]
 *       Hold an eval session: resumes the saved eval grant if there is one
 *       (no prompt), else pairs — prints a short code that the page's prompt
 *       shows too; the owner taps Allow if they match, which grants eval
 *       (and chat) for 8 hours and saves the grant. Keep it running (in the
 *       background); the commands below then go through it. If its socket
 *       drops (the authorized page was away 5 min, a deploy, the network),
 *       the next command resumes with the grant, silently.
 *
 *   bun scripts/dev/eval.ts [--target <text>] [--no-pair] '<code>'   (or - for stdin)
 *       Run code on every open debug page (or those whose label — path + user
 *       agent — contains <text>) and print each page's result as JSON. With
 *       no `serve` session running it resumes the saved eval grant; only with
 *       none (or a refused one) does it pair, and waits for that one answer.
 *
 *   --no-pair  fail instead of asking the owner (for the chat agent).
 *
 *   bun scripts/dev/eval.ts chat [--label "…"] [--out <path>] [--exit-on-idle]
 *       Listen to every chat thread: the owner's and each friend's (any
 *       signed-in user on a debug page). Pairs if there is no saved grant —
 *       prints {"type":"pending","code"} to stdout; the owner taps "Allow chat
 *       for 30 days" — then prints each new owner or friend message as one
 *       JSON line {"type":"chat","id","thread","email","from","text","at","label"}
 *       (thread "owner" or the friend's user id; label = page path + user
 *       agent), and {"type":"friend-new","userId","email","at"} when someone
 *       writes for the first time, and {"type":"page-changed","thread",
 *       "email","label","at"} when a debug page navigates (silent on the
 *       page), {"type":"pages-idle","thread","at"} when every page of a
 *       thread has been closed for a minute and {"type":"pages-back",
 *       "thread","label","at"} when one opens again. It stays connected
 *       through idle (--exit-on-idle exits instead). Also appended to
 *       --out. Reconnects on close, backing off, by resuming the grant: it
 *       pairs at most once per run. With no grant left after that it prints
 *       {"type":"error"} and waits, without asking again, until restarted or
 *       a grant is saved by another run.
 *
 *   bun scripts/dev/eval.ts say [--to <thread|email>] "text"      (or - for stdin)
 *       Reply with the saved grant (the chat grant, else the eval grant:
 *       eval implies chat; never pairs), and exit: to the owner by default, or to
 *       a friend's thread by user id or email.
 *
 *   bun scripts/dev/eval.ts say --to /words/audio "text"
 *       Address a state-tree node instead of a thread (a `--to` starting
 *       with "/"): its listener gets it, its ancestors observe it. Allowed
 *       into the sender's own subtree and upward; anything else needs a
 *       grant (below), else {"type":"error","reason":"out of scope: …"}.
 *
 *   bun scripts/dev/eval.ts grant --from /words/prefetch --to /words/audio [--hours 8]
 *   bun scripts/dev/eval.ts ungrant --from /words/prefetch --to /words/audio
 *       Let senders within one node address another (or take it back): only
 *       from a listener whose node holds both — the main one ("/") always may.
 *
 *   --task-path /words/prefetch   (or env LIANKI_TASK_PATH)
 *   --agent <name>                (or env LIANKI_AGENT)
 *       Where this process sits in the state tree, for `chat`, `serve`,
 *       `say`, `busy` and `grant`: `chat` hears the lines addressed to that
 *       node (and, marked "observed": true, to the nodes below it) instead of
 *       the main thread; `say` lines carry the node as `taskPath` and the
 *       name as `agentId`, shown under the avatar as "/words › prefetch". A
 *       sub-agent sets the env vars once. docs/dev-debug-widget.md, "Node paths".
 *
 *   bun scripts/dev/eval.ts busy [--to <thread|email>] [--label "…"]
 *                                   [--every <s> [--keep] [--max <s>]]
 *       The heartbeat behind the chat's "agent is working" spinner, with the
 *       saved grant. Alone: one beat (the spinner shows for 12 s), then exit.
 *       --every 4: a beat every 4 s until the next agent reply in that thread
 *       (your `say`; --keep beats on past it), the process is killed, its
 *       stdin closes (when stdin is a pipe), every page of the thread has
 *       been closed for a minute (pages-idle), the socket drops, or --max
 *       seconds (default 1800) pass. Start it in the background on picking up
 *       a message; `say` ends it. Its socket is heartbeat-only (?beat=1): it
 *       is neither a session in the menu nor counted as "agent listening".
 *
 *   bun scripts/dev/eval.ts serve --for <email> [--label "…"]
 *   bun scripts/dev/eval.ts --for <email> [--target <text>] '<code>'
 *       The same, on a friend's own debug pages ("Preview"): needs the saved
 *       chat grant, and the friend's tap on Allow on their
 *       device — tell them the printed code in the chat. That session reaches
 *       only their pages, never the owner's; it cannot chat.
 *
 * Grant tokens live at the root of the main checkout, so every worktree
 * shares them (gitignored, mode 600): the chat grant in .debug-chat-token.json
 * (LIANKI_CHAT_TOKEN_FILE overrides), the eval grant in .debug-eval-token.json
 * (LIANKI_EVAL_TOKEN_FILE). "End" on the page revokes either. The rules for
 * when to resume and when to pair are in ./eval-grant.ts.
 *
 * `code` is an expression (`document.title`) or a function body (`return x`);
 * `await` works in both. A friend's preview (--for) is never saved: one
 * socket, an hour. LIANKI_URL overrides https://lianki.com.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  fstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { type NodeOpts, chatLine, nodeOpts } from "./node-args";
import { routeTo } from "@/lib/dev-eval";
import { type BusyArgs, beatMessage, endsBeat, idleFor, parseBusyArgs } from "./busy";
import { ENDED, GRANT_INVALID, chatClose, chatStep, serveClose } from "./eval-grant";
import {
  EVAL_TOKEN_FILE,
  type Msg,
  TOKEN_FILE,
  chatGrant,
  controller,
  loadToken,
  run,
  saveTo,
} from "./eval-socket";

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
const boolFlag = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};
const noPair = boolFlag("--no-pair");
/** chat: exit on {type:"pages-idle"} instead of staying for pages-back. */
const exitOnIdle = boolFlag("--exit-on-idle");
const labelFlag = flag("--label");
const label = labelFlag ?? `lianki main lane on ${hostname()}`;
const target = flag("--target");
const out = flag("--out");
const to = flag("--to");
const forEmail = flag("--for");
const fromFlag = flag("--from");
const hoursFlag = flag("--hours");
const placed = nodeOpts({ taskPath: flag("--task-path"), agent: flag("--agent") });
if ("error" in placed) {
  console.error(placed.error);
  process.exit(2);
}
const where: NodeOpts = placed;
const SESSION = sessionFile(forEmail);
const { openControl, evalSocket } = controller({
  label,
  labelFlag,
  forEmail,
  noPair,
  ...where,
});

async function serve() {
  let ws: WebSocket | null = await evalSocket();
  let connecting: Promise<WebSocket> | null = null;
  /** The socket, reopened with the saved grant if it dropped (no prompt; evalSocket's rules). */
  const socket = (): Promise<WebSocket> => {
    if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
    connecting ??= evalSocket()
      .then((s) => {
        ws = s;
        watchClose(s);
        return s;
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  };
  const token = randomBytes(24).toString("hex");
  let queue = Promise.resolve();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.headers.get("x-token") !== token) return new Response("forbidden", { status: 403 });
      const body = (await req.json()) as { code: string; target?: string };
      // One command at a time, so results are matched to the right request.
      const out = queue.then(async () => run(await socket(), body.code, body.target));
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
  function watchClose(s: WebSocket) {
    s.addEventListener("close", (e) => {
      if (s !== ws) return;
      ws = null;
      if (serveClose(e.code, !forEmail) === "end") {
        if (e.code === ENDED && !forEmail) rmSync(EVAL_TOKEN_FILE, { force: true });
        return end(`socket closed (${e.code})`);
      }
      console.error(`socket closed (${e.code}); the next command resumes with the saved grant.`);
    });
  }
  watchClose(ws);
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
 * none (or it was refused) — at most once per run (chatStep/chatClose).
 * Reconnects only when the socket closes.
 */
function chat(out?: string) {
  const seen = new Set<string>();
  let first = true;
  let backoff = 1_000;
  let asked = false;
  const print = (v: Record<string, unknown>) => {
    const line = JSON.stringify(v);
    console.log(line);
    if (out) appendFileSync(out, `${line}\n`);
  };
  /** A line routed to this listener (the hub's `observed`, or worked out for history). */
  const emit = (
    m: Msg,
    observed = routeTo(where.node, m.to as string | undefined) === "observed",
  ) => {
    if (typeof m.id !== "string" || seen.has(m.id)) return;
    const line = chatLine(m, where, observed);
    if (!line) return;
    seen.add(m.id);
    print(line);
  };
  /**
   * No grant, and the owner was asked once already: say so and wait — not
   * exiting, so nothing restarts it into another prompt. A grant saved by
   * another run (a file event, no polling) brings it back.
   */
  const giveUp = () => {
    const error =
      "no chat grant, and this listener already asked the owner once: not asking again; restart `eval.ts chat` to pair";
    print({ type: "error", error, at: new Date().toISOString() });
    console.error(error);
    const w = watch(dirname(TOKEN_FILE), (_ev, name) => {
      if (name !== basename(TOKEN_FILE) || !loadToken()) return;
      w.close();
      console.error("A chat grant was saved: resuming.");
      connect();
    });
  };
  const connect = () => {
    const token = loadToken();
    const step = chatStep({ token, paired: asked });
    if (step === "give-up") return giveUp();
    if (step === "pair") asked = true;
    const ws = openControl(token, undefined, "chat");
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "pending") {
        console.log(JSON.stringify({ type: "pending", code: m.code, label }));
        console.error(
          `Pairing as "${label}" (chat, 30 days). On the page, tap Allow if it shows code  ${m.code}`,
        );
      } else if (m.type === "approved") {
        backoff = 1_000;
        if (typeof m.token === "string") saveTo(TOKEN_FILE, m.token, Number(m.until));
        const until = new Date(Number(m.until)).toISOString();
        console.error(`${m.resumed ? "Resumed" : "Approved"} (${m.scope}) until ${until}.`);
      } else if (m.type === "history" && Array.isArray(m.messages)) {
        // What was said before this listener started is not new; what was
        // said while it was reconnecting is.
        for (const h of m.messages as Msg[])
          if (first && typeof h.id === "string") seen.add(h.id);
          else emit(h);
        first = false;
      } else if (m.type === "chat" && m.message) emit(m.message as Msg, m.observed === true);
      else if (m.type === "pages-idle" || m.type === "pages-back") {
        // Every page of a thread closed for a minute, or the first one back.
        // The listener stays (its socket is hibernated, it costs nothing) so
        // pages-back can wake the agent, unless --exit-on-idle.
        print({
          type: m.type,
          thread: m.thread ?? "owner",
          ...(m.type === "pages-back" ? { label: m.label } : {}),
          at: new Date(Number(m.at)).toISOString(),
        });
        if (m.type === "pages-idle" && exitOnIdle) {
          console.error(`Pages idle (${String(m.thread)}); exiting (--exit-on-idle).`);
          process.exit(0);
        }
      } else if (m.type === "page-changed")
        print({
          type: "page-changed",
          thread: m.thread ?? "owner",
          email: m.email ?? null,
          label: m.label,
          at: new Date(Number(m.at)).toISOString(),
        });
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
      const what = chatClose(e.code);
      if (what === "refused") {
        // The grant is gone (ended, or expired): forget it. connect() pairs
        // only if this run has not asked the owner yet.
        rmSync(TOKEN_FILE, { force: true });
        console.error("Saved chat grant refused.");
        return connect();
      }
      if (what === "ended" || what === "denied") {
        if (what === "ended") rmSync(TOKEN_FILE, { force: true });
        console.error(what === "ended" ? "Ended on the page." : "Denied on the page.");
        process.exit(0);
      }
      // No grant to resume with (a pairing that was never answered, or
      // failed): connect() gives up rather than asking again.
      if (!loadToken()) return connect();
      console.error(`socket closed (${e.code}); resuming in ${backoff / 1000}s`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    };
  };
  connect();
}

/** Reply with the saved grant (to the owner, or `to` a friend); resolves once the hub has it. */
function say(text: string, to?: string): Promise<Msg> {
  const grant = chatGrant();
  if (!grant)
    return Promise.reject(new Error(`no chat grant in ${TOKEN_FILE}: run \`eval.ts chat\` first`));
  return new Promise((resolve, reject) => {
    const ws = openControl(grant.token);
    const give = setTimeout(() => {
      ws.close();
      reject(new Error("no answer from the hub within 15 s"));
    }, 15_000);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "approved")
        ws.send(
          JSON.stringify({
            type: "say",
            text,
            ...(to ? { to } : {}),
            ...(where.node ? { taskPath: where.node } : {}),
            ...(where.agent ? { agentId: where.agent } : {}),
          }),
        );
      else if (m.type === "said") {
        clearTimeout(give);
        ws.close();
        resolve(m);
      } else if (m.type === "error") {
        clearTimeout(give);
        ws.close();
        reject(new Error(String(m.reason ?? m.error)));
      }
    };
    ws.onclose = (e) => {
      clearTimeout(give);
      // Refused: forget it, and fail. say never pairs.
      if (e.code === GRANT_INVALID) rmSync(grant.file, { force: true });
      reject(new Error(`socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`));
    };
  });
}

/**
 * The heartbeat: one beat, or (with `every`) a beat every few seconds until
 * the agent's reply in that thread, the socket closing, stdin closing (a
 * pipe), --max, or a kill. The only timer here that touches the network, and
 * the owner asked for it.
 */
function busy(w: BusyArgs): Promise<void> {
  const grant = chatGrant();
  if (!grant)
    return Promise.reject(new Error(`no chat grant in ${TOKEN_FILE}: run \`eval.ts chat\` first`));
  return new Promise((resolve, reject) => {
    // Heartbeat-only: not a session in the menu, not "agent listening".
    const ws = openControl(grant.token, undefined, "chat", true);
    let thread: string | undefined;
    let loop: ReturnType<typeof setInterval> | undefined;
    let done = false;
    const stop = (why: string, err?: Error) => {
      if (done) return;
      done = true;
      clearInterval(loop);
      clearTimeout(give);
      clearTimeout(cap);
      try {
        ws.close();
      } catch {}
      if (err) return reject(err);
      if (w.every) console.error(`busy: stopped (${why})`);
      resolve();
    };
    const give = setTimeout(
      () => stop("", new Error("no answer from the hub within 15 s")),
      15_000,
    );
    const cap = setTimeout(() => stop(`--max ${w.maxSeconds}s`), w.maxSeconds * 1000);
    const beat = () => ws.send(beatMessage(w));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "approved") {
        clearTimeout(give);
        beat();
        if (w.every) loop = setInterval(beat, w.every * 1000);
      } else if (m.type === "beat") {
        if (!thread) {
          thread = String(m.thread);
          console.log(JSON.stringify(m));
        }
        if (!w.every) stop("one beat");
      } else if (w.untilSay && endsBeat(m, thread)) stop("the agent replied");
      else if (idleFor(m, thread)) stop("every page of the thread closed");
      else if (m.type === "error") stop("", new Error(String(m.error)));
    };
    ws.onclose = (e) => {
      // Refused: forget it, and stop. busy never pairs (nor reconnects).
      if (e.code === GRANT_INVALID) rmSync(grant.file, { force: true });
      stop(
        `socket closed (${e.code})`,
        done || thread ? undefined : new Error(`socket closed (${e.code})`),
      );
    };
    if (w.every) {
      process.on("SIGINT", () => stop("interrupted"));
      process.on("SIGTERM", () => stop("terminated"));
      // A pipe on stdin is a lifeline: its end stops the beat. /dev/null or a
      // terminal is not one (it would end at once, or never).
      let pipe = false;
      try {
        pipe = fstatSync(0).isFIFO();
      } catch {}
      if (pipe) {
        process.stdin.on("end", () => stop("stdin closed"));
        process.stdin.on("close", () => stop("stdin closed"));
        process.stdin.resume();
      }
    }
  });
}

/** A node grant (or its end) from this listener's node; resolves with the hub's ack. */
function nodeGrant(type: "grant" | "ungrant", from: string, toNode: string, hours?: number) {
  const grant = chatGrant();
  if (!grant)
    return Promise.reject(new Error(`no chat grant in ${TOKEN_FILE}: run \`eval.ts chat\` first`));
  return new Promise<Msg>((resolve, reject) => {
    const ws = openControl(grant.token);
    const give = setTimeout(() => {
      ws.close();
      reject(new Error("no answer from the hub within 15 s"));
    }, 15_000);
    const done = (fn: () => void) => {
      clearTimeout(give);
      ws.close();
      fn();
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "approved")
        ws.send(
          JSON.stringify({
            type,
            from,
            to: toNode,
            ...(hours ? { ms: Math.round(hours * 3_600_000) } : {}),
          }),
        );
      else if (m.type === "granted" || m.type === "ungranted") done(() => resolve(m));
      else if (m.type === "error") done(() => reject(new Error(String(m.reason ?? m.error))));
    };
    ws.onclose = (e) => {
      clearTimeout(give);
      if (e.code === GRANT_INVALID) rmSync(grant.file, { force: true });
      reject(new Error(`socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`));
    };
  });
}

async function main() {
  if (args[0] === "grant" || args[0] === "ungrant") {
    if (!fromFlag || !to) {
      console.error(
        `usage: bun scripts/dev/eval.ts ${args[0]} --from /node/a --to /node/b${args[0] === "grant" ? " [--hours 8]" : ""}`,
      );
      process.exit(2);
    }
    const hours = hoursFlag ? Number(hoursFlag) : undefined;
    console.log(JSON.stringify(await nodeGrant(args[0], fromFlag, to, hours)));
    return;
  }
  if (args[0] === "busy") {
    const w = parseBusyArgs([
      ...args.slice(1),
      ...(to ? ["--to", to] : []),
      ...(labelFlag ? ["--label", labelFlag] : []),
    ]);
    if ("error" in w) {
      console.error(
        `${w.error}\nusage: bun scripts/dev/eval.ts busy [--to <thread|email>] [--label X] [--every <s> [--keep] [--max <s>]]`,
      );
      process.exit(2);
    }
    await busy(w);
    process.exit(0);
  }
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
      "usage: bun scripts/dev/eval.ts [--for <email>] [--target <text>] [--no-pair] '<code>' | - | serve [--for <email>] [--no-pair] | chat [--out <file>] [--exit-on-idle] | say [--to <thread|email>] <text>",
    );
    process.exit(2);
  }
  let results = await viaSession(code);
  if (!results) {
    const ws = await evalSocket();
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

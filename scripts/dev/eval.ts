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
 *       (and chat) for 8 hours and saves the grant (it renews itself while
 *       the approving device's page is connected, up to 30 days: docs/monitoring.md,
 *       "Renewal"; the file's until follows). Keep it running (in the
 *       background); the commands below then go through it. If its socket
 *       drops (the authorized page was away 5 min, a deploy, the network),
 *       the next command resumes with the grant, silently.
 *
 *   bun scripts/dev/eval.ts [--target <text>] [--no-pair] '<code>'   (or - for stdin)
 *       Run code on every open debug page (or those whose label — path + user
 *       agent — contains <text>) and print each page's result as JSON. With
 *       no `serve` session running it resumes the saved eval grant; only with
 *       none (or a refused one) does it pair, and waits for that one answer.
 *       The owner's box (box:eval, docs/box-oauth.md "Code on the owner's
 *       box") is a page like any other: its labels start with "box ", so
 *       `--target box` reaches only the box, `--target "box /words"` one page.
 *
 *   --no-pair  fail instead of asking the owner (for the chat agent).
 *
 *   bun scripts/dev/eval.ts chat [--label "…"] [--out <path>] [--exit-on-idle] [--ack] [--route chat|codex|agy]
 *       Listen to every chat thread: the owner's and each friend's (any
 *       signed-in user on a debug page). Pairs if there is no saved grant —
 *       prints {"type":"pending","code"} to stdout; the owner taps "Allow chat
 *       for 30 days" — then prints each new owner or friend message as one
 *       JSON line {"type":"chat","id","thread","email","from","text","at","label"}
 *       (plus "context":{"selection","path","title","host"} when the sender
 *       attached a page selection with the input's + menu; thread "owner" or the friend's user id; label = page path + user
 *       agent), and {"type":"friend-new","userId","email","at"} when someone
 *       writes for the first time, and {"type":"page-changed","thread",
 *       "email","label","at"} when a debug page navigates (silent on the
 *       page), {"type":"pages-idle","thread","at"} when every page of a
 *       thread has been closed for a minute and {"type":"pages-back",
 *       "thread","label","at"} when one opens again. It stays connected
 *       through idle (--exit-on-idle exits instead). Also appended to
 *       --out. Reconnects on close, backing off, by resuming the grant —
 *       also when a ping every 20 s goes unanswered (a socket that died
 *       with no close event, e.g. on a push Worker redeploy; ./keepalive.ts): it
 *       pairs at most once per run. With no grant left after that it prints
 *       {"type":"error"} and waits, without asking again, until restarted or
 *       a grant is saved by another run. A live line also carries "lagMs"
 *       (hub → this listener; two clocks) and, from the mic, "timing" (the
 *       page's VoiceTiming). --ack answers each new owner or friend line at
 *       once with one busy beat, so the page's spinner shows "heard you"
 *       before the agent's turn (docs/monitoring.md, "Voice latency").
 *
 *       It also prints {"type":"page-error","kind","message","stack","path",
 *       "status","label","rev","at"}: the owner's pages' console errors
 *       (docs/dev-debug-widget.md, "Page errors").
 *
 *   bun scripts/dev/eval.ts errors [--no-pair] [--out /tmp/lianki-page-errors.jsonl]
 *       The same listener (same grant, same reconnects), printing only the
 *       page-error lines: a dedicated error watcher. --no-pair: with no
 *       saved chat grant, say so and wait instead of asking the owner.
 *
 *   bun scripts/dev/eval.ts wake active|passive|ignored [--to <thread|email>]
 *       The mic's wake-word mode on those pages (docs/wake-word.md): passive
 *       waits for "Linky"; ignored = the last line was not for the agent.
 *       Each owner line carries "wake" (the mode it was sent in) while the mic is on.
 *
 *   bun scripts/dev/eval.ts clips
 *   bun scripts/dev/eval.ts clips on --device <text> [--minutes N] [--sink <url>]
 *   bun scripts/dev/eval.ts clips off [--device <text>]
 *       Voice-clip recording on the owner's window sessions (docs/dev-debug-widget.md,
 *       "Voice clips"). Alone: list them, {"type":"clips-list","sessions":[{sid,
 *       device,on,pages,until?,sink?,goneAt?,hidden?}]}. `on` starts it in every
 *       open window whose session id or device id starts with <text>, or one of
 *       whose page labels (path + user agent) contains it ("Android", "/words");
 *       it follows that window across URLs and origins, with a 录音中 badge and
 *       a Stop on the page. No auto-stop unless --minutes (1–1440). The sink
 *       defaults to this Mac's https://<tailnet>/lianki-widget, and is checked
 *       (with its read key) before turning on; its write key goes to the hub,
 *       which hands it only to that session's pages (clip-sink.ts sinkKeys).
 *       The session moves only between the owner's exact origins: lianki.com,
 *       LIANKI_DEV_ORIGINS and LIANKI_CLIPS_ORIGINS (the sink's own allowlist),
 *       or --origins a,b. `off` stops the matching ones (all without --device).
 *       Never deletes a clip.
 *
 *   bun scripts/dev/eval.ts inbox [list]
 *   bun scripts/dev/eval.ts inbox get <id> [--out <dir>]
 *   bun scripts/dev/eval.ts inbox done <id>
 *       The chat inbox (docs/dev-debug-widget.md, "Attachments and the inbox"):
 *       files the owner pasted, dropped or picked in the chat; each chat line
 *       that carried some has "attachments":[{id,name,type,size}]. `list`
 *       prints {"type":"inbox-list","items":[{id,name,type,size,sha256,at,
 *       processedAt?,line?}]}; `get` downloads one (a single-use 60 s ticket,
 *       through the hub) into a scratch dir ($TMPDIR/lianki-inbox/<id>/, or
 *       --out), checks its sha256 and prints {"type":"inbox-file","path",…};
 *       `done` marks it processed. With the saved grant; never pairs.
 *       Deleting needs the owner's own session (the chat's + → Inbox →
 *       Delete): `inbox rm` only says so.
 *
 *   bun scripts/dev/eval.ts say [--to <thread|email>] [--quiet] [--supersede|--interject] [--lane <lane>] [--voice <id>] "text"   (or - for stdin)
 *       Reply with the saved grant (the chat grant, else the eval grant:
 *       eval implies chat; never pairs), and exit: to the owner by default, or to
 *       a friend's thread by user id or email.
 *
 *       Quiet lines (docs/dev-debug-widget.md, "Quiet lines"): --quiet for
 *       FYI, progress and deploy notices (shown, never read aloud); plain
 *       say for an answer to what he just said (read aloud by the page's
 *       usual rules). A hidden page never speaks; it reads the newest line
 *       once it is visible again. --loud is deprecated: accepted and
 *       ignored (a plain say), so older commands still work.
 *
 *       Cutting in (docs/dev-debug-widget.md, "Supersede and interject"), on
 *       his page when the line arrives live; every line stays in the log:
 *       --supersede (打断) when this line makes the lane's earlier ones moot:
 *       the lane's line being read stops, its unread lines are dropped, this
 *       one is read. Other lanes are untouched.
 *       --interject (插嘴) when it is urgent but the earlier ones still
 *       matter: the line being read (any lane) pauses, this one is read
 *       next, then the paused one goes on; nothing is dropped.
 *
 *       Lanes (docs/dev-debug-widget.md, "Lanes and voices"): --lane main|codex|agy
 *       (default $LIANKI_LANE) gives the line that lane's avatar, name tag and
 *       voice; --voice main|calm|bright reads it in another voice. A line
 *       starting "【codex】" or "【agy】" gets its lane the same way.
 *
 *       A line's own voice (docs/dev-debug-widget.md, "A line's own voice"):
 *       --voice device:<name> (a voice the phone has, read with speech even
 *       when his output is cloud), melo:<lang>, aura:<speaker>, or
 *       eleven:<id> (an ElevenLabs public preview clip, its own words),
 *       google:<voice> or azure:<voice>[/<locale>] (a provider voice made on
 *       the server and played by the phone; flag voice.cloud-voices, paid
 *       from credits; without the provider's key the lane's voice reads it;
 *       docs/li-sound-hub.md, "Provider voices"). local:<name> is reserved. An unknown id is refused; a device voice
 *       the page lacks falls back to the lane's voice, never silence.
 *
 *   bun scripts/dev/eval.ts voices [--no-pair] [--target <text>] [--cloud]
 *       The ids --voice takes: each open debug page's device voices (read
 *       once from speechSynthesis over the eval channel; zh, ja, en first)
 *       and the cloud's list, as one JSON line {"type":"voices","pages":
 *       [{label,ok,device:[{id,name,lang,tier}]}],"cloud":[{id,lang,note}]}.
 *       --cloud: the cloud's list only, no page asked. Use --no-pair from an
 *       agent: each unpaired run would prompt the owner's devices.
 *
 *       A line spoken into the widget's mic carries "source":"stt"; when
 *       the agent polishes one, {"type":"edited","id","thread","text","raw",
 *       "edited"} follows.
 *
 *       With flag stt.merge on, an utterance that continues the last one amends it
 *       instead of adding a line: {"type":"edited",…,"parts":N,"merged":{id,text}},
 *       and `text` is the COMPLETE line, one you may already have been shown, so
 *       read it again before you act or reply. When the passage ends,
 *       {"type":"polish-due","id","text","raw","parts"} follows: polish then, from
 *       `raw`, not before (the hub refuses it). An undo is {"type":"edited",…,
 *       "split":[{id,text,at}…]}: the owner says those were separate lines.
 *       (docs/dev-debug-widget.md, "Continuous speech amends the last line".)
 *
 *   bun scripts/dev/eval.ts edit [<msgId>|--last] [--no-pair] "polished text"   (or - for stdin)
 *       Polish any of the owner's own lines in his thread: the hub keeps the
 *       first text as `raw`, marks the line edited, and updates it in place on
 *       every page (never read aloud again). Polish is unrestricted (owner,
 *       2026-11-14): substitute, add, drop, reorder or rewrite words, any
 *       number of times; friends' lines never. --last targets the owner's
 *       latest line. Uses the saved grant; never pairs.
 *       (docs/dev-debug-widget.md, "Agent edits".)
 *
 *   bun scripts/dev/eval.ts edit --summary (<msgId>… | --last N) [--no-pair] "summary"
 *       Collapse a run of the owner's consecutive voice lines that were not
 *       for you (room talk, someone else) into ONE short line saying what was
 *       said, e.g. "（旁人在聊租房，嫌贵）": one sentence, at most 40% of the raw
 *       length, never a bare "noise". Nothing is deleted: the lines stay kept
 *       and in his history, a tap shows them as heard. Keep what matters: he
 *       may have said something he wants heard; answer it warmly if so.
 *       (docs/dev-debug-widget.md, "Summaries".)
 *
 *   bun scripts/dev/eval.ts edit --merge <id1,id2,…> --text "passage" [--no-pair]   (--text - for stdin)
 *       Rewrite a RUN of the owner's consecutive voice lines as ONE fluent
 *       passage: his words joined, connectives and fragment fixes allowed,
 *       the meaning unchanged. A run ends at ANY other message (your reply,
 *       an ask card, anyone else's line) or at a change of topic; unsure about
 *       the topic: do not merge. The hub refuses lines with anything between
 *       them and typed lines; the passage itself has no length or word rule
 *       (polish is unrestricted, owner 2026-11-14). The lines stay kept (a tap shows them as heard) and the
 *       owner's ↩ restores them. Prints {"type":"edited",…,"passage":{ids}}.
 *       (docs/dev-debug-widget.md, "Merged passages".)
 *
 *   bun scripts/dev/eval.ts edit --unmerge <id> [--no-pair]
 *       Take back a merged passage (its first line's id): the lines read as
 *       they did before. Prints {"type":"edited",…,"restored":[{id,text}…]}.
 *
 *   bun scripts/dev/eval.ts withdraw [<askId|msgId>|--last] [--to <thread|email>] [--no-pair]
 *       Take back an ask card that is obsolete, so nobody has to tap it: the
 *       hub marks it withdrawn and every open page greys it out ("Withdrawn",
 *       no options, never read aloud); a later tap is refused. Only an
 *       agent's ask, only while open (not answered or expired), only in the
 *       thread it was sent to (the owner's, or --to the friend's). --last:
 *       the latest open ask in the owner's thread. Prints {"type":"withdrawn",…}.
 *       Uses the saved grant; never pairs.
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
import {
  LOUD_DEPRECATED,
  type NodeOpts,
  type SayLane,
  type SayVolume,
  chatLine,
  nodeOpts,
  sayLane,
  sayVolume,
} from "./node-args";
import { type ChatMessage, routeTo } from "@/lib/dev-eval";
import { askState } from "@lianki/debug-chat/ask";
import { isRouteLane, laneTakes } from "@/lib/lane-route";
import { VOICES_PROBE, voicesReport } from "./voices-list";
import { type BusyArgs, beatMessage, endsBeat, idleFor, parseBusyArgs } from "./busy";
import { ENDED, GRANT_INVALID, chatClose, chatStep, serveClose } from "./eval-grant";
import { DEAD, PONG, keepalive } from "./keepalive";
import { tailnetHost } from "./tailnet";
import { clipsOrigins, sinkKeys } from "./clip-sink";
import {
  BASE as INBOX_BASE,
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
/**
 * ask: `--q "question" --opt "a" --opt "b" [--multi] [--q …]`, in order: each
 * --q starts a question, the --opt after it are its options (the first one
 * recommended), --multi lets it take several. Taken out of args here.
 */
const askQuestions: {
  question: string;
  options: { label: string; recommended?: boolean }[];
  multi?: boolean;
}[] = [];
for (let i = 0; i < args.length; ) {
  const a = args[i];
  if (a === "--q" && args[i + 1] !== undefined) {
    askQuestions.push({ question: args[i + 1]!, options: [] });
    args.splice(i, 2);
  } else if (a === "--opt" && args[i + 1] !== undefined && askQuestions.length) {
    const q = askQuestions.at(-1)!;
    q.options.push({
      label: args[i + 1]!,
      ...(q.options.length === 0 ? { recommended: true } : {}),
    });
    args.splice(i, 2);
  } else if (a === "--multi" && askQuestions.length) {
    askQuestions.at(-1)!.multi = true;
    args.splice(i, 1);
  } else i++;
}
const noPair = boolFlag("--no-pair");
/** voices: the cloud's list only, no page asked. */
const cloudOnly = boolFlag("--cloud");
/** ask: wait for the tap and print the answer (or time out). */
const waitFlag = boolFlag("--wait");
/** edit: the owner's latest line, instead of an id (with --summary: his last N lines); withdraw: the latest open ask. */
const lastFlag = boolFlag("--last");
/** edit: collapse room-talk lines into one summary instead of polishing one. */
const summaryFlag = boolFlag("--summary");
/** edit: merge a run of his consecutive voice lines (comma-separated ids) into one passage. */
const mergeFlag = flag("--merge");
/** edit --merge: the passage's text (or - for stdin). */
const textFlag = flag("--text");
/** edit: undo a merged passage, by its first line's id. */
const unmergeFlag = flag("--unmerge");
/** chat: exit on {type:"pages-idle"} instead of staying for pages-back. */
const exitOnIdle = boolFlag("--exit-on-idle");
/** chat: answer each live owner/friend line at once with one busy beat ("heard you"). */
const ackFlag = boolFlag("--ack");
/**
 * chat: --route <lane> (chat | codex | agy) keeps only the owner lines that
 * lane answers (lib/lane-route.ts, docs/lane-listen.md): a line addressed
 * "codex, …" or "agy, …" is left to that lane's own listener, not printed,
 * not acked. Everything else (agent lines, friends, events) is unchanged.
 */
const routeFlag = flag("--route");
/** say: shown on his page, never read aloud (FYI, progress, deploy notices). */
const quietFlag = boolFlag("--quiet");
/** say: cut the same lane's earlier unread lines on his page and read this one now. */
const supersedeFlag = boolFlag("--supersede");
/** say: pause the line being read on his page, read this one, then go on. */
const interjectFlag = boolFlag("--interject");
/**
 * say: the lane saying it and the voice to read it in (packages/debug-chat/src/voices.ts).
 * --lane defaults to $LIANKI_LANE, so a lane's shell sets it once; --voice to the lane's.
 */
const laneFlag = flag("--lane") ?? (process.env.LIANKI_LANE || undefined);
const voiceFlag = flag("--voice");
/** say: deprecated, a no-op (a plain say); accepted so old commands still work. */
const loudFlag = boolFlag("--loud");
const labelFlag = flag("--label");
const label = labelFlag ?? `lianki main lane on ${hostname()}`;
const target = flag("--target");
const out = flag("--out");
const to = flag("--to");
const forEmail = flag("--for");
const fromFlag = flag("--from");
const hoursFlag = flag("--hours");
/** ask --wait: give up after this many seconds (default 600). */
const timeoutFlag = flag("--timeout");
const deviceFlag = flag("--device");
const minutesFlag = flag("--minutes");
const sinkFlag = flag("--sink");
const originsFlag = flag("--origins");
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
 * Reconnects (with backoff) when the socket closes, or when its keepalive
 * finds it dead without a close (./keepalive.ts). `errorsOnly` (`eval.ts errors`):
 * the same socket and grant, but only page-error lines (and pending/error)
 * are printed.
 */
function chat(out?: string, errorsOnly = false) {
  const seen = new Set<string>();
  const route = errorsOnly ? undefined : routeFlag;
  if (route !== undefined && !isRouteLane(route)) {
    console.error(`chat: --route takes chat, codex or agy (got ${route})`);
    process.exit(2);
  }
  /** Owner lines left to another lane (--route): their edits are not printed either. */
  const routedAway = new Set<string>();
  let first = true;
  let backoff = 1_000;
  let asked = false;
  const print = (v: Record<string, unknown>) => {
    if (errorsOnly && v.type !== "page-error" && v.type !== "error") return;
    const line = JSON.stringify(v);
    console.log(line);
    if (out) appendFileSync(out, `${line}\n`);
  };
  /** A line routed to this listener (the hub's `observed`, or worked out for history). */
  const emit = (
    m: Msg,
    observed = routeTo(where.node, m.to as string | undefined) === "observed",
    lagMs?: number,
  ): boolean => {
    if (typeof m.id !== "string" || seen.has(m.id)) return false;
    // --route: an owner line for another lane is that lane's, not this listener's.
    if (
      route &&
      m.from === "owner" &&
      !laneTakes(route, { from: m.from, thread: m.thread, text: m.text })
    ) {
      seen.add(m.id);
      routedAway.add(m.id);
      return false;
    }
    const line = chatLine(m, where, observed);
    if (!line) return false;
    seen.add(m.id);
    print(lagMs === undefined ? line : { ...line, lagMs });
    return true;
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
    // --no-pair: never ask the owner; with no grant, give up as if asked once.
    const step = chatStep({ token, paired: asked || noPair });
    if (step === "give-up") return giveUp();
    if (step === "pair") asked = true;
    const ws = openControl(token, undefined, "chat");
    /** This socket is done with (closed, or found dead): handled once. */
    let gone = false;
    // A socket can die with no close event (a redeploy of the push Worker,
    // the edge dropping the connection): a ping it cannot answer, or one that
    // never opens, counts as closed — dropped here and reconnected.
    const alive = keepalive(ws, (why) => {
      console.error(`socket dead (${why}); dropping it.`);
      try {
        ws.close(DEAD, why.slice(0, 100));
      } catch {}
      closed(DEAD);
    });
    ws.onerror = () => {
      // Bun follows an error with a close; if it does not, the keepalive does.
      console.error("socket error");
    };
    ws.onmessage = (e) => {
      alive.heard();
      if (e.data === PONG) return;
      let m: Msg;
      try {
        m = JSON.parse(String(e.data)) as Msg;
      } catch {
        return;
      }
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
      } else if (m.type === "chat" && m.message) {
        const msg = m.message as Msg;
        // Live: how long the hub → this listener leg took (the hub's clock vs this one's).
        const lagMs = Date.now() - Number(msg.at);
        const fresh = emit(msg, m.observed === true, Number.isFinite(lagMs) ? lagMs : undefined);
        // --ack: one beat at once, so the page shows the agent is on it before its turn.
        if (fresh && ackFlag && msg.from !== "agent" && m.observed !== true) {
          const thread = String(msg.thread ?? "owner");
          ws.send(beatMessage(thread === "owner" ? {} : { to: String(msg.email ?? thread) }));
        }
      } else if (m.type === "answered")
        // An ask card tapped on a page: stamped by the hub (source "tap").
        print({
          type: "answered",
          id: m.id,
          askId: m.askId,
          thread: m.thread ?? "owner",
          answer: m.answer,
          labels: m.labels,
        });
      else if (m.type === "edited") {
        // Another lane's line grew: still that lane's (--route), not printed here.
        if (routedAway.has(String(m.id))) return;
        // A line grew: the agent heard it, like any new line (--ack).
        if (m.merged && ackFlag && m.observed !== true) ws.send(beatMessage({}));
        print({
          type: "edited",
          id: m.id,
          thread: m.thread ?? "owner",
          text: m.text,
          raw: m.raw,
          edited: m.edited,
          // A summary of room talk: these lines are now one (raw: all of them as heard).
          ...(m.summary ? { summary: m.summary } : {}),
          // A merged passage: these lines are now one fluent passage (raw: all of them as heard).
          ...(m.passage ? { passage: m.passage } : {}),
          // A passage undone: the lines read as before.
          ...(Array.isArray(m.restored)
            ? { restored: m.restored.map((x: Msg) => ({ id: x.id, text: x.text, at: x.at })) }
            : {}),
          // Continuous speech (stt.merge): `text` is the whole line so far; read it again.
          ...(Array.isArray(m.parts) ? { parts: m.parts.length } : {}),
          ...(m.merged ? { merged: m.merged } : {}),
          // Undo: the line went back to these separate lines, as heard.
          ...(Array.isArray(m.split)
            ? { split: m.split.map((x: Msg) => ({ id: x.id, text: x.text, at: x.at })) }
            : {}),
          ...(m.observed === true ? { observed: true } : {}),
        });
      } else if (m.type === "polish-due")
        // A merged passage ended: polish `raw` once now (edit --last), or leave it.
        print({
          type: "polish-due",
          id: m.id,
          thread: m.thread ?? "owner",
          text: m.text,
          raw: m.raw,
          parts: m.parts,
          ...(m.observed === true ? { observed: true } : {}),
        });
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
      else if (m.type === "page-error")
        // An owner page's console error (docs/dev-debug-widget.md, "Page errors").
        print({
          type: "page-error",
          kind: m.kind,
          message: m.message,
          ...(m.stack ? { stack: m.stack } : {}),
          path: m.path,
          ...(m.status !== undefined ? { status: m.status } : {}),
          label: m.label,
          rev: m.rev ?? null,
          at: new Date(Number(m.at) || Number(m.hubAt)).toISOString(),
        });
      // An ask the agent withdrew (eval.ts withdraw): printed only; the hub decided it.
      else if (m.type === "withdrawn")
        print({
          type: "withdrawn",
          id: m.id,
          askId: m.askId,
          thread: m.thread ?? "owner",
          withdrawnAt: m.withdrawnAt,
        });
      else if (m.type === "error") console.error(`hub: ${logSafe(m.error)}`);
    };
    ws.onclose = (e) => closed(e.code);
    const closed = (code: number) => {
      if (gone) return;
      gone = true;
      alive.stop();
      ws.onmessage = ws.onclose = ws.onerror = null;
      const what = chatClose(code);
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
      console.error(`socket closed (${code}); resuming in ${backoff / 1000}s`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    };
  };
  connect();
}

/** Reply with the saved grant (to the owner, or `to` a friend); resolves once the hub has it. */
function say(text: string, to?: string, volume: SayVolume & SayLane = {}): Promise<Msg> {
  return sendOnce(
    {
      type: "say",
      text,
      ...(to ? { to } : {}),
      ...(where.node ? { taskPath: where.node } : {}),
      ...(where.agent ? { agentId: where.agent } : {}),
      ...volume,
    },
    "said",
  );
}

/**
 * Set the mic's wake-word mode on the owner's (or `to` a friend's) pages
 * (docs/wake-word.md): "passive" waits for "Linky", "active" hears
 * everything, "ignored" counts the last line as not for the agent.
 */
function wake(mode: string, to?: string): Promise<Msg> {
  return sendOnce({ type: "wake", mode, ...(to ? { to } : {}) }, "woke");
}

/** One controller message with the saved grant; resolves on the hub's `done` answer. */
function sendOnce(msg: Record<string, unknown>, done: string): Promise<Msg> {
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
      if (m.type === "approved") ws.send(JSON.stringify(msg));
      else if (m.type === done) {
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

/** `eval.ts inbox …`: list, fetch one into a scratch dir, mark one processed. */
async function inbox(op: string, id: string | undefined) {
  if (op === "rm") {
    console.error(
      "deleting an inbox file needs the owner's own session: the chat's + → Inbox → Delete (nothing was deleted)",
    );
    process.exit(2);
  }
  if (op === "list") {
    console.log(JSON.stringify(await sendOnce({ type: "inbox", op: "list" }, "inbox-list")));
    return;
  }
  if ((op !== "get" && op !== "done") || !id || !/^[0-9a-f]{20}$/.test(id)) {
    console.error(
      "usage: bun scripts/dev/eval.ts inbox [list | get <id> [--out <dir>] | done <id>]",
    );
    process.exit(2);
  }
  if (op === "done") {
    console.log(JSON.stringify(await sendOnce({ type: "inbox", op: "done", id }, "inbox-done")));
    return;
  }
  const t = (await sendOnce({ type: "inbox", op: "get", id }, "inbox-ticket")) as Msg & {
    ticket?: string;
    item?: { name?: string; type?: string; size?: number; sha256?: string };
  };
  if (!t.ticket) throw new Error("the hub gave no ticket");
  // The ticket rides in a header, never the URL (URLs are logged). Never printed.
  const r = await fetch(`${INBOX_BASE}/api/dev/inbox/${id}`, {
    headers: { "x-inbox-ticket": t.ticket },
  });
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const sha = new Bun.CryptoHasher("sha256").update(buf).digest("hex");
  const dir = out ?? join(process.env.TMPDIR ?? "/tmp", "lianki-inbox", id);
  mkdirSync(dir, { recursive: true });
  // The name is the user's text: only its last part, nothing that climbs out of the dir.
  const name = basename(String(t.item?.name ?? "file")).replace(/^\.+/, "_") || "file";
  const path = join(dir, name);
  writeFileSync(path, buf);
  console.log(
    JSON.stringify({
      type: "inbox-file",
      id,
      path,
      name,
      contentType: t.item?.type,
      size: buf.length,
      sha256: sha,
      verified: sha === t.item?.sha256,
    }),
  );
}

/**
 * Ask with a card (tappable options). Resolves with the hub's {type:"asked"};
 * with `wait`, keeps listening and resolves with {type:"answered"} for this
 * ask once it is tapped (event-driven), or rejects after `timeoutMs`. Never
 * pairs.
 */
function ask(
  questions: typeof askQuestions,
  to: string | undefined,
  wait: boolean,
  timeoutMs: number,
): Promise<Msg> {
  const grant = chatGrant();
  if (!grant)
    return Promise.reject(new Error(`no chat grant in ${TOKEN_FILE}: run \`eval.ts chat\` first`));
  return new Promise((resolve, reject) => {
    const ws = openControl(grant.token);
    let askId: string | undefined;
    const give = setTimeout(
      () => {
        ws.close();
        reject(
          new Error(
            askId ? `no tap within ${timeoutMs / 1000} s` : "no answer from the hub within 15 s",
          ),
        );
      },
      wait ? timeoutMs : 15_000,
    );
    const done = (fn: () => void) => {
      clearTimeout(give);
      ws.close();
      fn();
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "approved")
        ws.send(
          JSON.stringify({ type: "ask", questions, ...(to && to !== "owner" ? { to } : {}) }),
        );
      else if (m.type === "asked") {
        askId = String(m.askId);
        if (!wait) done(() => resolve(m));
        else console.error(`asked (${askId}); waiting for the tap…`);
      } else if (m.type === "answered" && askId && m.askId === askId) done(() => resolve(m));
      else if (m.type === "withdrawn" && askId && m.askId === askId)
        done(() => reject(new Error(`ask ${askId} was withdrawn`)));
      else if (m.type === "error") done(() => reject(new Error(String(m.reason ?? m.error))));
    };
    ws.onclose = (e) => {
      clearTimeout(give);
      if (e.code === GRANT_INVALID) rmSync(grant.file, { force: true });
      reject(new Error(`socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`));
    };
  });
}

/**
 * Polish the owner's latest voice line (`id`, or with `last` whatever the
 * owner said last, from the history the hub sends on resume). Resolves with
 * the hub's {type:"edited"}; rejects with the rule it broke. Never pairs.
 */
function edit(
  text: string,
  id: string | undefined,
  last: boolean,
  summary?: { ids?: string[]; last?: number },
  run?: { merge: string[] } | { unmerge: string },
): Promise<Msg> {
  const grant = chatGrant();
  if (!grant)
    return Promise.reject(new Error(`no chat grant in ${TOKEN_FILE}: run \`eval.ts chat\` first`));
  return new Promise((resolve, reject) => {
    const ws = openControl(grant.token);
    let target = id;
    const give = setTimeout(() => {
      ws.close();
      reject(new Error("no answer from the hub within 15 s"));
    }, 15_000);
    const done = (fn: () => void) => {
      clearTimeout(give);
      ws.close();
      fn();
    };
    const go = () =>
      ws.send(
        JSON.stringify(
          run
            ? "merge" in run
              ? { type: "merge", ids: run.merge, text }
              : { type: "unmerge", id: run.unmerge }
            : summary
              ? { type: "summary", ...summary, text }
              : { type: "edit", id: target, text },
        ),
      );
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      // A merge or its undo: the hub answers with the passage, or the restored lines.
      if (run) {
        if (m.type === "approved") go();
        else if (m.type === "edited" && ("merge" in run ? m.passage : m.restored))
          done(() => resolve(m));
        else if (m.type === "error") done(() => reject(new Error(String(m.reason ?? m.error))));
        return;
      }
      // A summary is the hub's to resolve (ids or his last N): its answer carries `summary`.
      if (summary) {
        if (m.type === "approved") go();
        else if (m.type === "edited" && m.summary) done(() => resolve(m));
        else if (m.type === "error") done(() => reject(new Error(String(m.reason ?? m.error))));
        return;
      }
      // An id: send at once. --last: wait for the history that follows the approval.
      if (m.type === "approved" && !last) go();
      else if (m.type === "history" && last && target === undefined) {
        const list = (Array.isArray(m.messages) ? m.messages : []) as Msg[];
        const owner = list.filter((x) => x.from === "owner" && (x.thread ?? "owner") === "owner");
        target = owner.at(-1)?.id as string | undefined;
        if (!target) return done(() => reject(new Error("the owner has no line to polish")));
        go();
      } else if (m.type === "edited" && m.id === target) done(() => resolve(m));
      else if (m.type === "error") done(() => reject(new Error(String(m.reason ?? m.error))));
    };
    ws.onclose = (e) => {
      clearTimeout(give);
      if (e.code === GRANT_INVALID) rmSync(grant.file, { force: true });
      reject(new Error(`socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`));
    };
  });
}

/**
 * Withdraw an open ask card (`id`: its askId or message id; with `last` the
 * latest open ask in the owner's thread, from the history the hub sends). Resolves
 * with the hub's {type:"withdrawn"}; rejects with the rule it broke. Never pairs.
 */
function withdraw(id: string | undefined, last: boolean, to?: string): Promise<Msg> {
  const grant = chatGrant();
  if (!grant)
    return Promise.reject(new Error(`no chat grant in ${TOKEN_FILE}: run \`eval.ts chat\` first`));
  return new Promise((resolve, reject) => {
    const ws = openControl(grant.token);
    let target = id;
    const give = setTimeout(() => {
      ws.close();
      reject(new Error("no answer from the hub within 15 s"));
    }, 15_000);
    const done = (fn: () => void) => {
      clearTimeout(give);
      ws.close();
      fn();
    };
    const go = () =>
      ws.send(
        JSON.stringify({ type: "withdraw", id: target, ...(to && to !== "owner" ? { to } : {}) }),
      );
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "approved" && !last) go();
      else if (m.type === "history" && last && target === undefined) {
        const list = (Array.isArray(m.messages) ? m.messages : []) as ChatMessage[];
        const now = Date.now();
        // The history a listener gets is the owner's thread.
        const open = list.filter(
          (x) =>
            x.from === "agent" &&
            x.ask &&
            (x.thread ?? "owner") === "owner" &&
            askState(x, now) === "open",
        );
        target = open.at(-1)?.ask?.askId;
        if (!target) return done(() => reject(new Error("no open ask to withdraw")));
        go();
      } else if (m.type === "withdrawn" && (m.askId === target || m.id === target))
        done(() => resolve(m));
      else if (m.type === "error") done(() => reject(new Error(String(m.reason ?? m.error))));
    };
    ws.onclose = (e) => {
      clearTimeout(give);
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
  if (args[0] === "errors") return chat(out, true);
  if (args[0] === "edit" && unmergeFlag !== undefined) {
    if (!unmergeFlag || args.length > 1) {
      console.error("usage: bun scripts/dev/eval.ts edit --unmerge <id> [--no-pair]");
      process.exit(2);
    }
    console.log(
      JSON.stringify(await edit("", undefined, false, undefined, { unmerge: unmergeFlag })),
    );
    return;
  }
  if (args[0] === "edit" && mergeFlag !== undefined) {
    const ids = (mergeFlag ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    // The text: --text, else one trailing argument; - reads stdin.
    const given = textFlag ?? (args.length === 2 ? args[1] : undefined);
    const text = (given === "-" ? await Bun.stdin.text() : (given ?? "")).trim();
    if (ids.length < 2 || !text || args.length > (textFlag === undefined ? 2 : 1)) {
      console.error(
        'usage: bun scripts/dev/eval.ts edit --merge <id1,id2,…> --text "passage" | - [--no-pair]',
      );
      process.exit(2);
    }
    console.log(JSON.stringify(await edit(text, undefined, false, undefined, { merge: ids })));
    return;
  }
  if (args[0] === "edit" && summaryFlag) {
    const rest = args.slice(1);
    const raw = rest.at(-1);
    const text = (raw === "-" ? await Bun.stdin.text() : (raw ?? "")).trim();
    const heads = rest.slice(0, -1);
    const n = lastFlag ? Number(heads[0]) : NaN;
    const ok = lastFlag ? heads.length === 1 && Number.isInteger(n) && n >= 1 : heads.length >= 1;
    if (!text || !ok) {
      console.error(
        'usage: bun scripts/dev/eval.ts edit --summary (<msgId>… | --last N) [--no-pair] "summary" | -',
      );
      process.exit(2);
    }
    const which = lastFlag ? { last: n } : { ids: heads };
    console.log(JSON.stringify(await edit(text, undefined, false, which)));
    return;
  }
  if (args[0] === "edit") {
    const rest = args.slice(1);
    const id = lastFlag ? undefined : rest.length > 1 ? rest[0] : undefined;
    const raw = rest.at(-1);
    const text = (raw === "-" ? await Bun.stdin.text() : (raw ?? "")).trim();
    if (!text || (!lastFlag && !id) || rest.length > (lastFlag ? 1 : 2)) {
      console.error(
        'usage: bun scripts/dev/eval.ts edit [<msgId>|--last] [--no-pair] "polished text" | -',
      );
      process.exit(2);
    }
    console.log(JSON.stringify(await edit(text, id, lastFlag)));
    return;
  }
  if (args[0] === "withdraw") {
    const rest = args.slice(1);
    if ((lastFlag ? rest.length !== 0 : rest.length !== 1) || (lastFlag && to && to !== "owner")) {
      console.error(
        "usage: bun scripts/dev/eval.ts withdraw <askId|msgId> [--to <thread|email>] | --last [--no-pair]",
      );
      process.exit(2);
    }
    console.log(JSON.stringify(await withdraw(rest[0], lastFlag, to)));
    return;
  }
  if (args[0] === "ask") {
    if (!askQuestions.length || askQuestions.some((q) => !q.options.length)) {
      console.error(
        'usage: bun scripts/dev/eval.ts ask [--to owner|<email>] --q "question" --opt "a" --opt "b" [--multi] [--q …] [--wait] [--timeout <s>]',
      );
      process.exit(2);
    }
    const secs = Number(timeoutFlag ?? 600);
    console.log(
      JSON.stringify(await ask(askQuestions, to, waitFlag, (secs > 0 ? secs : 600) * 1000)),
    );
    return;
  }
  if (args[0] === "clips") {
    const op = args[1] ?? "list";
    if (op !== "list" && op !== "on" && op !== "off") {
      console.error(
        "usage: bun scripts/dev/eval.ts clips [on --device <text> [--minutes N] [--sink <url>] | off [--device <text>]]",
      );
      process.exit(2);
    }
    const minutes = minutesFlag === undefined ? undefined : Number(minutesFlag);
    let sink = sinkFlag;
    if (op === "on") {
      if (!deviceFlag) {
        console.error("clips on needs --device <text> (see `eval.ts clips` for the sessions)");
        process.exit(2);
      }
      sink ??= `https://${tailnetHost()}/lianki-widget`;
      // A sink that does not answer would only look like recording: check it first.
      const ok = await fetch(`${sink.replace(/\/+$/, "")}/clips/index.json`, {
        headers: { authorization: `Bearer ${sinkKeys().read}` },
        signal: AbortSignal.timeout(5_000),
      }).then(
        (r) => r.ok,
        () => false,
      );
      if (!ok) {
        console.error(
          `the sink ${sink} does not answer /clips/index.json: start debug-widget-server.ts`,
        );
        process.exit(1);
      }
    }
    const msg = {
      type: "clips",
      op,
      ...(deviceFlag ? { match: deviceFlag } : {}),
      ...(minutes !== undefined ? { minutes } : {}),
      ...(op === "on" && sink
        ? {
            sink,
            sinkKey: sinkKeys().write,
            origins: originsFlag ? originsFlag.split(",").map((o) => o.trim()) : clipsOrigins(),
          }
        : {}),
    };
    console.log(JSON.stringify(await sendOnce(msg, op === "list" ? "clips-list" : "clips-done")));
    return;
  }
  if (args[0] === "inbox") return inbox(args[1] ?? "list", args[2]);
  if (args[0] === "wake") {
    const mode = args[1];
    if (mode !== "active" && mode !== "passive" && mode !== "ignored") {
      console.error(
        "usage: bun scripts/dev/eval.ts wake active|passive|ignored [--to <thread|email>]",
      );
      process.exit(2);
    }
    console.log(JSON.stringify(await wake(mode, to)));
    return;
  }
  if (args[0] === "say") {
    const text = (args[1] === "-" ? await Bun.stdin.text() : (args[1] ?? "")).trim();
    const volume = sayVolume({
      quiet: quietFlag,
      supersede: supersedeFlag,
      interject: interjectFlag,
    });
    if ("error" in volume) {
      console.error(volume.error);
      process.exit(2);
    }
    if (loudFlag) console.error(LOUD_DEPRECATED);
    if (!text) {
      console.error(
        'usage: bun scripts/dev/eval.ts say [--to <thread|email>] [--quiet] [--supersede|--interject] [--lane main|codex|agy] [--voice main|calm|bright|device:<name>|melo:<lang>|aura:<speaker>|eleven:<id>|google:<voice>|azure:<voice>[/<locale>]] "text" | -   (ids: eval.ts voices)',
      );
      process.exit(2);
    }
    const lane = sayLane(laneFlag, voiceFlag);
    if ("error" in lane) {
      console.error(lane.error);
      process.exit(2);
    }
    console.log(JSON.stringify(await say(text, to, { ...volume, ...lane })));
    return;
  }
  if (args[0] === "voices") {
    // Read once from the pages (never a loop); --cloud asks no page at all.
    let results: Msg[] | null = null;
    if (!cloudOnly) {
      results = await viaSession(VOICES_PROBE);
      if (!results) {
        const ws = await evalSocket();
        results = await run(ws, VOICES_PROBE, target);
        ws.close();
      }
    }
    console.log(JSON.stringify(voicesReport(results)));
    return;
  }
  const code = args[0] === "-" ? await Bun.stdin.text() : args[0];
  if (!code?.trim()) {
    console.error(
      "usage: bun scripts/dev/eval.ts [--for <email>] [--target <text>] [--no-pair] '<code>' | - | serve [--for <email>] [--no-pair] | chat [--out <file>] [--exit-on-idle] | errors [--no-pair] [--out <file>] | say [--to <thread|email>] [--quiet] <text>",
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

/** A value for the terminal log: control characters (newlines, escapes) become spaces. */
function logSafe(v: unknown): string {
  return String(v)
    .replace(/\n|\r/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

main().catch((e) => {
  console.error(logSafe((e as Error).message));
  process.exit(1);
});

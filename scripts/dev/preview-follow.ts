#!/usr/bin/env bun
/**
 * preview-follow: keeps the preview branch (tree/preview, `preview/live2`)
 * caught up with main, and the preview server with it
 * (docs/dev-whole-page.md, "Following main").
 *
 *   bun scripts/dev/preview-follow.ts                  # the watcher (under oxmgr)
 *   bun scripts/dev/preview-follow.ts once             # one catch-up now, then exit
 *   bun scripts/dev/preview-follow.ts --cwd ~/ws/snolab/lianki/tree/preview --branch preview/live2 --port 3100
 *
 * Events, no polling. Two sources, each only a hint (every run asks git):
 *   1. Git itself: .husky/reference-transaction POSTs /kick to this
 *      watcher's unix socket when any worktree's fetch moves
 *      refs/remotes/origin/main.
 *   2. lianki-push's /api/version/ws (the auto-update socket): a new build
 *      serving on lianki.com means main moved on GitHub (merged PRs) even
 *      when nobody fetched here. Public, read-only, no secret.
 *
 * Each run: fetch origin main, merge into the branch; on conflicts a headless
 * Claude resolves the markers, then the checks in followOnce
 * (./preview-follow-lib.ts) decide: commit + publish, or `git merge --abort`
 * and one 【小可】 line in the owner's chat naming the files. Never force,
 * never reset --hard, never another branch. One run at a time (queue + lock
 * file). Log: ~/.cache/lianki/preview-follow.log, one JSON line per event.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FollowQueue,
  type Ran,
  type Runner,
  followOnce,
  parseKick,
  parseVersionMessage,
  resolverPrompt,
} from "./preview-follow-lib";

const REPO = join(import.meta.dir, "..", "..");
const STATE = join(homedir(), ".cache", "lianki");
const SOCKET = process.env.LIANKI_PREVIEW_FOLLOW_SOCK || join(STATE, "preview-follow.sock");
const LOG = join(STATE, "preview-follow.log");
const LOCK = join(STATE, "preview-follow.lock");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const cwd = arg("cwd", join(homedir(), "ws", "snolab", "lianki", "tree", "preview"));
const branch = arg("branch", "preview/live2");
const port = arg("port", "3100");
const hub = arg("hub", "wss://lianki.com/api/version/ws");
const resolverTimeoutMs = Number(arg("resolver-timeout-min", "20")) * 60_000;

function log(event: Record<string, unknown>) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  console.error(`[preview-follow] ${line}`);
  try {
    appendFileSync(LOG, `${line}\n`);
  } catch {}
}

function exec(cmd: string[], dir: string, timeoutMs = 5 * 60_000): Promise<Ran> {
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (b) => (stdout += b));
    p.stderr.on("data", (b) => (stderr += b));
    const t = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: 127, stdout, stderr: String(e) });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

const run: Runner = (cmd, opts) => exec(cmd, cwd, opts?.timeoutMs);

/** Lock across processes (the watcher and a manual `once`). A dead holder's lock is taken over. */
function takeLock(): boolean {
  mkdirSync(STATE, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(LOCK, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      const pid = Number(readFileSync(LOCK, "utf8").trim());
      let alive = false;
      try {
        alive = pid > 0 && process.kill(pid, 0);
      } catch {}
      if (alive) return false;
      try {
        unlinkSync(LOCK);
      } catch {}
    }
  }
  return false;
}
const dropLock = () => {
  try {
    if (readFileSync(LOCK, "utf8").trim() === String(process.pid)) unlinkSync(LOCK);
  } catch {}
};

const toldFor = new Set<string>();
async function runOnce(): Promise<void> {
  if (!takeLock()) return log({ outcome: "skipped", reason: "another run holds the lock" });
  try {
    const outcome = await followOnce({
      run,
      branch,
      log,
      resolve: async (files, target) => {
        log({ step: "resolver start", files, target });
        const r = await exec(
          [
            "claude",
            "-p",
            resolverPrompt(files, target, branch),
            "--permission-mode",
            "acceptEdits",
            "--allowedTools",
            "Read,Edit,Write,Grep,Glob,Bash(bun run typecheck),Bash(git diff:*),Bash(git status:*),Bash(git log:*),Bash(git show:*)",
          ],
          cwd,
          resolverTimeoutMs,
        );
        log({ step: "resolver done", code: r.code, tail: r.stdout.trim().slice(-400) });
        return r.code === 0;
      },
      publish: async () => {
        const p = await exec(
          ["bun", join(REPO, "scripts/dev/whole-page.ts"), "publish", "--port", port],
          cwd,
          30_000,
        );
        log({
          step: "publish",
          ok: p.code === 0,
          err: p.code ? p.stderr.trim().slice(-200) : undefined,
        });
      },
      say: async (line) => {
        // Once per main commit: a retry of the same failure stays in the log.
        const key = /（([0-9a-f]{7})）/.exec(line)?.[1] ?? line;
        if (toldFor.has(key)) return log({ step: "say skipped (already told)", line });
        toldFor.add(key);
        const s = await exec(
          ["bun", join(REPO, "scripts/dev/lianki-dev.ts"), "say", line],
          REPO,
          60_000,
        );
        log({ step: "say", ok: s.code === 0 });
      },
    });
    log({ outcome: outcome.kind, ...outcome });
  } catch (e) {
    log({ outcome: "error", reason: String(e) });
  } finally {
    dropLock();
  }
}

if (process.argv[2] === "once") {
  await runOnce();
  process.exit(0);
}

const queue = new FollowQueue(runOnce);

// husky 9 writes wrappers in core.hooksPath (.husky/_) only for its fixed
// list of hooks, and reference-transaction is not on it: add the same
// one-line wrapper there (a gitignored, generated folder), so
// .husky/reference-transaction runs in every worktree sharing that config.
{
  const hp = (await run(["git", "config", "--get", "core.hooksPath"])).stdout.trim();
  const top = (await run(["git", "rev-parse", "--show-toplevel"])).stdout.trim();
  const dir = hp.startsWith("/") ? hp : join(top, hp);
  const wrapper = join(dir, "reference-transaction");
  if (!hp || !existsSync(join(dir, "h")))
    log({ warn: `no husky hooks at ${dir || "(unset)"}: git kicks off` });
  else {
    if (!existsSync(wrapper))
      writeFileSync(wrapper, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"', { mode: 0o755 });
    if (!existsSync(join(dir, "..", "reference-transaction")))
      log({
        warn: `${join(dir, "..", "reference-transaction")} missing (that checkout predates it): git kicks off until it has it`,
      });
  }
}

// 1. Git's own event: the reference-transaction hook, over a unix socket (owner-only file).
mkdirSync(STATE, { recursive: true });
if (existsSync(SOCKET)) {
  const alive = await fetch("http://follow/ping", { unix: SOCKET } as RequestInit).then(
    () => true,
    () => false,
  );
  if (alive) {
    console.error(`[preview-follow] another watcher holds ${SOCKET}`);
    process.exit(1);
  }
  unlinkSync(SOCKET);
}
Bun.serve({
  unix: SOCKET,
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/kick") {
      log({ event: "git", ...parseKick(req.url) });
      queue.kick();
      return new Response(null, { status: 202 });
    }
    return new Response(url.pathname === "/ping" ? "ok" : null, {
      status: url.pathname === "/ping" ? 200 : 404,
    });
  },
});

// 2. lianki.com's build announcements. Reconnect on close with backoff (an event, not a timer probe).
let lastBuild: string | null = null;
let backoff = 1000;
function connect() {
  const ws = new WebSocket(hub);
  ws.onopen = () => {
    backoff = 1000;
    log({ event: "hub connected" });
  };
  ws.onmessage = (m) => {
    const build = parseVersionMessage(m.data);
    if (!build || build === lastBuild) return;
    log({ event: "build", build, previous: lastBuild });
    lastBuild = build;
    queue.kick(); // the first one too: catches up after the watcher was down
  };
  ws.onclose = () => {
    log({ event: "hub closed", retryMs: backoff });
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 5 * 60_000);
  };
}
connect();

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    try {
      unlinkSync(SOCKET);
    } catch {}
    dropLock();
    process.exit(0);
  });
log({ event: "watching", cwd, branch, socket: SOCKET, hub });

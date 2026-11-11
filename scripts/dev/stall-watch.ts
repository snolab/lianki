#!/usr/bin/env bun
/**
 * stall-watch: tells the coordinating lane when an agent lane sits on a
 * permission / confirmation prompt (docs/lane-listen.md, "Stall watch").
 * A lane stuck on Claude Code's "Do you want to…", a Codex approval or a
 * sudo prompt cannot report it itself; this watcher reads what ay already
 * exposes and writes a blocked node to the progress hub:
 *
 *   /infra/agent-stall-watch/<lane>-<pid>  --status blocked --who main --needs "<lane> waits on a prompt: <line>"
 *
 * The hub then nudges main (the owner when main itself is stuck) with its own
 * backoff. When the screen moves on, the node is closed (--done --verified).
 *
 *   bun scripts/dev/stall-watch.ts                     # watch ~/ws/snolab/lianki agents
 *   bun scripts/dev/stall-watch.ts --dry-run           # log what it would report, write nothing
 *   bun scripts/dev/stall-watch.ts --root <dir> --coordinator main --quiet-min 15
 *
 * Events, not polling: one `ay ls --watch` stream (ay's own diff of its agent
 * registry; no network) says when an agent stops printing or ay sees a
 * prompt. Only then is its tail read (`ay tail -n 40 <pid>`), and once more
 * when the timer for that edge fires. It never answers a prompt, never sends
 * keys or messages to an agent, and redacts anything token-like before a line
 * leaves the Mac. Pure parts: ./stall-watch-lib.ts (unit-tested).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Action,
  StallTracker,
  type StallConfig,
  parseAyLine,
  redact,
  stallConfig,
  staleNodes,
} from "./stall-watch-lib";

type Opts = {
  root: string;
  repo: string;
  coordinator: string;
  dryRun: boolean;
  cfg: StallConfig;
};

function parse(argv: string[]): Opts | Error {
  const cfg = stallConfig();
  const o: Opts = {
    root: join(homedir(), "ws", "snolab", "lianki"),
    repo: join(import.meta.dir, "..", ".."),
    coordinator: process.env.LIANKI_STALL_COORDINATOR || "main",
    dryRun: false,
    cfg,
  };
  const num = (v: string | undefined, flag: string) => {
    const n = Number(v);
    if (!(n > 0)) throw new Error(`stall-watch: ${flag} needs a positive number`);
    return n;
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      const v = () => argv[++i];
      if (a === "--root") o.root = v()!;
      else if (a === "--repo") o.repo = v()!;
      else if (a === "--coordinator") o.coordinator = v()!;
      else if (a === "--dry-run") o.dryRun = true;
      else if (a === "--quiet-min") cfg["stallWatch.quietMin"] = num(v(), a);
      else if (a === "--grace-sec") cfg["stallWatch.promptGraceSec"] = num(v(), a);
      else if (a === "--interval") cfg["stallWatch.ayIntervalSec"] = num(v(), a);
      else return new Error(`stall-watch: unknown argument ${a}`);
    }
  } catch (e) {
    return e as Error;
  }
  return o;
}

const log = (v: Record<string, unknown>) =>
  console.log(JSON.stringify({ ...v, at: new Date().toISOString() }));

async function run(cmd: string[], cwd: string, timeoutMs = 20_000) {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out, err, code };
}

/** The agent's last lines, as ay shows them (stdout only: ay's hints go to stderr). */
async function readTail(pid: number, lines: number): Promise<string | null> {
  const r = await run(["ay", "tail", "-n", String(lines), String(pid)], homedir(), 15_000);
  return r.code === 0 ? r.out : null;
}

async function progress(o: Opts, args: string[]): Promise<boolean> {
  const cmd = [
    process.execPath,
    join(o.repo, "scripts", "dev", "progress.ts"),
    "--agent",
    "stall-watch",
    ...args,
  ];
  if (o.dryRun) {
    log({ type: "dry-run", progress: args });
    return true;
  }
  const r = await run(cmd, o.repo);
  if (r.code !== 0)
    log({
      type: "progress-failed",
      exit: r.code,
      err: redact(r.err.trim().split("\n").at(-1) ?? ""),
    });
  return r.code === 0;
}

async function main(): Promise<number> {
  const o = parse(process.argv.slice(2));
  if (o instanceof Error) {
    console.error(o.message);
    return 1;
  }
  const tracker = new StallTracker(o.cfg, o.coordinator);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const tasks = new Map<number, string>(); // pid → task title of its reported node
  // Everything for one agent (events, tail reads, timers) runs in order; agents run concurrently.
  const chains = new Map<number, Promise<void>>();
  const enqueue = (pid: number, f: () => Promise<void>) =>
    chains.set(
      pid,
      (chains.get(pid) ?? Promise.resolve())
        .then(f)
        .catch((e) => log({ type: "error", pid, err: redact(String(e)) })),
    );

  const act = async (actions: Action[]): Promise<void> => {
    for (const a of actions) {
      if (a.do === "cancel") {
        clearTimeout(timers.get(a.pid));
        timers.delete(a.pid);
      } else if (a.do === "timer") {
        clearTimeout(timers.get(a.pid));
        timers.set(
          a.pid,
          setTimeout(() => {
            timers.delete(a.pid);
            enqueue(a.pid, () => act(tracker.onTimer(a.pid, a.why)));
          }, a.ms),
        );
      } else if (a.do === "read") {
        const tail = await readTail(a.pid, o.cfg["stallWatch.tailLines"]);
        if (tail === null) continue;
        const next = tracker.onTail(a.pid, a.why, tail);
        if (next.length)
          log({
            type: "seen",
            pid: a.pid,
            after: a.why,
            next: next.map((n) => ("why" in n ? `${n.do}:${n.why}` : n.do)),
          });
        await act(next);
      } else if (a.do === "report") {
        const r = a.report;
        tasks.set(a.pid, r.task);
        log({
          type: "stall",
          pid: a.pid,
          path: r.path,
          who: r.who,
          needs: r.needs,
          pattern: "pattern" in a.verdict ? a.verdict.pattern : "question",
        });
        await progress(o, [
          "--path",
          r.path,
          "--task",
          r.task,
          "--status",
          "blocked",
          "--who",
          r.who,
          "--needs",
          r.needs,
        ]);
      } else if (a.do === "clear") {
        const task = tasks.get(a.pid);
        tasks.delete(a.pid);
        log({ type: "cleared", pid: a.pid, path: a.path, why: a.why });
        if (task)
          await progress(o, [
            "--path",
            a.path,
            "--task",
            task,
            "--done",
            "--verified",
            `${a.why} (stall-watch saw it, ${new Date().toISOString()})`,
          ]);
      }
    }
  };

  // Nodes an earlier run left open: close them; a lane still stuck is reported again after its grace.
  if (!o.dryRun) {
    const r = await run(
      [process.execPath, join(o.repo, "scripts", "dev", "progress.ts"), "show", "--json"],
      o.repo,
    );
    let show: unknown = null;
    try {
      show = JSON.parse(r.out);
    } catch {}
    for (const n of staleNodes(show)) {
      log({ type: "cleared", path: n.id, why: "left open by an earlier run" });
      await progress(o, [
        "--path",
        n.id,
        "--task",
        n.task,
        "--done",
        "--verified",
        "stall-watch restarted; re-checking from a fresh screen",
      ]);
    }
  }

  let child: ReturnType<typeof Bun.spawn> | undefined;
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      child?.kill(sig);
      process.exit(0);
    });

  let backoff = 1_000;
  for (;;) {
    child = Bun.spawn(
      [
        "ay",
        "ls",
        "--watch",
        "--local",
        "--cwd",
        o.root,
        "--interval",
        String(o.cfg["stallWatch.ayIntervalSec"]),
      ],
      { cwd: homedir(), stdout: "pipe", stderr: "ignore" },
    );
    log({
      type: "watching",
      root: o.root,
      coordinator: o.coordinator,
      dryRun: o.dryRun,
      cfg: o.cfg,
    });
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const ev = parseAyLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (!ev) continue;
        backoff = 1_000;
        log({ type: "state", pid: ev.pid, cli: ev.cli, cwd: ev.cwd, state: ev.state });
        enqueue(ev.pid, () => act(tracker.onEvent(ev)));
      }
    }
    const code = await child.exited;
    log({ type: "ay-exited", exit: code, restartInMs: backoff });
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
}

if (import.meta.main) main().then((c) => process.exit(c));

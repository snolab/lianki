#!/usr/bin/env bun
/**
 * `lianki-dev lane-listen --as codex|agy`: a lane's own chat listener
 * (docs/lane-listen.md). It listens to the owner's thread with the lane's own
 * token (`lianki-dev listen` → `lianki chat listen`), keeps the owner lines
 * addressed to this lane (lib/lane-route.ts, the one matcher every listener
 * uses) and hands each one to the lane's agent with `ay send`. The lane
 * answers itself, with its token: `lianki-dev say --as <lane> "…"`, a 【lane】
 * line with its own name, mark and voice.
 *
 *   lianki-dev lane-listen --as codex --cwd ~/ws/snolab/lianki/tree/codex
 *   lianki-dev lane-listen --as agy --deliver 12549 --tests
 *   lianki-dev lane-listen --as codex --dry-run       # print what it would hand over
 *   lianki-dev lane-listen --as claude --cwd … --everyone --skip-owner
 *
 * --everyone (tier ①, docs/lane-listen.md "Five tiers"): agents' lines and system
 * lines are handed over too, marked 【agent · coco】 / 【系统】 (FYI, never answered),
 * never the lane's own; the hub shows it as hearing all messages. --skip-owner: not
 * his lines (小克 has its own feed of them).
 *
 * The token: LIANKI_TOKEN, else ~/.config/lianki/lanes/<lane>.token (0600),
 * made by the owner (lianki.com/my/preferences → API tokens; name = the lane,
 * chat:read chat:write chat:ask, an expiry). Never printed; a lane never
 * makes one. Without it, exit 2 and say which token is needed.
 *
 * The pure parts are in ./lane-listen-lib.ts (unit-tested); this file only
 * spawns the listener and `ay send`.
 */
import { join } from "node:path";
import { type RouteLane, isRouteLane } from "../../lib/lane-route";
import { setLaneTable } from "../../packages/debug-chat/src/voices";
import {
  BUSY_RECHECK_MS,
  listenerTakes,
  routeKey,
  laneToken,
  lineOf,
  makeDeliverer,
  parseDebounceMs,
  parseInterruptAfterMs,
  queuedOnScreen,
  reconnectWait,
  tokenNeeded,
  voiceAllowed,
  type AyRow,
  pickTarget,
} from "./lane-listen-lib";

type Opts = {
  lane: RouteLane;
  repo: string;
  deliver?: string;
  cwd?: string;
  /** The lane's agent CLI kind (`ay ls` cli: agy, codex, claude); picks among several agents in `cwd`. */
  cli?: string;
  tests: boolean;
  dryRun: boolean;
  /** Every owner line, not only the ones addressed to this lane. */
  all: boolean;
  /** Agents' and system lines too (tier ①). */
  everyone: boolean;
  /** No owner lines (the lane has its own feed of them). */
  skipOwner: boolean;
  /** Debounce window (ms) for non-urgent lines; urgent lines bypass it immediately. */
  debounceMs: number;
  /** An urgent line still held back this long after delivery gets an Esc (0 = never). */
  interruptAfterMs: number;
};

function parse(argv: string[]): Opts | Error {
  const envDebounce = parseDebounceMs(process.env.LIANKI_LISTEN_DEBOUNCE_MS);
  if (envDebounce instanceof Error) return envDebounce;
  const envInterrupt = parseInterruptAfterMs(process.env.LIANKI_LISTEN_INTERRUPT_AFTER_MS);
  if (envInterrupt instanceof Error) return envInterrupt;
  const o: Partial<Opts> & {
    tests: boolean;
    dryRun: boolean;
    all: boolean;
    everyone: boolean;
    skipOwner: boolean;
    debounceMs: number;
    interruptAfterMs: number;
  } = {
    tests: false,
    dryRun: false,
    all: false,
    everyone: false,
    skipOwner: false,
    debounceMs: envDebounce,
    interruptAfterMs: envInterrupt,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = () => argv[++i];
    if (a === "--lane" || a === "--as") o.lane = v() as RouteLane;
    else if (a === "--repo") o.repo = v();
    else if (a === "--deliver") o.deliver = v();
    else if (a === "--cwd") o.cwd = v();
    else if (a === "--cli") o.cli = v();
    else if (a === "--tests") o.tests = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--all") o.all = true;
    else if (a === "--everyone") o.everyone = o.all = true;
    else if (a === "--skip-owner") o.skipOwner = true;
    else if (a === "--debounce-ms" || a === "--batch-ms") {
      const raw = v();
      if (raw === undefined) return new Error(`lane-listen: ${a} requires a millisecond value`);
      const ms = parseDebounceMs(raw);
      if (ms instanceof Error) return ms;
      o.debounceMs = ms;
    } else if (a === "--interrupt-after-ms") {
      const ms = parseInterruptAfterMs(v() ?? "x");
      if (ms instanceof Error) return ms;
      o.interruptAfterMs = ms;
    } else return new Error(`lane-listen: unknown argument ${a}`);
  }
  o.lane ??= (process.env.LIANKI_LANE || undefined) as RouteLane | undefined;
  // The joined lanes (the lanes manager hands them over, docs/lane-listen.md "Every agent
  // joins"): a lane beyond codex and agy listens under its own name, and the router knows it.
  if (process.env.LIANKI_LANE_TABLE)
    try {
      setLaneTable(JSON.parse(process.env.LIANKI_LANE_TABLE));
    } catch {}
  // 小克's token "claude" listens too (as the route "chat"); "chat" itself is eval.ts's.
  if (!o.lane || o.lane === "chat" || !isRouteLane(routeKey(o.lane)))
    return new Error(
      "lane-listen: --as codex | agy | a lane in LIANKI_LANE_TABLE (the chat lane listens with `eval.ts chat --route chat`)",
    );
  if (!o.repo) return new Error("lane-listen: --repo <checkout> missing");
  if (!o.dryRun && !o.deliver && !o.cwd)
    return new Error(
      "lane-listen: --deliver <ay keyword|pid> or --cwd <the lane's dir> (or --dry-run)",
    );
  return o as Opts;
}

const log = (v: Record<string, unknown>) =>
  console.log(JSON.stringify({ ...v, at: new Date().toISOString() }));

async function deliver(o: Opts, body: string, interrupt = false): Promise<number> {
  if (o.dryRun) {
    console.log(body);
    return 0;
  }
  // `ay send . …` from the lane's dir finds the lane however often it restarted.
  // --no-wait: hand the text over and return; ay's own settle/idle waits used
  // to hold this loop for minutes, and every later line with it (2026-11-14).
  // --code alt-m for an urgent line (his name, a roll call) asks to submit now,
  // but it does not interrupt: codex mid-turn still holds the message "after
  // next tool call" (159 s on 2026-11-25). The break-in is releaseHeld, after
  // --interrupt-after-ms.
  // The pid is looked up first (pickTarget): `.` alone is refused by ay when the
  // dir holds more than one agent, and the line is lost (杰咪, 2026-11-15).
  const target = o.deliver ?? (await resolveTarget(o)) ?? ".";
  lastTarget = target;
  const p = Bun.spawn(
    ["ay", "send", target, "--force", "--no-wait", "--code", interrupt ? "alt-m" : "enter", "-"],
    {
      cwd: o.cwd ?? process.cwd(),
      stdin: new TextEncoder().encode(body),
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const code = await Promise.race([
    p.exited,
    new Promise<number>((r) => setTimeout(() => r(-1), SEND_WAIT_MS)),
  ]);
  if (code === -1) {
    console.error(`lane-listen: ay send still running after ${SEND_WAIT_MS} ms; not waiting`);
    return 4;
  }
  if (code !== 0 && code !== 4)
    console.error(
      `lane-listen: ay send exited ${code}: ${(await new Response(p.stderr).text()).trim().split("\n").at(-1)}`,
    );
  return code;
}

/** The agent the last line went to: the interrupt check looks at the same one. */
let lastTarget = ".";

/** Run `ay` with a deadline; its stdout, or null when it was slow or failed. */
async function ayOut(o: Opts, args: string[], waitMs: number): Promise<string | null> {
  try {
    const p = Bun.spawn(["ay", ...args], {
      cwd: o.cwd ?? process.cwd(),
      stdout: "pipe",
      stderr: "ignore",
    });
    const txt = await Promise.race([
      new Response(p.stdout).text(),
      new Promise<null>((r) => setTimeout(() => r(null), waitMs)),
    ]);
    if (txt === null) p.kill();
    return txt;
  } catch {
    return null;
  }
}

/** Is the delivered line still held back? Codex's "submitted after next tool call" banner on the agent's screen. */
async function heldBack(o: Opts): Promise<boolean> {
  if (o.dryRun) return false;
  const screen = await ayOut(o, ["tail", "-n", "40", lastTarget], BUSY_CHECK_MS);
  return screen !== null && queuedOnScreen(screen);
}

/**
 * Release a held line: Esc, which the banner itself says submits it at once.
 * No body, so the line is never handed over twice (not `ay send --interrupt`,
 * which would paste it again). `ay key`, because `ay send <pid> "" --code esc`
 * is refused as an empty message (agent-yes 1.308.1).
 */
async function releaseHeld(o: Opts): Promise<number> {
  if (o.dryRun) return 0;
  const p = Bun.spawn(["ay", "key", lastTarget, "esc", "--force"], {
    cwd: o.cwd ?? process.cwd(),
    stdout: "ignore",
    stderr: "ignore",
  });
  return Promise.race([
    p.exited,
    new Promise<number>((r) => setTimeout(() => r(-1), SEND_WAIT_MS)),
  ]);
}

/** How long one delivery may take before the loop moves on (ay keeps the hand-over going). */
export const SEND_WAIT_MS = 20_000;
/** How long the busy check may take before the line goes out anyway. */
export const BUSY_CHECK_MS = 3_000;

/**
 * Is the agent the lines go to in the middle of a turn? `ay ls --json` status
 * "active" (owner, 2026-11-14: a busy agent used to get every waiting line
 * pushed one by one afterwards, each with the whole template). Unknown → not
 * busy, so a line is never held forever.
 */
/** `ay ls --json --local` rows, or [] when ay is slow or absent (never longer than BUSY_CHECK_MS). */
async function ayRows(): Promise<AyRow[]> {
  try {
    const p = Bun.spawn(["ay", "ls", "--json", "--local"], { stdout: "pipe", stderr: "ignore" });
    const txt = await Promise.race([
      new Response(p.stdout).text(),
      new Promise<string>((r) => setTimeout(() => r(""), BUSY_CHECK_MS)),
    ]);
    if (!txt) {
      p.kill();
      return [];
    }
    const v = JSON.parse(txt) as unknown;
    return ((Array.isArray(v) ? v : (v as { local?: unknown[] }).local) ?? []) as AyRow[];
  } catch {
    return [];
  }
}

/** The pid the lines go to when only a dir was given: the newest agent of the lane's CLI kind there. */
async function resolveTarget(o: Opts): Promise<string | null> {
  if (!o.cwd) return null;
  return pickTarget(await ayRows(), o.cwd, o.cli);
}

export async function targetBusy(o: Opts): Promise<boolean> {
  if (o.dryRun) return false;
  try {
    // This machine only, and never longer than BUSY_CHECK_MS: a slow or stuck
    // status query must not hold his lines (2026-11-14 20:0x: it did).
    const p = Bun.spawn(["ay", "ls", "--json", "--local"], { stdout: "pipe", stderr: "ignore" });
    const txt = await Promise.race([
      new Response(p.stdout).text(),
      new Promise<string>((r) => setTimeout(() => r(""), BUSY_CHECK_MS)),
    ]);
    if (!txt) {
      p.kill();
      return false;
    }
    const v = JSON.parse(txt) as unknown;
    const list = (Array.isArray(v) ? v : (v as { local?: unknown[] }).local) ?? [];
    // ay's rows: `status` is the process ("active" = alive), `state` the turn
    // ("active" = mid-turn, "idle", "needs_input", …). Busy means mid-turn.
    const rows = list as (AyRow & { state?: string })[];
    const pid = o.deliver ?? (o.cwd ? pickTarget(rows, o.cwd, o.cli) : null);
    const me = rows.find((e) => String(e.pid) === String(pid));
    return me?.state === "active";
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const o = parse(process.argv.slice(2));
  if (o instanceof Error) {
    console.error(o.message);
    return 1;
  }
  const t = laneToken(o.lane);
  const out = makeDeliverer(
    o,
    (body, interrupt) => deliver(o, body, interrupt),
    () => targetBusy(o),
    log,
    BUSY_RECHECK_MS,
    o.debounceMs,
    {
      afterMs: o.interruptAfterMs,
      queued: () => heldBack(o),
      release: () => releaseHeld(o),
    },
  );
  if (t.from === "none") {
    console.error(`lane-listen: ${t.why}. Needed: ${tokenNeeded(o.lane)}`);
    return 2;
  }
  const seen = new Set<string>();
  let backoff = 1_000;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      child?.kill(sig);
      process.exit(0);
    });
  for (;;) {
    const started = Date.now();
    child = Bun.spawn(
      [
        process.execPath,
        join(o.repo, "scripts", "dev", "lianki-dev.ts"),
        "listen",
        "--repo",
        o.repo,
        "--as",
        o.lane,
        // The hub shows this listener as hearing every line (presence, "全部消息").
        ...(o.everyone ? ["--everyone"] : []),
      ],
      {
        cwd: o.repo,
        env: { ...process.env, LIANKI_TOKEN: t.token },
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    log({ type: "listening", lane: o.lane, token: t.from, tests: o.tests });
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const l = lineOf(raw);
        if (process.env.LANE_LISTEN_DEBUG)
          log({
            type: "raw",
            lane: o.lane,
            parsed: !!l,
            history: l?.history,
            id: l?.id,
            head: raw.slice(0, 80),
          });
        if (!l || l.history || seen.has(l.id)) continue;
        seen.add(l.id);
        if (!listenerTakes(o, l)) continue;
        if (!voiceAllowed(l, o)) {
          log({ type: "other-voice", lane: o.lane, id: l.id });
          continue;
        }
        backoff = 1_000;
        await out.add(l);
      }
    }
    const code = await child.exited;
    // 1 usage, 2 the token refused (revoked, expired, wrong scope): restarting will not help.
    if (code === 1 || code === 2) {
      log({ type: "stopped", lane: o.lane, exit: code });
      if (code === 2)
        console.error(`lane-listen: the token was refused. Needed: ${tokenNeeded(o.lane)}`);
      return code;
    }
    // Exit 4 includes a socket gone silent (the CLI's keepalive): reconnect inside the hub's grace.
    const { wait, next } = reconnectWait(backoff, code, Date.now() - started);
    log({ type: "reconnect", lane: o.lane, exit: code, inMs: wait });
    await Bun.sleep(wait);
    backoff = next;
  }
}

if (import.meta.main) main().then((c) => process.exit(c));

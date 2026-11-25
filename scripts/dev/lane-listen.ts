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
 *   lianki-dev lane-listen --as claude --cwd … --everyone --system --skip-owner
 *
 * --everyone (tier ①, docs/lane-listen.md "Six tiers"): agents' lines are handed over
 * too, marked 【agent · coco】 (FYI, never answered), never the lane's own; the hub
 * shows it as hearing all messages. --system (tier ⓪, implies --everyone): the system
 * lines as well (lane events, state-tree hub lines, alerts), marked 【系统】; the hub
 * shows "all messages + system notices". --skip-owner: not
 * his lines (小克 has its own feed of them). --answer-unnamed (lanes.agents
 * answerUnnamed: coco, 杰咪): his lines that name nobody may be answered briefly,
 * when the lane has something to say; the hand-off notes say so.
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
import { setPhoneticMaxNear } from "../../packages/debug-chat/src/lane-phonetic";
import {
  listenerTakes,
  routeKey,
  laneToken,
  lineOf,
  makeAcker,
  makeDeliverer,
  makeSeqCursor,
  readCursor,
  receiptAfter,
  reconnectWait,
  catchUpTrigger,
  liftReceipt,
  makeRecovery,
  recoveredPage,
  type RecoveredPage,
  recoverMaxMs,
  writeCursor,
  tokenNeeded,
  voiceAllowed,
  type AyRow,
  pickTarget,
  sendCodes,
  unknownCode,
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
  /** Agents' lines too (tier ①). */
  everyone: boolean;
  /** The system lines as well (tier ⓪; implies everyone). */
  system: boolean;
  /** No owner lines (the lane has its own feed of them). */
  skipOwner: boolean;
  /** It may answer his lines that name nobody, briefly (lanes.agents answerUnnamed). */
  answerUnnamed: boolean;
};

function parse(argv: string[]): Opts | Error {
  const o: Partial<Opts> & {
    tests: boolean;
    dryRun: boolean;
    all: boolean;
    everyone: boolean;
    system: boolean;
    skipOwner: boolean;
    answerUnnamed: boolean;
  } = {
    tests: false,
    dryRun: false,
    all: false,
    everyone: false,
    system: false,
    skipOwner: false,
    answerUnnamed: false,
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
    else if (a === "--system") o.system = o.everyone = o.all = true;
    else if (a === "--skip-owner") o.skipOwner = true;
    else if (a === "--answer-unnamed") o.answerUnnamed = true;
    else return new Error(`lane-listen: unknown argument ${a}`);
  }
  o.lane ??= (process.env.LIANKI_LANE || undefined) as RouteLane | undefined;
  // The joined lanes (the lanes manager hands them over, docs/lane-listen.md "Every agent
  // joins"): a lane beyond codex and agy listens under its own name, and the router knows it.
  if (process.env.LIANKI_LANE_TABLE)
    try {
      setLaneTable(JSON.parse(process.env.LIANKI_LANE_TABLE));
    } catch {}
  // How near a name may sound (config lanes.phoneticMaxNear; lane-phonetic.ts).
  if (process.env.LIANKI_LANES_PHONETIC_MAX_NEAR)
    setPhoneticMaxNear(Number(process.env.LIANKI_LANES_PHONETIC_MAX_NEAR));
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
  // --code alt-m: an urgent line (his name, a roll call) breaks into the turn.
  // The pid is looked up first (pickTarget): `.` alone is refused by ay when the
  // dir holds more than one agent, and the line is lost (杰咪, 2026-11-15).
  const target = o.deliver ?? (await resolveTarget(o)) ?? ".";
  let code = 1;
  for (const key of sendCodes(interrupt)) {
    const p = Bun.spawn(["ay", "send", target, "--force", "--no-wait", "--code", key, "-"], {
      cwd: o.cwd ?? process.cwd(),
      stdin: new TextEncoder().encode(body),
      stdout: "ignore",
      stderr: "pipe",
    });
    code = await Promise.race([
      p.exited,
      new Promise<number>((r) => setTimeout(() => r(-1), SEND_WAIT_MS)),
    ]);
    if (code === -1) {
      console.error(`lane-listen: ay send still running after ${SEND_WAIT_MS} ms; not waiting`);
      return 4;
    }
    if (code === 0 || code === 4) return code;
    const err = (await new Response(p.stderr).text()).trim();
    console.error(`lane-listen: ay send (--code ${key}) exited ${code}: ${err.split("\n").at(-1)}`);
    if (!unknownCode(err)) return code;
  }
  return code;
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

const HUB = (process.env.LIANKI_URL ?? "https://lianki.com").replace(/\/+$/, "");
/** How long one receipt or recovery call may take. */
const CALL_MS = 15_000;

/** `lianki chat …` with the lane's token: its stdout, or null on a failure or timeout. */
async function liankiChat(o: Opts, token: string, args: string[]): Promise<string | null> {
  const p = Bun.spawn(
    [
      process.execPath,
      join(o.repo, "packages", "lianki-cli", "lianki.mjs"),
      "chat",
      ...args,
      "--json",
    ],
    {
      cwd: o.repo,
      env: { ...process.env, LIANKI_TOKEN: token, LIANKI_URL: HUB },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const timer = setTimeout(() => p.kill(), CALL_MS);
  try {
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out : null;
  } finally {
    clearTimeout(timer);
  }
}

/** The read receipt: the lane's agent was handed every line through `seq`. */
async function postSeen(o: Opts, token: string, seq: number): Promise<boolean> {
  const ok = (await liankiChat(o, token, ["seen", "--seq", String(seq)])) !== null;
  log({ type: ok ? "receipt" : "receipt-failed", lane: o.lane, seq });
  return ok;
}

/** One page of the owner's thread after `after` (through `through`), or null on any failure. */
async function readPage(
  o: Opts,
  token: string,
  after: number,
  through?: number,
): Promise<RecoveredPage | null> {
  const window = [
    "--after-seq",
    String(after),
    ...(through !== undefined ? ["--through-seq", String(through)] : []),
  ];
  const out = await liankiChat(o, token, ["read", ...window, "--limit", "100"]);
  return out ? recoveredPage(out) : null;
}

async function main(): Promise<number> {
  const o = parse(process.argv.slice(2));
  if (o instanceof Error) {
    console.error(o.message);
    return 1;
  }
  const t = laneToken(o.lane);
  // The delivered cursor (docs/lane-listen.md "Read receipts"): saved per lane,
  // it moves only past lines handed over (ay send 0/4) or not for this lane.
  // None saved yet: it starts at the first live line, nothing older is replayed.
  const saved = o.dryRun ? null : readCursor(o.lane);
  let cursor = saved === null ? null : makeSeqCursor(saved);
  let savedAt = saved ?? -1;
  const save = () => {
    if (!cursor || o.dryRun) return;
    const v = cursor.value();
    if (v !== savedAt) writeCursor(o.lane, (savedAt = v));
  };
  const acker = makeAcker((seq) => postSeen(o, t.token!, seq));
  const seen = new Set<string>();
  const out = makeDeliverer(
    o,
    (body, interrupt) => deliver(o, body, interrupt),
    () => targetBusy(o),
    log,
    undefined,
    (lines, ok) => {
      if (!cursor) return;
      const seqs = lines.map((l) => l.seq);
      if (!ok) {
        // Still held: the next connect's recovery reads it again and hands it over.
        for (const l of lines) seen.delete(l.id);
        return;
      }
      cursor.release(seqs);
      save();
      for (const s of seqs) if (s !== undefined && s > lastDelivered) lastDelivered = s;
      const r = o.dryRun ? null : receiptAfter(seqs, cursor.value(), acker.last());
      if (r !== null) void acker.ack(r);
    },
  );
  if (t.from === "none") {
    console.error(`lane-listen: ${t.why}. Needed: ${tokenNeeded(o.lane)}`);
    return 2;
  }
  const recoverMs = recoverMaxMs();
  /** The newest seq `ay send` took this run (for the receipt when the barrier lifts). */
  let lastDelivered = -1;
  /** One listener JSON line, live or recovered; held lines go to the deliverer. */
  const handle = async (raw: string, recovered: boolean) => {
    const l = lineOf(raw);
    if (process.env.LANE_LISTEN_DEBUG)
      log({
        type: "raw",
        lane: o.lane,
        parsed: !!l,
        history: l?.history,
        id: l?.id,
        recovered,
        head: raw.slice(0, 80),
      });
    if (!l || l.history) return;
    if (!cursor && l.seq !== undefined && !o.dryRun) cursor = makeSeqCursor(l.seq - 1);
    if (seen.has(l.id)) {
      cursor?.pass(l.seq);
      return save();
    }
    seen.add(l.id);
    const stale = recovered && l.at !== undefined && Date.now() - Date.parse(l.at) > recoverMs;
    if (!listenerTakes(o, l) || stale) {
      cursor?.pass(l.seq);
      return save();
    }
    if (!voiceAllowed(l, o)) {
      log({ type: "other-voice", lane: o.lane, id: l.id });
      cursor?.pass(l.seq);
      return save();
    }
    if (recovered) log({ type: "recovered", lane: o.lane, id: l.id, seq: l.seq });
    backoff = 1_000;
    cursor?.hold(l.seq);
    await out.add(l);
  };
  /**
   * Lines after the cursor the socket never brought (a drop, a restart): read
   * page by page up to the hub's head, the cursor barred until then (makeRecovery).
   */
  const recover = o.dryRun
    ? async () => {}
    : makeRecovery({
        cursor: () => cursor,
        read: (after, through) => readPage(o, t.token!, after, through),
        handle: (raw) => handle(raw, true),
        covered: () => {
          save();
          log({ type: "recovered-through", lane: o.lane, cursor: cursor?.value() });
          // Receipts held back by the barrier: one now, through the latest line handed over.
          const r = cursor ? liftReceipt(lastDelivered, cursor.value(), acker.last()) : null;
          if (r !== null) void acker.ack(r);
        },
        log,
        sleep: (ms) => Bun.sleep(ms),
      });
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
        // The hub shows this listener as hearing every line (presence, "全部消息"),
        // and the system notices too ("全部消息 + 系统通知").
        ...(o.everyone ? ["--everyone"] : []),
        ...(o.system ? ["--system"] : []),
      ],
      {
        cwd: o.repo,
        env: { ...process.env, LIANKI_TOKEN: t.token },
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    log({
      type: "listening",
      lane: o.lane,
      token: t.from,
      tests: o.tests,
      cursor: cursor?.value(),
    });
    // Catch-up starts when the socket says it is ready (catchUpTrigger): no gap between the
    // recovery's snapshot and the live stream. Until then the cursor is barred already.
    cursor?.bar();
    const trigger = catchUpTrigger(() => void recover());
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        trigger(raw);
        await handle(raw, false);
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

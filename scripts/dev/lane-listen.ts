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
 *
 * The token: LIANKI_TOKEN, else ~/.config/lianki/lanes/<lane>.token (0600),
 * made by the owner (lianki.com/preferences → API tokens; name = the lane,
 * chat:read chat:write chat:ask, an expiry). Never printed; a lane never
 * makes one. Without it, exit 2 and say which token is needed.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type RouteLane, isRouteLane, laneTakes, routeLine, testText } from "../../lib/lane-route";

// ---- pure parts (unit/lane-listen.test.ts) --------------------------------

/** Where a lane's token is kept on this Mac. */
export const laneTokenDir = (env: Record<string, string | undefined> = process.env) =>
  env.LIANKI_LANE_TOKEN_DIR || join(homedir(), ".config", "lianki", "lanes");
export const laneTokenPath = (lane: string, env?: Record<string, string | undefined>) =>
  join(laneTokenDir(env), `${lane}.token`);

/**
 * The lane's token: LIANKI_TOKEN, else its file. The file must be the owner's
 * alone (no group or other bits) and hold one lk_ token. Never logged.
 */
export function laneToken(
  lane: string | undefined,
  env: Record<string, string | undefined> = process.env,
): { token: string; from: "env" | "file" } | { token?: undefined; from: "none"; why: string } {
  const e = env.LIANKI_TOKEN?.trim();
  if (e) return { token: e, from: "env" };
  if (!lane || !/^[A-Za-z0-9._-]{1,40}$/.test(lane))
    return { from: "none", why: "no lane (--as) to look a token up for" };
  const path = laneTokenPath(lane, env);
  if (!existsSync(path)) return { from: "none", why: `no token file ${path}` };
  if (statSync(path).mode & 0o077)
    return { from: "none", why: `${path} is readable by others: chmod 600 it` };
  const t = readFileSync(path, "utf8").trim();
  if (!/^lk_[A-Za-z0-9_-]{16,}$/.test(t))
    return { from: "none", why: `${path} does not hold an lk_ token` };
  return { token: t, from: "file" };
}

/** What the owner makes at lianki.com/preferences → API tokens for `lane`. */
export const tokenNeeded = (lane: string) =>
  `a lane token for ${lane}: lianki.com/preferences → API tokens → name "${lane}", permissions chat:read chat:write chat:ask (nothing else), an expiry; saved at ${laneTokenPath(lane)} (chmod 600) or passed as LIANKI_TOKEN`;

/** A chat line from either listener's JSON (eval.ts chat, or `lianki chat listen --json`). */
export type Line = { id: string; thread: string; from: string; text: string; at?: string };
export function lineOf(raw: string): (Line & { history: boolean }) | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || v.type !== "chat") return null;
  const m = (v.message && typeof v.message === "object" ? v.message : v) as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.text !== "string") return null;
  return {
    id: m.id,
    thread: typeof m.thread === "string" ? m.thread : "owner",
    from: typeof m.from === "string" ? m.from : "",
    text: m.text,
    ...(m.at !== undefined
      ? { at: String(typeof m.at === "number" ? new Date(m.at).toISOString() : m.at) }
      : {}),
    history: v.history === true,
  };
}

/** HH:MM in JST. */
export const jst = (at?: string) => {
  const d = at ? new Date(at) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return new Date(t.getTime() + 9 * 3600_000).toISOString().slice(11, 16);
};

/** What the lane's agent is handed: his words, and how to answer as itself. */
export function handoff(lane: RouteLane, l: Line, repo: string): string {
  const test = testText(l);
  const words = test ?? l.text;
  const said = routeLine(words);
  const reply = `bun ${join(repo, "scripts", "dev", "lianki-dev.ts")} say --repo ${repo} --as ${lane} "<your reply>"`;
  return [
    test === null
      ? `【owner → ${lane}】(${jst(l.at)} JST, Li chat) ${words}`
      : `【lane-test → ${lane}】(${jst(l.at)} JST) ${words}`,
    "",
    test === null
      ? `He addressed this to you by name; only you got it, the other lanes stay silent. Answer once, yourself, short, in his language${said.text ? "" : " (he only said your name: ask what he needs)"}:`
      : 'This is a routing TEST, not the owner. Answer once, starting "[lane-test] ", one short line, so the test sees you heard it:',
    `  ${reply}`,
    "It posts as your lane (your name, mark and voice) with your own lane token; never read or print the token. Do not hand this to another lane.",
  ].join("\n");
}

// ---- the listener ----------------------------------------------------------

type Opts = {
  lane: RouteLane;
  repo: string;
  deliver?: string;
  cwd?: string;
  tests: boolean;
  dryRun: boolean;
};

function parse(argv: string[]): Opts | Error {
  const o: Partial<Opts> & { tests: boolean; dryRun: boolean } = { tests: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = () => argv[++i];
    if (a === "--lane" || a === "--as") o.lane = v() as RouteLane;
    else if (a === "--repo") o.repo = v();
    else if (a === "--deliver") o.deliver = v();
    else if (a === "--cwd") o.cwd = v();
    else if (a === "--tests") o.tests = true;
    else if (a === "--dry-run") o.dryRun = true;
    else return new Error(`lane-listen: unknown argument ${a}`);
  }
  o.lane ??= (process.env.LIANKI_LANE || undefined) as RouteLane | undefined;
  if (!isRouteLane(o.lane) || o.lane === "chat")
    return new Error(
      "lane-listen: --as codex | agy (the chat lane listens with `eval.ts chat --route chat`)",
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

async function deliver(o: Opts, body: string): Promise<number> {
  if (o.dryRun) {
    console.log(body);
    return 0;
  }
  // `ay send . …` from the lane's dir finds the lane however often it restarted.
  const p = Bun.spawn(["ay", "send", o.deliver ?? ".", "--force", "-"], {
    cwd: o.cwd ?? process.cwd(),
    stdin: new TextEncoder().encode(body),
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await p.exited;
  if (code !== 0 && code !== 4)
    console.error(
      `lane-listen: ay send exited ${code}: ${(await new Response(p.stderr).text()).trim().split("\n").at(-1)}`,
    );
  return code;
}

async function main(): Promise<number> {
  const o = parse(process.argv.slice(2));
  if (o instanceof Error) {
    console.error(o.message);
    return 1;
  }
  const t = laneToken(o.lane);
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
    child = Bun.spawn(
      [
        process.execPath,
        join(o.repo, "scripts", "dev", "lianki-dev.ts"),
        "listen",
        "--repo",
        o.repo,
        "--as",
        o.lane,
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
        if (!l || l.history || seen.has(l.id)) continue;
        seen.add(l.id);
        if (!laneTakes(o.lane, l, { tests: o.tests })) continue;
        backoff = 1_000;
        const code = await deliver(o, handoff(o.lane, l, o.repo));
        log({ type: "delivered", lane: o.lane, id: l.id, test: testText(l) !== null, ay: code });
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
    log({ type: "reconnect", lane: o.lane, exit: code, inMs: backoff });
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, code === 5 ? 600_000 : 60_000);
  }
}

if (import.meta.main) main().then((c) => process.exit(c));

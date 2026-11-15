#!/usr/bin/env bun
/**
 * `lianki-dev lanes`: the lanes manager (owner, 2026-11-15 "全员入群";
 * docs/lane-listen.md, "Every agent joins"). Every agent on this Mac whose
 * working directory is under Lianki or a repo it depends on (config
 * lanes.repos) joins the owner's chat as its own lane: a resident lane
 * (lanes.agents) gets its own `lane-listen --all`; any other lane is a
 * reader, woken by name (the manager hands it the line with `ay send
 * --code alt-m`). Each new lane greets once with its own token; the names
 * still waiting for a token are said once in the chat. It never mints a token.
 *
 *   lianki-dev lanes                 # run (under oxmgr, like the other pieces)
 *   lianki-dev lanes --once --dry-run   # print what it would do now, do nothing
 *
 * What it watches: `ay ls --watch --local` (ay's own registry diff, NDJSON);
 * each edge re-reads `ay ls --json --local`, and a slow re-list every
 * lanes.relistSec covers a silent stream. Its reader socket: `lianki chat
 * listen --json --reader` with the manager's own token
 * (~/.config/lianki/lanes/<LIANKI_LANES_MANAGER_LANE or "lanes">.token).
 *
 * The decisions are pure (./lanes-manager-lib.ts) and the loop takes its
 * effects as Deps (./lanes-manager-core.ts); this file only wires them up.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lanesConfig } from "../../lib/lanes-config";
import { parseLaneDef } from "../../packages/debug-chat/src/voices";
import { laneToken, laneTokenDir } from "./lane-listen-lib";
import { type Child, type Deps, createManager, listenerArgv } from "./lanes-manager-core";
import type { ManagerState } from "./lanes-manager-lib";

const HUB = (process.env.LIANKI_URL ?? "https://lianki.com").replace(/\/+$/, "");
const AY_MS = 5_000;

const log = (v: Record<string, unknown>) =>
  console.log(JSON.stringify({ ...v, at: new Date().toISOString() }));

async function text(argv: string[], ms = AY_MS): Promise<string> {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    const out = await Promise.race([
      new Response(p.stdout).text(),
      new Promise<string>((r) => setTimeout(() => r(""), ms)),
    ]);
    if (!out) p.kill();
    return out;
  } catch {
    return "";
  }
}

function parse(argv: string[]) {
  const o = { repo: resolve(join(import.meta.dir, "..", "..")), once: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--repo") o.repo = resolve(argv[++i] ?? o.repo);
    else if (a === "--once") o.once = true;
    else if (a === "--dry-run") o.dryRun = true;
    else throw new Error(`lanes: unknown argument ${a}`);
  }
  return o;
}

async function main(): Promise<number> {
  let o: ReturnType<typeof parse>;
  try {
    o = parse(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const cfg = lanesConfig(process.env);
  const managerLane = process.env.LIANKI_LANES_MANAGER_LANE || "lanes";
  const statePath = join(laneTokenDir(), "manager-state.json");
  let extraTable: ReturnType<typeof parseLaneDef>[] = [];
  try {
    const rows = JSON.parse(process.env.LIANKI_CHAT_LANES ?? "[]") as unknown[];
    extraTable = rows.map(parseLaneDef).filter(Boolean);
  } catch {}
  const deps: Deps = {
    ayList: () => text(["ay", "ls", "--json", "--local"]),
    ps: () => text(["ps", "-axo", "pid=,command="]),
    // LIANKI_TOKEN is the manager's own environment, never a lane's: lanes use their files only.
    token: (lane) => laneToken(lane, { ...process.env, LIANKI_TOKEN: undefined }).token,
    startListener: ({ lane, cwd, table, scope, skipOwner, cli }): Child => {
      const p = Bun.spawn(
        listenerArgv(process.execPath, o.repo, lane, cwd, { scope, skipOwner, cli }),
        {
          cwd: o.repo,
          env: { ...process.env, LIANKI_TOKEN: undefined, LIANKI_LANE_TABLE: table },
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      return { pid: p.pid, kill: () => p.kill(), exited: p.exited };
    },
    chat: async (token, body) => {
      try {
        const r = await fetch(`${HUB}/api/version/chat`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { ok: r.ok, status: r.status };
      } catch {
        return { ok: false, status: 0 };
      }
    },
    wake: async (pid, body) => {
      const p = Bun.spawn(
        ["ay", "send", String(pid), "--force", "--no-wait", "--code", "alt-m", "-"],
        { stdin: new TextEncoder().encode(body), stdout: "ignore", stderr: "ignore" },
      );
      return Promise.race([p.exited, new Promise<number>((r) => setTimeout(() => r(-1), 20_000))]);
    },
    loadState: (): ManagerState => {
      try {
        const v = JSON.parse(readFileSync(statePath, "utf8")) as ManagerState;
        return Array.isArray(v.greeted) ? v : { greeted: [] };
      } catch {
        return { greeted: [] };
      }
    },
    saveState: (s) => {
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
      writeFileSync(`${statePath}.tmp`, JSON.stringify(s), { mode: 0o600 });
      renameSync(`${statePath}.tmp`, statePath);
    },
    log,
  };
  const m = createManager(deps, {
    repo: o.repo,
    cfg,
    managerLane,
    extraTable: extraTable as never,
    dryRun: o.dryRun,
    locale: process.env.LIANKI_LANES_LOCALE || "zh",
  });
  await m.relist();
  log({
    type: "planned",
    lanes: m.planned().map((p) => p.lane),
    unwoken: m
      .planned()
      .filter((p) => !p.wake)
      .map((p) => p.lane),
    running: m.running(),
  });
  if (o.once) return 0;
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      m.stop();
      process.exit(0);
    });

  // One re-list per burst of ay edges; a slow one if the stream says nothing.
  let due: ReturnType<typeof setTimeout> | undefined;
  const soon = (ms = 2_000) => {
    if (due) return;
    due = setTimeout(() => {
      due = undefined;
      void m.relist();
    }, ms);
  };
  setInterval(() => soon(0), cfg.relistSec * 1000);
  void (async () => {
    for (let backoff = 1_000; ; backoff = Math.min(backoff * 2, 60_000)) {
      const p = Bun.spawn(["ay", "ls", "--watch", "--local"], { stdout: "pipe", stderr: "ignore" });
      for await (const _ of p.stdout as ReadableStream<Uint8Array>) soon();
      await Bun.sleep(backoff);
    }
  })();

  // The readers' wake path: one reader socket with the manager's own token.
  const mt = deps.token(managerLane);
  if (!mt) {
    log({
      type: "no-manager-token",
      lane: managerLane,
      why: "readers cannot be woken by name until it exists",
    });
    await new Promise(() => {});
  }
  for (let backoff = 1_000; ; backoff = Math.min(backoff * 2, 60_000)) {
    const p = Bun.spawn(
      [
        process.execPath,
        join(o.repo, "packages", "lianki-cli", "lianki.mjs"),
        "chat",
        "listen",
        "--json",
        "--reader",
      ],
      {
        cwd: o.repo,
        env: { ...process.env, LIANKI_TOKEN: mt, LIANKI_URL: HUB },
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        await m.line(raw);
      }
    }
    const code = await p.exited;
    if (code === 2) {
      log({ type: "manager-token-refused", lane: managerLane });
      return 2;
    }
    log({ type: "reconnect", exit: code, inMs: backoff });
    await Bun.sleep(backoff);
  }
}

if (import.meta.main) main().then((c) => process.exit(c));

#!/usr/bin/env bun
/**
 * `lianki-dev`: one CLI for the agent lanes (docs/lianki-dev-cli.md). Each
 * subcommand runs the existing script — eval.ts for say/ask/inbox/listen/serve,
 * the progress.ts modules for progress — so it has no powers of its own: the
 * same saved grant, the same scopes. `--as <lane>` labels a line 【lane】 and
 * never pairs; pairing only with --pair, run by a human. (The npm `lianki`
 * CLI, packages/lianki-cli, is the users' one: cards and settings.)
 *
 *   lianki-dev say --as codex "hello"
 *   lianki-dev doctor
 *   lianki-dev --help · lianki-dev <command> --help
 *
 * Parsing, labels, help texts, exit codes and doctor's lines are in
 * ./lianki-dev-cli.ts; this file only looks things up and spawns.
 */
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  EXIT,
  type Facts,
  type Global,
  type Sub,
  USAGE,
  chatArgv,
  childExit,
  doctorExit,
  doctorFindings,
  errorLine,
  evalArgv,
  okLine,
  parseArgs,
  progressArgv,
} from "./lianki-dev-cli";
import { PROGRESS_USAGE, formatStats, parseProgressArgs } from "./progress-args";
import { postProgress, progressToken } from "./progress-client";
import { type ProgressDone, progressStats } from "../../lib/progress";

const HUB = (process.env.LIANKI_URL ?? "https://lianki.com").replace(/\/+$/, "");

let json = false;
/** Print an error (with --json, one envelope line on stderr) and exit with `code`. */
function fail(code: number, message: string): never {
  console.error(json ? errorLine(code, message) : `lianki-dev: ${message}`);
  process.exit(code);
}

const isCheckout = (dir: string) => existsSync(join(dir, "scripts", "dev", "eval.ts"));
const git = (cwd: string, ...args: string[]) => {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", ...args], {
      cwd,
      stderr: "ignore",
    });
    return r.success ? r.stdout.toString().trim() : undefined;
  } catch {
    return undefined;
  }
};

/** The checkout whose scripts run: --repo, LIANKI_REPO, this directory's worktree, else the CLI's own. */
function findRepo(g: Global): { repo?: string; from: Facts["repoFrom"] } {
  if (g.repo) {
    const dir = resolve(g.repo);
    const top = git(dir, "--show-toplevel") ?? dir;
    return isCheckout(top) ? { repo: top, from: g.repoFrom ?? "flag" } : { from: "none" };
  }
  const top = git(process.cwd(), "--show-toplevel");
  if (top && isCheckout(top)) return { repo: top, from: "cwd" };
  const own = resolve(dirname(realpathSync(import.meta.path)), "..", "..");
  return isCheckout(own) ? { repo: own, from: "cli" } : { from: "none" };
}

/** The main checkout (where eval.ts keeps the grants), found as eval-socket.ts's mainRoot does. */
const mainRootOf = (repo: string) => {
  const common = git(join(repo, "scripts", "dev"), "--git-common-dir");
  return common ? dirname(common) : repo;
};
const grantFile = (repo: string, name: string, env: string) =>
  process.env[env] ? resolve(process.env[env]!) : join(mainRootOf(repo), name);

function progressSource(repo: string | undefined, rest: string[]): Facts["progressToken"] {
  if (rest.includes("--token") || rest.some((a) => a.startsWith("--token="))) return "flag";
  if (process.env.LIANKI_PROGRESS_TOKEN || process.env.PROGRESS_TOKEN) return "env";
  return repo && progressToken(undefined, repo) ? "dev.vars" : "none";
}

async function reach(hub: string): Promise<Facts["network"]> {
  try {
    await fetch(hub, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(4000) });
    return "ok";
  } catch (e) {
    return { error: (e as Error).message.split("\n")[0]!.slice(0, 120) };
  }
}

/** Only whether things exist: grant files are never opened here. */
async function facts(g: Global, rest: string[], network: boolean): Promise<Facts> {
  const { repo, from } = findRepo(g);
  const sessionDir = join(homedir(), ".config", "lianki");
  let sessionDirWritable = false;
  try {
    accessSync(existsSync(sessionDir) ? sessionDir : homedir(), constants.W_OK);
    sessionDirWritable = true;
  } catch {}
  const chat = repo && grantFile(repo, ".debug-chat-token.json", "LIANKI_CHAT_TOKEN_FILE");
  const ev = repo && grantFile(repo, ".debug-eval-token.json", "LIANKI_EVAL_TOKEN_FILE");
  return {
    ...(g.lane ? { lane: g.lane } : {}),
    ...(repo ? { repo, mainRoot: mainRootOf(repo), grantDir: dirname(chat as string) } : {}),
    repoFrom: from,
    hub: HUB,
    chatGrant: !!chat && existsSync(chat),
    evalGrant: !!ev && existsSync(ev),
    network: network ? await reach(HUB) : { error: "not checked" },
    progressToken: progressSource(repo, rest),
    sessionDirWritable,
  };
}

/** Read a stream to its end, passing it on to `to` unless `quiet`; resolves with all of it. */
async function drain(stream: ReadableStream<Uint8Array>, to: NodeJS.WriteStream, quiet: boolean) {
  const dec = new TextDecoder();
  let all = "";
  for await (const chunk of stream) {
    const s = dec.decode(chunk, { stream: true });
    if (!quiet) to.write(s);
    all += s;
  }
  return all;
}

/**
 * Run `eval.ts <argv>` from `repo`. Its stderr is passed on and its last line
 * kept, to tell a network failure from a refusal. With --json on a one-shot
 * command its stdout becomes the envelope's data.
 */
async function runEval(sub: Sub, repo: string, argv: string[]): Promise<number> {
  const wrap = json && sub !== "listen" && sub !== "serve";
  const child = Bun.spawn([process.execPath, join(repo, "scripts", "dev", "eval.ts"), ...argv], {
    cwd: repo,
    stdin: "inherit",
    stdout: wrap ? "pipe" : "inherit",
    stderr: "pipe",
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  const [out, err] = await Promise.all([
    wrap ? drain(child.stdout as ReadableStream<Uint8Array>, process.stdout, true) : "",
    drain(child.stderr as ReadableStream<Uint8Array>, process.stderr, json),
  ]);
  const last = err.trim().split("\n").at(-1) ?? "";
  const code = childExit(await child.exited, last);
  if (code !== EXIT.ok) {
    if (json) console.error(errorLine(code, last || `eval.ts exited with ${code}`));
    return code;
  }
  if (wrap) {
    let data: unknown = out.trim();
    try {
      data = JSON.parse(out);
    } catch {}
    console.log(okLine(sub, data));
  }
  return code;
}

/** `lianki chat …` from this checkout's packages/lianki-cli; LIANKI_TOKEN passes through the environment. */
async function runChat(sub: Sub, repo: string, rest: string[], stdin?: string): Promise<number> {
  const argv = chatArgv(sub, rest, stdin);
  if (argv instanceof Error) fail(EXIT.usage, argv.message);
  const cli = join(repo, "packages", "lianki-cli", "lianki.mjs");
  const child = Bun.spawn([process.execPath, cli, ...argv, ...(json ? ["--json"] : [])], {
    cwd: repo,
    env: { ...process.env, LIANKI_URL: HUB },
    stdin: argv.stdin !== undefined ? new TextEncoder().encode(argv.stdin) : "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  return await child.exited;
}

async function progress(g: Global, rest: string[], repo: string | undefined): Promise<number> {
  const cmd = parseProgressArgs(progressArgv(rest, g));
  if (cmd instanceof Error) fail(EXIT.usage, `progress: ${cmd.message}\n${PROGRESS_USAGE}`);
  if (cmd.cmd === "report" && cmd.warning) console.error(`progress: warning: ${cmd.warning}`);
  const token = progressToken(cmd.token, repo);
  if (!token)
    fail(
      EXIT.notReady,
      "progress: no token (--token, LIANKI_PROGRESS_TOKEN, or PROGRESS_TOKEN in .dev.vars)",
    );
  const [path, body] =
    cmd.cmd === "report"
      ? ["", cmd.report]
      : cmd.cmd === "grant"
        ? ["/grant", { node: cmd.node, agent: cmd.agent, ttl: cmd.ttl }]
        : cmd.cmd === "resolve"
          ? ["/resolve", { id: cmd.id, note: cmd.note }]
          : cmd.cmd === "stats"
            ? ["/stats", undefined]
            : ["", undefined];
  const res = await postProgress(HUB, token, path, body);
  if (res instanceof Error) {
    // postProgress words an HTTP refusal "<status> <body>"; anything else did not reach it.
    const http = /^\d{3} /.test(res.message);
    fail(http ? EXIT.refused : EXIT.network, `progress: ${res.message}`);
  }
  if (json) console.log(okLine("progress", res));
  else if (cmd.cmd === "show") console.log(JSON.stringify(res, null, 2));
  else if (cmd.cmd === "stats") {
    const done = (res.done ?? []) as ProgressDone[];
    console.log(
      formatStats(progressStats(done, { agent: cmd.agent, since: Date.now() - cmd.since })),
    );
  } else if (cmd.cmd === "grant") console.log(res.token);
  else if (cmd.cmd === "resolve")
    console.log(
      `progress: resolved ${(res.resolved as string[]).join(", ") || "nothing (already done)"}`,
    );
  else {
    const e = res.entry as { id: string; status: string; rev: number };
    console.log(`progress: ${e.id} ${e.status} (rev ${e.rev}, ${res.readers ?? 0} watching)`);
  }
  return EXIT.ok;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed instanceof Error) {
    json = process.argv.includes("--json");
    fail(EXIT.usage, `${parsed.message}\n${json ? "" : USAGE.main}`.trim());
  }
  const { global: g, rest } = parsed;
  json = g.json;
  const sub: Sub | undefined = parsed.sub;
  if (!sub || sub === "help") {
    const topic = sub === "help" ? (rest[0] as Sub | undefined) : undefined;
    console.log(topic && USAGE[topic] ? USAGE[topic] : USAGE.main);
    return sub || g.help ? EXIT.ok : EXIT.usage;
  }
  if (g.help) {
    console.log(USAGE[sub]);
    return EXIT.ok;
  }
  if (sub === "whoami" || sub === "doctor") {
    const f = await facts(g, rest, sub === "doctor");
    if (sub === "whoami") {
      const who = {
        lane: f.lane ?? null,
        repo: f.repo ?? null,
        repoFrom: f.repoFrom,
        mainRoot: f.mainRoot ?? null,
        hub: f.hub,
        grant: f.chatGrant ? "chat" : f.evalGrant ? "eval" : "none",
        progressToken: f.progressToken,
        pairing: g.pair ? "on" : "off",
      };
      if (json) console.log(okLine("whoami", who));
      else for (const [k, v] of Object.entries(who)) console.log(`${k}: ${v ?? "-"}`);
      return f.repo ? EXIT.ok : EXIT.notReady;
    }
    const findings = doctorFindings(f);
    const code = doctorExit(findings);
    if (json)
      console.log(
        JSON.stringify({
          v: 1,
          ok: code === EXIT.ok,
          command: "doctor",
          data: { findings },
          exit: code,
        }),
      );
    else for (const x of findings) console.log(`${x.level.padEnd(7)} ${x.check}: ${x.line}`);
    return code;
  }
  const { repo } = findRepo(g);
  if (sub === "progress") return progress(g, rest, repo);
  if (!repo)
    fail(EXIT.notReady, "no Lianki checkout here: pass --repo <path> (or set LIANKI_REPO)");
  const stdin = sub === "say" && rest.includes("-") ? await Bun.stdin.text() : undefined;
  // A lane token (LIANKI_TOKEN): say/ask/listen go through the public CLI's
  // `lianki chat`, in that token account's own thread, labelled with its name.
  // No grant, no pairing; without a token the grant path below is unchanged.
  if (process.env.LIANKI_TOKEN && !g.pair && (sub === "say" || sub === "ask" || sub === "listen"))
    return runChat(sub, repo, rest, stdin);
  const argv = evalArgv(sub, rest, g, stdin);
  if (argv instanceof Error) fail(EXIT.usage, `${argv.message}\n${json ? "" : USAGE[sub]}`.trim());
  // Nothing to send with: say so before eval.ts opens a socket (lanes never pair).
  const f = await facts(g, rest, false);
  // serve with an eval token (LIANKI_TOKEN, docs/secrets-and-auth.md "Eval tokens")
  // needs no saved grant: eval.ts connects with the token.
  const evalToken = /^lk_[0-9a-f]{64}$/.test(process.env.LIANKI_TOKEN?.trim() ?? "");
  // voices --cloud asks no page: no grant needed. voices otherwise reads pages: eval.
  const cloudOnly = sub === "voices" && rest.includes("--cloud");
  const has =
    cloudOnly ||
    (sub === "serve" && evalToken) ||
    (sub === "serve" || sub === "voices" ? f.evalGrant : f.chatGrant || f.evalGrant);
  if (!g.pair && !has)
    fail(EXIT.notReady, doctorFindings(f).find((x) => x.check === "grant")!.line);
  return runEval(sub, repo, argv);
}

main().then(
  (code) => process.exit(code),
  (e) => fail(EXIT.refused, (e as Error).message),
);

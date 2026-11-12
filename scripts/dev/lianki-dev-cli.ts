/**
 * The pure half of scripts/dev/lianki-dev.ts (docs/lianki-dev-cli.md): global
 * flags, the lane label, the argv each subcommand hands to eval.ts, the help
 * texts, the exit codes and JSON envelope (those of the npm `lianki` CLI in
 * packages/lianki-cli), and doctor's one-line findings. No I/O here, so it is
 * unit-tested without the network (unit/lianki-dev-cli.test.ts).
 */

/** Exit codes, the same for every subcommand (documented in --help). */
export const EXIT = {
  /** Done. */
  ok: 0,
  /** Bad arguments; nothing was sent. */
  usage: 1,
  /** Not ready here: no saved grant, no token, no checkout (doctor says which). Nothing was sent. */
  notReady: 2,
  /** The hub could not be reached (no network, a timeout, a dropped socket). */
  network: 4,
  /** The hub refused it (an invalid grant, out of scope, a bad value). */
  refused: 5,
} as const;

/** The JSON error code of each failing exit. */
export const ERROR_CODE: Record<number, string> = {
  [EXIT.usage]: "usage",
  [EXIT.notReady]: "not_ready",
  [EXIT.network]: "network",
  [EXIT.refused]: "refused",
};

/** --json success: one line on stdout. */
export const okLine = (command: string, data: unknown) =>
  JSON.stringify({ v: 1, ok: true, command, data });

/** --json failure: one line on stderr, nothing on stdout. */
export const errorLine = (exit: number, message: string) =>
  JSON.stringify({
    v: 1,
    ok: false,
    error: { code: ERROR_CODE[exit] ?? "refused", message },
    exit,
  });

export const SUBCOMMANDS = [
  "say",
  "reply",
  "voices",
  "ask",
  "withdraw",
  "edit",
  "inbox",
  "listen",
  "lane-listen",
  "serve",
  "progress",
  "whoami",
  "doctor",
  "help",
] as const;
export type Sub = (typeof SUBCOMMANDS)[number];

const EXITS =
  "exit: 0 ok · 1 usage · 2 not ready here (`lianki-dev doctor`) · 4 network · 5 refused by the hub";
const GLOBAL =
  "global: --as <lane> (or LIANKI_LANE) · --repo <path> (or LIANKI_REPO) · --json · --pair (humans only)";

export const USAGE: Record<Sub | "main", string> = {
  main: `usage: lianki-dev <command> [options]

  say       a chat line to the owner (or --to a thread)
  reply     reply to the owner with optional --polish (edit + say in one atomic step)
  voices    the voice ids say --voice takes: the phone's own, and the cloud's
  ask      an ask card with tappable options
  withdraw  withdraw an open ask card he no longer needs to answer
  edit      polish his voice line, merge a run of them into one passage, or undo a merge
  inbox     the chat inbox: list | get <id> [--out <dir>] | done <id>
  listen    listen to the chat (eval.ts chat), one JSON line per event
  lane-listen  a lane's own listener: the owner lines addressed to it, handed to its agent
  serve     hold an eval session (eval.ts serve)
  progress  report to the state tree (progress.ts)
  whoami    lane, checkout, hub, which grant and token are present
  doctor    what is missing here, one line each

${GLOBAL}
  --as <lane>   label each line 【<lane>】; a lane never pairs
  --repo <path> run that checkout's scripts (default: this worktree)
  --json        one line {"v":1,"ok":true,"command","data"} on stdout;
                an error {"v":1,"ok":false,"error":{code,message},"exit"} on stderr
  --pair        let this run ask the owner's devices to pair (not with --as)
${EXITS}
\`lianki-dev <command> --help\` for one command.`,
  reply: `usage: lianki-dev reply [--polish "polished text"] [--id <msgId>] "reply text" | -\n  Atomic polish + reply in one shot.\n${GLOBAL}\n${EXITS}\n`,
  say: `usage: lianki-dev say [--to <thread|email|/node>] [--quiet] [--voice <id>] "text" | -
  One chat line with the saved grant, then exit (eval.ts say). - reads stdin.
  With --as <lane> the text is sent as 【<lane>】text. Read aloud unless --quiet,
  in the lane's own voice (codex, agy: docs/dev-debug-widget.md, "Lanes and
  voices"); --voice picks another one for this line:
    main | calm | bright   the lane table's voices
    device:<name>          a voice the phone has (lianki-dev voices), read with
                           speech even when the output is cloud
    melo:<lang>            the cloud's MeloTTS voice (en es fr zh ja ko)
    aura:<speaker>         a Workers AI Aura-2 speaker (luna orion thalia celeste nestor carina)
    eleven:<id>            an ElevenLabs public preview clip (its own words)
  An unknown id is refused; a voice the phone lacks falls back to the lane's.
  stdout: the hub's {"type":"said",…} (with --json, as "data").
${GLOBAL}
${EXITS}`,
  voices: `usage: lianki-dev voices [--cloud] [--target <text>]
  The ids say --voice takes, as one JSON line (eval.ts voices): each open
  debug page's device voices, read once over the eval channel (needs the
  saved eval grant; never pairs unless --pair), zh, ja and en first; and
  the cloud's list. --cloud: the cloud's list only, no page asked.
${GLOBAL}
${EXITS}`,
  withdraw: `usage: lianki-dev withdraw <askId|msgId> | --last [--to <thread|email>]
  Withdraws an open ask card (eval.ts withdraw): the hub marks it withdrawn,
  every open page greys it out ("Withdrawn", no options) and it is never read
  aloud; a later tap is refused. --last: the latest open ask in the thread.
  stdout: the hub's {"type":"withdrawn",…} (with --json, as "data").
${GLOBAL}
${EXITS}`,
  ask: `usage: lianki-dev ask [--node /path] [--to owner|<email>] --q "question" --opt "a" --opt "b" [--multi] [--q …] [--wait] [--timeout <s>]
  An ask card (eval.ts ask); the first --opt is the recommended one. --wait
  prints the tap's {"type":"answered",…}, else the hub's {"type":"asked",…}.
  With --as <lane> each question is labelled 【<lane>】.
  --node: the state tree node the question is about (else LIANKI_TASK_PATH);
  required with --as <lane>. The question is noted on it ("ask: …"), and with
  --wait the answer too ("answer: … → …"); the node must be in the tree.
${GLOBAL}
${EXITS}`,
  edit: `usage: lianki-dev edit (<msgId> | --last) "polished text" | -
       lianki-dev edit --merge <id1,id2,…> --text "passage" | -
       lianki-dev edit --unmerge <id>
       lianki-dev edit --summary (<msgId>… | --last N) "summary" | -
  Edits of the owner's voice lines (eval.ts edit; docs/dev-debug-widget.md,
  "Agent edits of voice messages"). --merge rewrites a RUN of his consecutive
  voice lines (nothing between them, one topic) as ONE fluent passage; the
  lines stay kept, a tap shows them, his ↩ (or --unmerge) restores them.
  stdout: the hub's {"type":"edited",…} (with --json, as "data").
${GLOBAL}
${EXITS}`,
  inbox: `usage: lianki-dev inbox [list | get <id> [--out <dir>] | done <id>]
  The chat inbox (eval.ts inbox): files the owner attached. JSON on stdout.
${GLOBAL}
${EXITS}`,
  listen: `usage: lianki-dev listen [--out <file>] [--exit-on-idle] [--ack] [--task-path /node] [--agent <name>]
  The chat listener (eval.ts chat): one JSON line per message or event, as
  eval.ts prints them (also with --json), and it stays connected. Never
  pairs unless --pair (a human, no --as).
${GLOBAL}
${EXITS}`,
  "lane-listen": `usage: lianki-dev lane-listen --as codex|agy (--cwd <lane dir> | --deliver <ay keyword>) [--tests] [--dry-run]
  The lane's own chat listener (scripts/dev/lane-listen.ts, docs/lane-listen.md):
  listens with the lane's token, keeps the owner lines addressed to this lane
  ("codex, …", "agy, …": lib/lane-route.ts) and hands each to the lane's agent
  with \`ay send\` (from --cwd: \`ay send .\`). The lane answers with
  \`lianki-dev say --as <lane>\`. --tests: also "[lane-test] …" agent lines.
  Token: LIANKI_TOKEN, else ~/.config/lianki/lanes/<lane>.token (exit 2 without).
${GLOBAL}
${EXITS}`,
  serve: `usage: lianki-dev serve [--label "…"]
  Hold an eval session (eval.ts serve) with the saved eval grant. Never pairs
  unless --pair (a human, no --as).
${GLOBAL}
${EXITS}`,
  progress: `usage: lianki-dev progress --task "<text>" --status <status> [--path /a/b] [--pct 40] [--eta 15m] [--done] [--pr N] …
       lianki-dev progress show | grant --node <id> --agent <name> [--ttl 8h] | resolve --id <id> [--note "…"]
  The state tree's live progress (progress.ts; every flag of
  \`bun scripts/dev/progress.ts --help\`). --agent defaults to the lane.
  Token: --token, LIANKI_PROGRESS_TOKEN, PROGRESS_TOKEN, else .dev.vars.
${GLOBAL}
${EXITS}`,
  whoami: `usage: lianki-dev whoami
  The lane, the checkout used, the hub URL, which saved grant exists (never
  its contents), and where the progress token would come from.
${GLOBAL}
${EXITS}`,
  doctor: `usage: lianki-dev doctor
  Checks the checkout, the saved grant, the network to the hub, the progress
  token and the session dir; prints one line per finding. Exits 2 when a
  local piece say/ask/inbox need is missing, 4 when only the network is.
${GLOBAL}
${EXITS}`,
  help: `usage: lianki-dev help [<command>]`,
};

export type Global = {
  lane?: string;
  repo?: string;
  repoFrom?: "flag" | "env";
  json: boolean;
  pair: boolean;
  help: boolean;
};

export type Parsed = { global: Global; sub?: Sub; rest: string[] };

/** A lane name: ≤ 40 chars of letters, digits, ._@:+- (as an agent id). */
export function laneName(raw: string | undefined): string | undefined | Error {
  if (raw === undefined || !raw.trim()) return undefined;
  const id = raw.trim();
  return /^[A-Za-z0-9._@:+-]{1,40}$/.test(id)
    ? id
    : new Error(`not a lane name: ${raw} (≤ 40 chars of letters, digits, ._@:+-)`);
}

/**
 * argv (without the runtime and script) → global flags, the subcommand, and
 * the rest for it. Global flags may come anywhere before a `--`; everything
 * after `--` is passed on as is (a text starting with "--").
 */
export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Parsed | Error {
  const g: Global = { json: false, pair: false, help: false };
  let lane: string | undefined = env.LIANKI_LANE;
  let repo: string | undefined = env.LIANKI_REPO || undefined;
  let repoFrom: Global["repoFrom"] = repo ? "env" : undefined;
  let sub: Sub | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    const m = /^--(as|repo)(?:=(.*))?$/s.exec(a);
    if (m) {
      const v = m[2] ?? argv[++i];
      if (v === undefined) return new Error(`--${m[1]} needs a value`);
      if (m[1] === "as") lane = v;
      else [repo, repoFrom] = [v, "flag"];
    } else if (a === "--json") g.json = true;
    else if (a === "--pair") g.pair = true;
    else if (a === "--no-pair") g.pair = false;
    else if (a === "--help" || a === "-h") g.help = true;
    else if (!sub && !a.startsWith("-")) {
      if (!(SUBCOMMANDS as readonly string[]).includes(a))
        return new Error(`unknown command: ${a}`);
      sub = a as Sub;
    } else if (!sub) return new Error(`unknown option before the command: ${a}`);
    else rest.push(a);
  }
  const name = laneName(lane);
  if (name instanceof Error) return name;
  if (name && g.pair)
    return new Error(
      `a lane never pairs: --pair is for a human run without --as/LIANKI_LANE (lane: ${name})`,
    );
  if (name) g.lane = name;
  if (repo) Object.assign(g, { repo, repoFrom });
  return { global: g, ...(sub ? { sub } : {}), rest };
}

/** The lane's label on a line: 【lane】text; a text that already carries it is left alone. */
export function labelText(text: string, lane: string | undefined): string {
  if (!lane) return text;
  const tag = `【${lane}】`;
  return text.startsWith(tag) ? text : `${tag}${text}`;
}

/** say's flags that take a value: everything else not a flag is the text. */
const SAY_VALUED = new Set(["--to", "--task-path", "--agent", "--label", "--voice"]);

/**
 * The argv for `eval.ts <cmd> …` that a subcommand runs, or an Error (usage).
 * `stdin` is the text already read for `say -`. Pairing is always off unless
 * the run was given --pair.
 */
export function evalArgv(sub: Sub, rest: string[], g: Global, stdin?: string): string[] | Error {
  const pair = g.pair ? [] : ["--no-pair"];
  if (sub === "say") {
    const out: string[] = [];
    let text: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--") {
        text = rest.slice(i + 1).join(" ");
        break;
      }
      if (SAY_VALUED.has(a)) {
        const v = rest[++i];
        if (v === undefined) return new Error(`${a} needs a value`);
        out.push(a, v);
      } else if (a === "--quiet" || a === "--loud") out.push(a);
      else if (a.startsWith("--")) return new Error(`say: unknown flag ${a}`);
      else if (text === undefined) text = a === "-" ? (stdin ?? "") : a;
      else return new Error(`say takes one text (quote it): ${a}`);
    }
    const body = (text ?? "").trim();
    if (!body) return new Error("say needs a text (or - for stdin)");
    return ["say", ...out, labelText(body, g.lane), ...pair];
  }
  if (sub === "ask") {
    const out = rest.map((a, i) => (rest[i - 1] === "--q" ? labelText(a, g.lane) : a));
    if (!out.includes("--q") || !out.includes("--opt"))
      return new Error('ask needs --q "question" and at least one --opt');
    return ["ask", ...out, ...pair];
  }
  if (sub === "withdraw") {
    const ids = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--to");
    if (ids.length > 1) return new Error("withdraw takes one askId (or --last)");
    if (!ids.length && !rest.includes("--last"))
      return new Error("withdraw needs <askId> or --last");
    for (const a of rest)
      if (a.startsWith("--") && a !== "--last" && a !== "--to")
        return new Error(`withdraw: unknown flag ${a}`);
    if (rest.at(-1) === "--to") return new Error("--to needs a value");
    return ["withdraw", ...rest, ...pair];
  }
  if (sub === "edit") {
    const out = rest.map((a) => (a === "-" && stdin !== undefined ? stdin.trim() : a));
    const has = (f: string) => out.includes(f);
    if (has("--merge") && !has("--text") && out.length !== 3)
      return new Error('edit --merge needs <id1,id2,…> and --text "passage"');
    if (
      has("--merge") &&
      (out[out.indexOf("--merge") + 1] ?? "").split(",").filter(Boolean).length < 2
    )
      return new Error("edit --merge joins two or more ids, comma-separated");
    if (has("--unmerge") && !out[out.indexOf("--unmerge") + 1])
      return new Error("edit --unmerge needs the passage's id");
    if (!out.length) return new Error("edit needs a message id (or --last) and a text");
    return ["edit", ...out, ...pair];
  }
  if (sub === "inbox") {
    const op = rest[0] ?? "list";
    if (!["list", "get", "done", "rm"].includes(op)) return new Error(`inbox: unknown op ${op}`);
    if ((op === "get" || op === "done") && !rest[1]) return new Error(`inbox ${op} needs <id>`);
    return ["inbox", ...(rest.length ? rest : ["list"]), ...pair];
  }
  if (sub === "voices") {
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--target") {
        if (rest[++i] === undefined) return new Error("--target needs a value");
      } else if (a !== "--cloud") return new Error(`voices: unknown argument ${a}`);
    }
    return ["voices", ...rest, ...pair];
  }
  if (sub === "listen") return ["chat", ...rest, ...pair];
  if (sub === "serve") return ["serve", ...rest, ...pair];
  return new Error(`${sub} does not run eval.ts`);
}

/**
 * With a lane token (LIANKI_TOKEN, made at lianki.com/my/preferences → API tokens
 * with the chat permissions): the argv for the public CLI's `lianki chat …`
 * (packages/lianki-cli), which posts as the token's name in the token
 * account's own thread. No `--to`, `--task-path`, `--agent` or `--label`:
 * those need the grant path (unset LIANKI_TOKEN). An `--opt "*Yes"` is the
 * recommended one, as with eval.ts. One question per ask.
 */
export function chatArgv(
  sub: Sub,
  rest: string[],
  stdin?: string,
): (string[] & { stdin?: string }) | Error {
  if (sub === "say") {
    let text: string | undefined;
    const out: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--") {
        text = rest.slice(i + 1).join(" ");
        break;
      }
      if (a === "--quiet") out.push(a);
      else if (a === "--loud") continue;
      else if (a.startsWith("--"))
        return new Error(`say: ${a} needs the grant path (unset LIANKI_TOKEN)`);
      else if (text === undefined) text = a === "-" ? (stdin ?? "") : a;
      else return new Error(`say takes one text (quote it): ${a}`);
    }
    const body = (text ?? "").trim();
    if (!body) return new Error("say needs a text (or - for stdin)");
    // The text goes on stdin (`-`), so one starting with "-" is never read as a flag.
    return Object.assign(["chat", "say", ...out, "-"], { stdin: body });
  }
  if (sub === "ask") {
    const out: string[] = [];
    let q = 0;
    let n = 0;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--q") {
        if (++q > 1) return new Error("ask: one --q per ask with a lane token");
        out.push(a, rest[++i] ?? "");
      } else if (a === "--opt") {
        const v = rest[++i] ?? "";
        n++;
        if (v.startsWith("*")) out.push("--opt", v.slice(1), "--recommend", String(n));
        else out.push("--opt", v);
      } else if (a === "--timeout") out.push(a, rest[++i] ?? "");
      else if (a === "--wait" || a === "--multi") out.push(a);
      else return new Error(`ask: ${a} needs the grant path (unset LIANKI_TOKEN)`);
    }
    if (!q || !n) return new Error('ask needs --q "question" and at least one --opt');
    return ["chat", "ask", ...out];
  }
  if (sub === "listen") {
    if (rest.length)
      return new Error(`listen: ${rest[0]} needs the grant path (unset LIANKI_TOKEN)`);
    return ["chat", "listen", "--json"];
  }
  return new Error(`${sub} has no lane-token path`);
}

/** progress: --agent defaults to the lane, on a report only. */
export function progressArgv(rest: string[], g: Global): string[] {
  if (!g.lane || rest.includes("--agent") || rest.some((a) => a.startsWith("--agent=")))
    return rest;
  if (["show", "resolve", "grant", "ack"].includes(rest[0] ?? "")) return rest;
  return [...rest, "--agent", g.lane];
}

/** What the entry found on this machine: no secrets, only whether things exist. */
export type Facts = {
  lane?: string;
  repo?: string;
  /** Where the checkout came from. */
  repoFrom: "flag" | "env" | "cwd" | "cli" | "none";
  mainRoot?: string;
  hub: string;
  chatGrant: boolean;
  evalGrant: boolean;
  grantDir?: string;
  /** "ok", or the error reaching the hub. */
  network: "ok" | { error: string };
  progressToken: "flag" | "env" | "dev.vars" | "none";
  /** Whether ~/.config/lianki (serve's session file) is writable. */
  sessionDirWritable: boolean;
  /** The lane's own chat token: LIANKI_TOKEN, its file (~/.config/lianki/lanes/<lane>.token), or none. */
  laneToken?: "env" | "file" | "none";
};

export type Finding = { check: string; level: "ok" | "warn" | "missing"; line: string };

/** doctor: one line per check. "missing" means say/ask/inbox cannot work here. */
export function doctorFindings(f: Facts): Finding[] {
  const out: Finding[] = [];
  out.push(
    f.repo
      ? { check: "repo", level: "ok", line: `checkout: ${f.repo} (from ${f.repoFrom})` }
      : {
          check: "repo",
          level: "missing",
          line: "no Lianki checkout: run inside a worktree of snolab/lianki, or pass --repo <path> (or LIANKI_REPO)",
        },
  );
  const grant = f.chatGrant ? "chat" : f.evalGrant ? "eval" : undefined;
  out.push(
    grant
      ? {
          check: "grant",
          level: "ok",
          line: `saved ${grant} grant present in ${f.grantDir} (the hub has the last word on whether it is still valid)`,
        }
      : {
          check: "grant",
          level: "missing",
          line: `no saved grant in ${f.grantDir ?? "the main checkout"}: a human runs \`lianki-dev listen --pair\` once and the owner taps Allow; lanes never pair`,
        },
  );
  out.push(
    f.network === "ok"
      ? { check: "network", level: "ok", line: `hub reachable: ${f.hub}` }
      : {
          check: "network",
          level: "missing",
          line: `no network to ${f.hub} (${f.network.error}): a sandboxed lane asks the main lane to post for it, or the owner relaxes its sandbox`,
        },
  );
  out.push(
    f.progressToken !== "none"
      ? { check: "progress", level: "ok", line: `progress token from ${f.progressToken}` }
      : {
          check: "progress",
          level: "warn",
          line: "no progress token (--token, LIANKI_PROGRESS_TOKEN, or PROGRESS_TOKEN in the main checkout's .dev.vars): `progress` cannot report; ask main for a scoped token",
        },
  );
  out.push(
    f.sessionDirWritable
      ? {
          check: "session-dir",
          level: "ok",
          line: "~/.config/lianki writable (serve can hold a session)",
        }
      : {
          check: "session-dir",
          level: "warn",
          line: "~/.config/lianki not writable: `serve` cannot hold a session (say/ask/inbox do not need it)",
        },
  );
  if (f.lane && f.laneToken)
    out.push(
      f.laneToken !== "none"
        ? {
            check: "lane-token",
            level: "ok",
            line: `lane token from ${f.laneToken} (say/ask/listen post as 【${f.lane}】 with it)`,
          }
        : {
            check: "lane-token",
            level: "warn",
            line: `no lane token for ${f.lane}: say/ask use the saved grant; lane-listen needs one (the owner makes it at lianki.com/my/preferences → API tokens, docs/lane-listen.md)`,
          },
    );
  out.push({
    check: "lane",
    level: "ok",
    line: f.lane
      ? `${f.lane} (lines labelled 【${f.lane}】, never pairs)`
      : "no lane (--as or LIANKI_LANE): lines go unlabelled, as the main lane",
  });
  return out;
}

/** doctor's exit: notReady if a local piece is missing, else network if only that is. */
export function doctorExit(findings: Finding[]): number {
  const missing = findings.filter((x) => x.level === "missing");
  if (!missing.length) return EXIT.ok;
  return missing.every((x) => x.check === "network") ? EXIT.network : EXIT.notReady;
}

/** Not reaching the hub, as eval.ts and fetch word it (vs. the hub saying no). */
const NETWORK =
  /unable to connect|econnrefused|enotfound|eai_again|fetch failed|timed? ?out|within 15 s|socket closed \(1006|network/i;

/**
 * eval.ts's exit (0 ok, 2 usage, 1 anything else) and its last error line →
 * this CLI's exit; a failure is told apart into network or refused.
 */
export function childExit(code: number | null, lastError = ""): number {
  if (code === 0) return EXIT.ok;
  if (code === 2) return EXIT.usage;
  return NETWORK.test(lastError) ? EXIT.network : EXIT.refused;
}

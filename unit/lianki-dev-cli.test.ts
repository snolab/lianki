// scripts/dev/lianki-dev.ts, the agent lanes' CLI (docs/lianki-dev-cli.md):
// argument parsing, the --as label, doctor's lines, exit codes and the JSON
// envelope, and one real `say` against a stub hub on 127.0.0.1.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT,
  type Facts,
  type Global,
  SUBCOMMANDS,
  USAGE,
  chatArgv,
  childExit,
  doctorExit,
  doctorFindings,
  errorLine,
  evalArgv,
  labelText,
  laneName,
  okLine,
  parseArgs,
  progressArgv,
} from "@/scripts/dev/lianki-dev-cli";

const g = (over: Partial<Global> = {}): Global => ({
  json: false,
  pair: false,
  help: false,
  ...over,
});

describe("lianki-dev: global flags", () => {
  it("takes --as, --repo, --json, --pair anywhere before --, and the subcommand", () => {
    expect(parseArgs(["say", "--as", "codex", "hi", "--json"], {})).toEqual({
      global: g({ lane: "codex", json: true }),
      sub: "say",
      rest: ["hi"],
    });
    expect(parseArgs(["--as=agy", "--repo=/x", "doctor"], {})).toEqual({
      global: g({ lane: "agy", repo: "/x", repoFrom: "flag" }),
      sub: "doctor",
      rest: [],
    });
  });
  it("reads LIANKI_LANE and LIANKI_REPO; the flag wins", () => {
    const env = { LIANKI_LANE: "judge", LIANKI_REPO: "/r" };
    expect(parseArgs(["whoami"], env)).toMatchObject({
      global: { lane: "judge", repo: "/r", repoFrom: "env" },
    });
    expect(parseArgs(["whoami", "--as", "codex", "--repo", "/s"], env)).toMatchObject({
      global: { lane: "codex", repo: "/s", repoFrom: "flag" },
    });
  });
  it("passes everything after -- on as is", () => {
    expect(parseArgs(["say", "--", "--json is literal"], {})).toMatchObject({
      global: { json: false },
      rest: ["--", "--json is literal"],
    });
  });
  it("--help with or without a command; no command at all", () => {
    expect(parseArgs(["say", "--help"], {})).toMatchObject({ sub: "say", global: { help: true } });
    expect(parseArgs(["-h"], {})).toEqual({ global: g({ help: true }), rest: [] });
    expect(parseArgs([], {})).toEqual({ global: g(), rest: [] });
  });
  it("refuses an unknown command, a flag before it, a missing value, a bad lane", () => {
    expect(parseArgs(["post"], {})).toBeInstanceOf(Error);
    expect(parseArgs(["--quiet", "say"], {})).toBeInstanceOf(Error);
    expect(parseArgs(["say", "--as"], {})).toBeInstanceOf(Error);
    expect(parseArgs(["say", "--as", "no spaces please"], {})).toBeInstanceOf(Error);
  });
  it("a lane never pairs: --pair with --as or LIANKI_LANE is a usage error", () => {
    expect((parseArgs(["listen", "--as", "codex", "--pair"], {}) as Error).message).toContain(
      "never pairs",
    );
    expect(parseArgs(["listen", "--pair"], { LIANKI_LANE: "agy" })).toBeInstanceOf(Error);
    expect(parseArgs(["listen", "--pair"], {})).toMatchObject({ global: { pair: true } });
    expect(parseArgs(["listen", "--pair", "--no-pair"], {})).toMatchObject({
      global: { pair: false },
    });
  });
  it("lane names: ≤ 40 chars of letters, digits, ._@:+-", () => {
    expect(laneName(undefined)).toBeUndefined();
    expect(laneName("  ")).toBeUndefined();
    expect(laneName("chat-fast")).toBe("chat-fast");
    expect(laneName("x".repeat(41))).toBeInstanceOf(Error);
  });
});

describe("lianki-dev: --as labelling", () => {
  it("prefixes 【lane】 once; no lane, no prefix", () => {
    expect(labelText("hello", "codex")).toBe("【codex】hello");
    expect(labelText("【codex】hello", "codex")).toBe("【codex】hello");
    expect(labelText("hello", undefined)).toBe("hello");
  });
  it("say --voice passes a line's own voice id on; voices runs eval.ts voices, never pairing", () => {
    expect(evalArgv("say", ["--voice", "device:Meijia", "你好"], g())).toEqual([
      "say",
      "--voice",
      "device:Meijia",
      "你好",
      "--no-pair",
    ]);
    expect(evalArgv("voices", [], g())).toEqual(["voices", "--no-pair"]);
    expect(evalArgv("voices", ["--cloud"], g())).toEqual(["voices", "--cloud", "--no-pair"]);
    expect(evalArgv("voices", ["--target", "iPhone"], g())).toEqual([
      "voices",
      "--target",
      "iPhone",
      "--no-pair",
    ]);
    expect(evalArgv("voices", ["--loop"], g())).toBeInstanceOf(Error);
  });
  it("say: labels the text, keeps its flags, adds --no-pair, never --quiet", () => {
    expect(evalArgv("say", ["--to", "owner", "hi there"], g({ lane: "codex" }))).toEqual([
      "say",
      "--to",
      "owner",
      "【codex】hi there",
      "--no-pair",
    ]);
    expect(evalArgv("say", ["hi"], g())).toEqual(["say", "hi", "--no-pair"]);
    expect(evalArgv("say", ["--quiet", "fyi"], g())).toEqual([
      "say",
      "--quiet",
      "fyi",
      "--no-pair",
    ]);
    expect(evalArgv("say", ["--supersede", "moot"], g())).toEqual([
      "say",
      "--supersede",
      "moot",
      "--no-pair",
    ]);
    expect(evalArgv("say", ["--interject", "urgent"], g())).toEqual([
      "say",
      "--interject",
      "urgent",
      "--no-pair",
    ]);
    expect(evalArgv("say", ["--supersede", "--interject", "x"], g())).toBeInstanceOf(Error);
    expect(evalArgv("say", ["-"], g({ lane: "agy" }), " from stdin\n")).toEqual([
      "say",
      "【agy】from stdin",
      "--no-pair",
    ]);
    expect(evalArgv("say", ["--", "--dashes"], g({ lane: "agy" }))).toEqual([
      "say",
      "【agy】--dashes",
      "--no-pair",
    ]);
  });
  it("say: usage errors", () => {
    expect(evalArgv("say", [], g())).toBeInstanceOf(Error);
    expect(evalArgv("say", ["a", "b"], g())).toBeInstanceOf(Error);
    expect(evalArgv("say", ["--to"], g())).toBeInstanceOf(Error);
    expect(evalArgv("say", ["--shout", "x"], g())).toBeInstanceOf(Error);
  });
  it("ask: labels each question, not the options", () => {
    expect(
      evalArgv("ask", ["--q", "Ship?", "--opt", "Yes", "--opt", "No"], g({ lane: "judge" })),
    ).toEqual(["ask", "--q", "【judge】Ship?", "--opt", "Yes", "--opt", "No", "--no-pair"]);
    expect(evalArgv("ask", ["--q", "Ship?"], g())).toBeInstanceOf(Error);
  });
  it("edit: --merge ids with --text, --unmerge, or a polish; maps to eval.ts edit", () => {
    expect(evalArgv("edit", ["--merge", "a,b", "--text", "one passage"], g())).toEqual([
      "edit",
      "--merge",
      "a,b",
      "--text",
      "one passage",
      "--no-pair",
    ]);
    expect(evalArgv("edit", ["--merge", "a,b", "--text", "-"], g(), "from stdin\n")).toEqual([
      "edit",
      "--merge",
      "a,b",
      "--text",
      "from stdin",
      "--no-pair",
    ]);
    expect(evalArgv("edit", ["--unmerge", "a"], g())).toEqual([
      "edit",
      "--unmerge",
      "a",
      "--no-pair",
    ]);
    expect(evalArgv("edit", ["--merge", "a", "--text", "x"], g())).toBeInstanceOf(Error);
    expect(evalArgv("edit", ["--unmerge"], g())).toBeInstanceOf(Error);
    expect(evalArgv("edit", [], g())).toBeInstanceOf(Error);
  });

  it("withdraw: one askId or --last, optional --to; maps to eval.ts withdraw", () => {
    expect(evalArgv("withdraw", ["67d29c37-d50"], g())).toEqual([
      "withdraw",
      "67d29c37-d50",
      "--no-pair",
    ]);
    expect(evalArgv("withdraw", ["--last", "--to", "owner"], g())).toEqual([
      "withdraw",
      "--last",
      "--to",
      "owner",
      "--no-pair",
    ]);
    expect(evalArgv("withdraw", [], g())).toBeInstanceOf(Error);
    expect(evalArgv("withdraw", ["a", "b"], g())).toBeInstanceOf(Error);
    expect(evalArgv("withdraw", ["a", "--zap"], g())).toBeInstanceOf(Error);
    expect(evalArgv("withdraw", ["a", "--to"], g())).toBeInstanceOf(Error);
    expect(SUBCOMMANDS).toContain("withdraw");
  });
  it("inbox, listen, serve: map to eval.ts; --pair drops --no-pair", () => {
    expect(evalArgv("inbox", [], g())).toEqual(["inbox", "list", "--no-pair"]);
    expect(evalArgv("inbox", ["get", "abc"], g())).toEqual(["inbox", "get", "abc", "--no-pair"]);
    expect(evalArgv("inbox", ["get"], g())).toBeInstanceOf(Error);
    expect(evalArgv("inbox", ["zap"], g())).toBeInstanceOf(Error);
    expect(evalArgv("listen", ["--ack"], g())).toEqual(["chat", "--ack", "--no-pair"]);
    expect(evalArgv("listen", [], g({ pair: true }))).toEqual(["chat"]);
    expect(evalArgv("serve", [], g())).toEqual(["serve", "--no-pair"]);
    expect(evalArgv("doctor", [], g())).toBeInstanceOf(Error);
  });
  it("progress: --agent defaults to the lane, on a report only", () => {
    expect(progressArgv(["--task", "t", "--status", "doing"], g({ lane: "codex" }))).toEqual([
      "--task",
      "t",
      "--status",
      "doing",
      "--agent",
      "codex",
    ]);
    expect(progressArgv(["--agent", "x"], g({ lane: "codex" }))).toEqual(["--agent", "x"]);
    expect(progressArgv(["--agent=x"], g({ lane: "codex" }))).toEqual(["--agent=x"]);
    expect(progressArgv(["show"], g({ lane: "codex" }))).toEqual(["show"]);
    expect(progressArgv(["grant", "--node", "/a"], g({ lane: "c" }))).toEqual([
      "grant",
      "--node",
      "/a",
    ]);
    expect(progressArgv(["--task", "t"], g())).toEqual(["--task", "t"]);
  });
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  repo: "/repo",
  repoFrom: "cwd",
  mainRoot: "/main",
  hub: "https://lianki.com",
  chatGrant: true,
  evalGrant: false,
  grantDir: "/main",
  network: "ok",
  progressToken: "dev.vars",
  sessionDirWritable: true,
  ...over,
});

describe("lianki-dev doctor", () => {
  it("all present: every line ok, exit 0", () => {
    const f = doctorFindings(facts({ lane: "codex" }));
    expect(f.every((x) => x.level === "ok")).toBe(true);
    expect(f.find((x) => x.check === "lane")!.line).toContain("【codex】");
    expect(doctorExit(f)).toBe(EXIT.ok);
  });
  it("a read-only sandboxed lane: no network, no token, no session dir — one line each, exit 4", () => {
    const f = doctorFindings(
      facts({
        network: { error: "Unable to connect" },
        progressToken: "none",
        sessionDirWritable: false,
      }),
    );
    const by = Object.fromEntries(f.map((x) => [x.check, x]));
    expect(by.network!.level).toBe("missing");
    expect(by.network!.line).toContain("asks the main lane to post");
    expect(by.progress!.level).toBe("warn");
    expect(by["session-dir"]!.level).toBe("warn");
    expect(f.every((x) => !x.line.includes("\n"))).toBe(true);
    expect(doctorExit(f)).toBe(EXIT.network);
  });
  it("no grant, or no checkout: missing, exit 2; the eval grant also counts", () => {
    const none = doctorFindings(facts({ chatGrant: false, network: { error: "x" } }));
    expect(none.find((x) => x.check === "grant")!.line).toContain("lanes never pair");
    expect(doctorExit(none)).toBe(EXIT.notReady);
    expect(
      doctorFindings(facts({ chatGrant: false, evalGrant: true })).find((x) => x.check === "grant")!
        .level,
    ).toBe("ok");
    const noRepo = doctorFindings(
      facts({ repo: undefined, repoFrom: "none", grantDir: undefined, chatGrant: false }),
    );
    expect(noRepo.find((x) => x.check === "repo")!.line).toContain("--repo");
    expect(noRepo.find((x) => x.check === "grant")!.line).toContain("the main checkout");
    expect(doctorFindings(facts()).find((x) => x.check === "lane")!.line).toContain("no lane");
  });
});

describe("lianki-dev: exit codes, JSON and help", () => {
  it("eval.ts's 0 and 2 map to ok and usage; its 1 to network or refused by its last line", () => {
    expect(childExit(0)).toBe(EXIT.ok);
    expect(childExit(2)).toBe(EXIT.usage);
    expect(childExit(1, "Unable to connect. Is the computer able to access the url?")).toBe(
      EXIT.network,
    );
    expect(childExit(1, "no answer from the hub within 15 s")).toBe(EXIT.network);
    expect(childExit(1, "socket closed (4498 grant invalid)")).toBe(EXIT.refused);
    expect(childExit(null)).toBe(EXIT.refused);
  });
  it("the envelope is the npm lianki CLI's: v, ok, command/data or error/exit", () => {
    expect(JSON.parse(okLine("say", { type: "said" }))).toEqual({
      v: 1,
      ok: true,
      command: "say",
      data: { type: "said" },
    });
    expect(JSON.parse(errorLine(EXIT.notReady, "no grant"))).toEqual({
      v: 1,
      ok: false,
      error: { code: "not_ready", message: "no grant" },
      exit: 2,
    });
    expect(JSON.parse(errorLine(9, "?")).error.code).toBe("refused");
  });
  it("every command has a usage that names the exit codes", () => {
    for (const s of SUBCOMMANDS) expect(USAGE[s]).toStartWith(`usage: lianki-dev ${s}`);
    for (const s of SUBCOMMANDS.filter((x) => x !== "help"))
      expect(USAGE[s]).toContain("5 refused");
  });
});

describe("lianki-dev say against a stub hub", () => {
  const dir = mkdtempSync(join(tmpdir(), "lianki-dev-"));
  const got: Record<string, unknown>[] = [];
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (
          new URL(req.url).pathname === "/api/version/debug/control" &&
          srv.upgrade(req, { data: undefined })
        )
          return undefined;
        return new Response("stub", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: "approved", until: Date.now() + 60_000 }));
        },
        message(ws, data) {
          got.push(JSON.parse(String(data)) as Record<string, unknown>);
          ws.send(JSON.stringify({ type: "said", id: "m1" }));
        },
      },
    });
  });
  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  /** The entry as a lane runs it, async: the stub answers from this same process. */
  const run = async (args: string[], grant: boolean) => {
    const chat = join(dir, grant ? "chat.json" : "absent.json");
    if (grant) writeFileSync(chat, JSON.stringify({ token: "stub-token" }), { mode: 0o600 });
    const env: Record<string, string | undefined> = {
      ...process.env,
      LIANKI_URL: `http://127.0.0.1:${server.port}`,
      LIANKI_CHAT_TOKEN_FILE: chat,
      LIANKI_EVAL_TOKEN_FILE: join(dir, "absent-eval.json"),
      LIANKI_LANE: undefined,
      // Never this Mac's real lane tokens (~/.config/lianki/lanes), nor one in the env.
      LIANKI_TOKEN: undefined,
      LIANKI_LANE_TOKEN_DIR: join(dir, "no-lanes"),
    };
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "scripts", "dev", "lianki-dev.ts"), ...args],
      { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  it("sends 【lane】text and prints the hub's answer, exit 0", async () => {
    const r = await run(["say", "--as", "codex", "hello from a stub"], true);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ type: "said", id: "m1" });
    expect(got.at(-1)).toEqual({ type: "say", text: "【codex】hello from a stub" });
  }, 20_000);
  it("--json wraps it in the envelope", async () => {
    const r = await run(["say", "--as", "codex", "--json", "again"], true);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      v: 1,
      ok: true,
      command: "say",
      data: { type: "said", id: "m1" },
    });
  }, 20_000);
  it("no saved grant: exit 2 with doctor's line on stderr, nothing sent", async () => {
    const before = got.length;
    const r = await run(["say", "--as", "codex", "--json", "x"], false);
    expect(r.exitCode).toBe(EXIT.notReady);
    expect(r.stdout).toBe("");
    expect(JSON.parse(r.stderr)).toMatchObject({ ok: false, error: { code: "not_ready" } });
    expect(got.length).toBe(before);
  }, 20_000);
  it("bad arguments: exit 1; --help: exit 0", async () => {
    expect((await run(["say"], true)).exitCode).toBe(EXIT.usage);
    expect((await run(["say", "--help"], true)).exitCode).toBe(EXIT.ok);
  }, 20_000);
});

describe("lane token: say/ask/listen through lianki chat", () => {
  it("say sends the text on stdin; flags of the grant path are refused", () => {
    const a = chatArgv("say", ["--quiet", "-x looks like a flag"]);
    if (a instanceof Error) throw a;
    expect([...a]).toEqual(["chat", "say", "--quiet", "-"]);
    expect(a.stdin).toBe("-x looks like a flag");
    expect(chatArgv("say", ["--voice", "main", "hi"])).toEqual(
      expect.arrayContaining(["--voice", "main"]),
    );
    expect(chatArgv("say", ["--voice=calm", "hi"])).toEqual(
      expect.arrayContaining(["--voice", "calm"]),
    );
    expect(chatArgv("say", ["--voice"])).toBeInstanceOf(Error);
    expect(chatArgv("say", ["--to", "bob@x.com", "hi"])).toBeInstanceOf(Error);
    const s = chatArgv("say", ["--supersede", "moot"]);
    if (s instanceof Error) throw s;
    expect([...s]).toEqual(["chat", "say", "--supersede", "-"]);
    const i = chatArgv("say", ["--interject", "urgent"]);
    if (i instanceof Error) throw i;
    expect([...i]).toEqual(["chat", "say", "--interject", "-"]);
    expect(chatArgv("say", ["--supersede", "--interject", "x"])).toBeInstanceOf(Error);
    expect(chatArgv("say", [])).toBeInstanceOf(Error);
  });
  it("ask: one question, *option is the recommended one, --wait passes", () => {
    expect(chatArgv("ask", ["--q", "Ship?", "--opt", "*Yes", "--opt", "No", "--wait"])).toEqual([
      "chat",
      "ask",
      "--q",
      "Ship?",
      "--opt",
      "Yes",
      "--recommend",
      "1",
      "--opt",
      "No",
      "--wait",
    ]);
    expect(chatArgv("ask", ["--q", "a", "--opt", "x", "--q", "b", "--opt", "y"])).toBeInstanceOf(
      Error,
    );
    expect(chatArgv("ask", ["--to", "x", "--q", "a", "--opt", "x"])).toBeInstanceOf(Error);
  });
  it("listen is the JSON stream; serve and inbox have no token path", () => {
    expect(chatArgv("listen", [])).toEqual(["chat", "listen", "--json"]);
    expect(chatArgv("serve", [])).toBeInstanceOf(Error);
    expect(chatArgv("inbox", [])).toBeInstanceOf(Error);
  });
});

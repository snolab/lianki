// scripts/dev/stall-watch.ts (docs/lane-listen.md, "Stall watch"): the
// prompt matcher, redaction, the blocked node it writes and the per-agent
// state machine. Fake secrets only.
import { describe, expect, it } from "bun:test";
import {
  StallTracker,
  classifyScreen,
  cleanLine,
  laneOf,
  parseAyLine,
  redact,
  reportFor,
  stallConfig,
  staleNodes,
} from "../scripts/dev/stall-watch-lib";

const CLAUDE_PERMISSION = `
⏺ Bash(rm -rf node_modules && bun install)
╭──────────────────────────────────────────────╮
│ Bash command                                 │
│                                              │
│   rm -rf node_modules && bun install         │
│                                              │
│ Do you want to proceed?                      │
│ ❯ 1. Yes                                     │
│   2. Yes, and don't ask again for rm commands │
│   3. No, and tell Claude what to do differently (esc) │
╰──────────────────────────────────────────────╯
`;

const CODEX_APPROVAL = `
• Running git push origin lane/x

  Would you like to run the following command?

  $ git push origin lane/x

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (a)
  3. No, and tell Codex what to do differently (esc)
`;

const CLAUDE_IDLE = `
⏺ Done. PR #870 is merged and deployed.

✻ Brewed for 45s · done 12:44 AM · 2 shells still running
                                           new task? /clear to save 168.7k tokens
──────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────
  ⏵⏵ auto mode on · 2 shells · ← 1 agent · ↓ to manage
`;

const CODEX_IDLE = `
• Worked for 6s — 13:26

› Ask Codex to do anything

  GPT-6.1-Sol default · ~/ws/snolab/lianki/tree/codex · Review Lianki PR design
  ? for shortcuts
`;

describe("classifyScreen", () => {
  it("Claude's permission box is a prompt, quoted by its question", () => {
    expect(classifyScreen(CLAUDE_PERMISSION)).toEqual({
      kind: "prompt",
      pattern: "menu-yes",
      line: "Do you want to proceed?",
    });
  });
  it("Codex approval is a prompt", () => {
    const v = classifyScreen(CODEX_APPROVAL);
    expect(v?.kind).toBe("prompt");
    expect(v?.line).toBe("Would you like to run the following command?");
  });
  it("sudo, a passphrase, a keychain dialog, [y/N], press enter", () => {
    expect(classifyScreen("$ sudo pmset -a\n[sudo] password for taku:")?.kind).toBe("prompt");
    expect(classifyScreen("Password:")?.kind).toBe("prompt");
    expect(classifyScreen("Enter passphrase for key '/Users/x/.ssh/id_ed25519':")).toMatchObject({
      kind: "prompt",
      pattern: "passphrase",
    });
    expect(classifyScreen('codesign wants to access key "x" in your keychain.')?.kind).toBe(
      "prompt",
    );
    expect(classifyScreen("Overwrite file? [y/N]")).toMatchObject({
      kind: "prompt",
      pattern: "y-n",
    });
    expect(classifyScreen("Press Enter to continue")?.kind).toBe("prompt");
    expect(classifyScreen("Do you trust the files in this folder?")?.kind).toBe("prompt");
  });
  it("an idle Claude or Codex screen is nothing", () => {
    expect(classifyScreen(CLAUDE_IDLE)).toBeNull();
    expect(classifyScreen(CODEX_IDLE)).toBeNull();
    expect(classifyScreen("")).toBeNull();
  });
  it("a turn that ends in a question is a question (reported only after the quiet time)", () => {
    const v = classifyScreen(
      `⏺ I rebased #812. Should I also bump the userscript @version?\n${CLAUDE_IDLE.split("\n").slice(3).join("\n")}`,
    );
    expect(v).toEqual({
      kind: "question",
      line: "⏺ I rebased #812. Should I also bump the userscript @version?",
    });
    expect(classifyScreen("要我现在合并吗？")?.kind).toBe("question");
  });
  it("a question far above the bottom does not count", () => {
    expect(classifyScreen("Ready?\nline 1\nline 2\nline 3\nline 4\nline 5")).toBeNull();
  });
  it("an old prompt that scrolled up does not count", () => {
    const later = Array.from({ length: 20 }, (_, i) => `step ${i} ok`).join("\n");
    expect(classifyScreen(`${CLAUDE_PERMISSION}\n${later}`)).toBeNull();
  });
  it("a spinner at the bottom means working, not waiting", () => {
    expect(classifyScreen("Overwrite? [y/N]\n✶ Thinking… (12s · esc to interrupt)")).toBeNull();
  });
  it("cleanLine drops escapes and box borders", () => {
    expect(cleanLine("\x1b[1m│ ❯ 1. Yes │\x1b[0m")).toBe("❯ 1. Yes");
  });
});

describe("redact", () => {
  const cases: [string, string][] = [
    [`export LIANKI_TOKEN=lk_${"ab".repeat(32)}`, "‹redacted›"],
    [`curl -H "Authorization: ${"Bea" + "rer"} ${"abcdefgh"}ijklmnop1234"`, "Bearer ‹redacted›"],
    [`git push https://x:ghp_${"A1b2".repeat(9)}@github.com/a/b`, "‹redacted›"],
    [`sk-ant-${"x9Y".repeat(12)}`, "‹redacted›"],
    [`${"xo" + "xb"}-1234567890-abcdefghij`, "‹redacted›"],
    [`${"AK" + "IA"}ABCDEFGHIJKLMNOP`, "‹redacted›"],
    [
      `${"ey" + "J"}hbGciOiJIUzI1NiJ9.${"ey" + "J"}zdWIiOiIxMjM0NTY3ODkwIn0.sig_sig_sig`,
      "‹redacted›",
    ],
    [`open https://lianki.com/login?${"tok" + "en"}=abc123def456&x=1`, "?token=‹redacted›&x=1"],
    [`${"pass" + "word"}: hunter2hunter2`, "password: ‹redacted›"],
    [`mail someone@example.com now`, "mail ‹redacted› now"],
    [`hash ${"0f".repeat(20)}`, "hash ‹redacted›"],
  ];
  for (const [input, want] of cases)
    it(`hides ${input.slice(0, 24)}…`, () => {
      const out = redact(input);
      expect(out).toContain(want);
      expect(out).not.toMatch(/ab{0}abab|ghp_A|hunter2|abc123def456|example\.com/);
    });
  it("leaves an ordinary prompt alone", () => {
    expect(redact("Do you want to proceed?")).toBe("Do you want to proceed?");
    expect(redact("git push origin lane/release-1109")).toBe("git push origin lane/release-1109");
  });
});

describe("reportFor", () => {
  it("a blocked node for main, named within 20 columns, needs redacted and ≤ 120", () => {
    const r = reportFor(
      { pid: 52435, cwd: "/Users/owner/ws/snolab/lianki/tree/codex", cli: "codex" },
      {
        kind: "prompt",
        pattern: "sudo",
        line: `run with token=lk_${"cd".repeat(40)} ${"x".repeat(200)}`,
      },
    );
    expect(r.path).toBe("/infra/agent-stall-watch/codex-52435");
    expect(r.who).toBe("main");
    expect(r.task.split(":")[0]).toBe("codex 等确认");
    expect(r.needs.startsWith("codex waits on a prompt: run with token=‹redacted›")).toBe(true);
    expect(r.needs.length).toBeLessThanOrEqual(120);
  });
  it("the coordinator itself stuck goes to the owner; long lane names are cut", () => {
    expect(
      reportFor({ pid: 1, cwd: "/x/tree/main", cli: "claude" }, { kind: "question", line: "ok?" })
        .who,
    ).toBe("owner");
    const name = reportFor(
      { pid: 2, cwd: "/x/tree/a-very-long-lane-name", cli: "claude" },
      { kind: "question", line: "?" },
    ).task.split(":")[0]!;
    expect(name.length + 2).toBeLessThanOrEqual(20); // 等确认 is 6 columns for 3 chars
  });
  it("laneOf", () => {
    expect(laneOf("/Users/owner/ws/snolab/lianki/tree/chat-fast")).toBe("chat-fast");
    expect(laneOf("/Users/owner/ws/snolab/liagent")).toBe("liagent");
  });
});

describe("StallTracker", () => {
  const cfg = stallConfig({});
  const ev = (state: string, question: string | null = null) => ({
    ts: 0,
    pid: 7,
    cli: "claude",
    cwd: "/x/tree/codex",
    state,
    question,
  });

  it("a prompt: read on the idle edge, wait the grace, read again, report once", () => {
    const t = new StallTracker(cfg);
    expect(t.onEvent(ev("idle"))).toEqual([
      { do: "cancel", pid: 7 },
      { do: "read", pid: 7, why: "settled" },
    ]);
    expect(t.onTail(7, "settled", CLAUDE_PERMISSION)).toEqual([
      { do: "timer", pid: 7, ms: cfg["stallWatch.promptGraceSec"] * 1000, why: "grace" },
    ]);
    expect(t.onTimer(7, "grace")).toEqual([{ do: "read", pid: 7, why: "grace" }]);
    const rep = t.onTail(7, "grace", CLAUDE_PERMISSION, 1_000_000);
    expect(rep).toHaveLength(1);
    expect(rep[0]).toMatchObject({ do: "report", report: { who: "main" } });
    // Same screen on the next edge: already told.
    t.onEvent(ev("idle"));
    expect(t.onTail(7, "settled", CLAUDE_PERMISSION)).toEqual([]);
  });

  it("the screen changed before the grace ran out: nothing", () => {
    const t = new StallTracker(cfg);
    t.onEvent(ev("idle"));
    t.onTail(7, "settled", CLAUDE_PERMISSION);
    expect(t.onTail(7, "grace", CLAUDE_IDLE)).toEqual([]);
  });

  it("a question waits the quiet time, not the grace", () => {
    const t = new StallTracker(cfg);
    t.onEvent(ev("idle"));
    expect(t.onTail(7, "settled", "Merge it now?")).toEqual([
      { do: "timer", pid: 7, ms: cfg["stallWatch.quietMin"] * 60_000, why: "quiet" },
    ]);
  });

  it("output again: re-read after the confirm delay, then clear", () => {
    const t = new StallTracker(cfg);
    t.onEvent(ev("idle"));
    t.onTail(7, "settled", CLAUDE_PERMISSION);
    t.onTail(7, "grace", CLAUDE_PERMISSION);
    expect(t.onEvent(ev("active"))).toEqual([
      { do: "cancel", pid: 7 },
      { do: "timer", pid: 7, ms: cfg["stallWatch.clearConfirmSec"] * 1000, why: "clear" },
    ]);
    expect(t.onTail(7, "clear", CLAUDE_IDLE)).toEqual([
      { do: "clear", pid: 7, path: "/infra/agent-stall-watch/codex-7", why: "screen moved on" },
    ]);
    expect(t.reported()).toEqual([]);
  });

  it("a brief redraw that still shows the prompt does not clear it", () => {
    const t = new StallTracker(cfg);
    t.onEvent(ev("idle"));
    t.onTail(7, "settled", CLAUDE_PERMISSION);
    t.onTail(7, "grace", CLAUDE_PERMISSION);
    t.onEvent(ev("active"));
    expect(t.onTail(7, "clear", CLAUDE_PERMISSION)).toEqual([]);
    expect(t.reported()).toHaveLength(1);
  });

  it("the agent exits: clear", () => {
    const t = new StallTracker(cfg);
    t.onEvent(ev("idle"));
    t.onTail(7, "settled", CLAUDE_PERMISSION);
    t.onTail(7, "grace", CLAUDE_PERMISSION);
    expect(t.onEvent(ev("stopped"))).toContainEqual({
      do: "clear",
      pid: 7,
      path: "/infra/agent-stall-watch/codex-7",
      why: "agent exited",
    });
  });

  it("ay's needs_input question stands in when no pattern matches", () => {
    const t = new StallTracker(cfg);
    t.onEvent(ev("needs_input", "Pick a plan • 1. A • 2. B"));
    expect(t.onTail(7, "settled", "something odd")[0]).toMatchObject({ do: "timer", why: "grace" });
    expect(t.onTail(7, "grace", "something odd")[0]).toMatchObject({
      do: "report",
      verdict: { pattern: "ay-needs-input", line: "Pick a plan" },
    });
  });

  it("a prompt that flaps is reported at most once per gap", () => {
    const t = new StallTracker(cfg);
    t.onEvent(ev("idle"));
    t.onTail(7, "settled", CLAUDE_PERMISSION);
    t.onTail(7, "grace", CLAUDE_PERMISSION, 0);
    t.onEvent(ev("active"));
    t.onTail(7, "clear", CLAUDE_IDLE);
    t.onEvent(ev("idle"));
    t.onTail(7, "settled", "Overwrite? [y/N]");
    const gap = cfg["stallWatch.reportGapSec"] * 1000;
    expect(t.onTail(7, "grace", "Overwrite? [y/N]", 60_000)).toEqual([
      { do: "timer", pid: 7, ms: gap - 60_000, why: "gap" },
    ]);
    expect(t.onTail(7, "grace", "Overwrite? [y/N]", gap + 1)[0]).toMatchObject({ do: "report" });
  });
});

describe("plumbing", () => {
  it("stallConfig: env overrides a positive number only", () => {
    expect(stallConfig({ LIANKI_STALL_QUIET_MIN: "15" })["stallWatch.quietMin"]).toBe(15);
    expect(stallConfig({ LIANKI_STALL_QUIET_MIN: "-1" })["stallWatch.quietMin"]).toBe(10);
  });
  it("parseAyLine skips the banner", () => {
    expect(parseAyLine("watching agents every 2s… (Ctrl-C to stop)")).toBeNull();
    expect(
      parseAyLine(
        '{"ts":1,"pid":8803,"cli":"codex","cwd":"/x","state":"idle","question":null,"prev_state":null}',
      ),
    ).toEqual({ ts: 1, pid: 8803, cli: "codex", cwd: "/x", state: "idle", question: null });
  });
  it("staleNodes: only open nodes stall-watch made under its path", () => {
    expect(
      staleNodes({
        entries: [
          { id: "/infra/agent-stall-watch", task: "x", status: "doing", creator: "main" },
          {
            id: "/infra/agent-stall-watch/codex-1",
            task: "a",
            status: "blocked",
            creator: "stall-watch",
          },
          {
            id: "/infra/agent-stall-watch/agy-2",
            task: "b",
            status: "done",
            creator: "stall-watch",
          },
        ],
      }),
    ).toEqual([{ id: "/infra/agent-stall-watch/codex-1", task: "a" }]);
  });
});

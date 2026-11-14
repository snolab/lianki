/**
 * The live speech line (live-speech.ts, owner 2026-11-14): while he speaks,
 * the recognised words are his newest log line, not a draft in the input.
 * The pure rules here; DebugChat mounted in happy-dom in its own process
 * (unit/support/debug-chat-mount.tsx): it renders its log and the live line.
 */
import { describe, expect, it } from "bun:test";
import {
  HOLD_MS,
  LIVE_ID,
  echoed,
  holdOf,
  liveHolds,
  liveSpeech,
  spokenPending,
  takesSpoken,
} from "../packages/debug-chat/src/live-speech";
import type { ChatMessage } from "../packages/debug-chat/src/wire";

const line = (id: string, text: string, from: ChatMessage["from"] = "owner"): ChatMessage => ({
  id,
  from,
  label: from,
  text,
  at: 1,
});

describe("where spoken words show", () => {
  it("a pure spoken draft is the bubble, the input empty", () => {
    expect(spokenPending("Hello.", "Hello.")).toBe(true);
    expect(spokenPending("Hello.", null)).toBe(false);
    expect(spokenPending(" ", " ")).toBe(false);
    expect(spokenPending("Hello. x", "Hello.")).toBe(false);
    expect(
      liveSpeech({ draft: "Hello.", pureDictation: "Hello.", interim: "how are", inInput: false }),
    ).toEqual({ bubble: { text: "Hello.", tail: " how are" }, input: "" });
    // CJK: no space between the settled words and the tail.
    expect(
      liveSpeech({ draft: "你好。", pureDictation: "你好。", interim: "我想", inInput: false })
        .bubble,
    ).toEqual({ text: "你好。", tail: "我想" });
  });

  it("an empty draft: the interim alone is the bubble; nothing heard, no bubble", () => {
    expect(liveSpeech({ draft: "", pureDictation: null, interim: "…", inInput: false })).toEqual({
      bubble: { text: "", tail: "…" },
      input: "",
    });
    expect(liveSpeech({ draft: "", pureDictation: null, interim: "", inInput: false })).toEqual({
      bubble: null,
      input: "",
    });
    expect(
      liveSpeech({ draft: "", pureDictation: null, interim: "  ", inInput: false }).bubble,
    ).toBe(null);
  });

  it("typed text in the draft, or taken into the input: all in the input, no bubble", () => {
    expect(
      liveSpeech({ draft: "typed", pureDictation: null, interim: "spoken", inInput: false }),
    ).toEqual({ bubble: null, input: "typed" });
    expect(
      liveSpeech({ draft: "Hello.", pureDictation: "Hello.", interim: "more", inInput: true }),
    ).toEqual({ bubble: null, input: "Hello." });
  });

  it("which keys take the spoken words into the input", () => {
    expect(takesSpoken("a")).toBe(true);
    expect(takesSpoken("あ")).toBe(true);
    expect(takesSpoken(" ")).toBe(true);
    expect(takesSpoken("Backspace")).toBe(true);
    expect(takesSpoken("Delete")).toBe(true);
    expect(takesSpoken("Unidentified")).toBe(true);
    expect(takesSpoken("Process")).toBe(true);
    expect(takesSpoken("Enter")).toBe(false);
    expect(takesSpoken("Tab")).toBe(false);
    expect(takesSpoken("ArrowUp")).toBe(false);
    expect(takesSpoken("Shift")).toBe(false);
    expect(takesSpoken("c", { meta: true })).toBe(false);
    expect(takesSpoken("v", { ctrl: true })).toBe(false);
  });
});

describe("a sent spoken line until its echo", () => {
  const before = [line("a1", "Earlier."), line("g1", "Reply.", "agent")];
  it("records the owner lines there at the send", () => {
    const h = holdOf(1, "Hello there.", before, 1000);
    expect(h).toEqual({ key: 1, text: "Hello there.", at: 1000, seen: ["a1"] });
    expect(holdOf(2, "x", before, 1, "a1").continues).toBe("a1");
  });

  it("is echoed by a new owner line with its text, not an old one or the agent's", () => {
    const h = holdOf(1, "Hello there.", before, 1000);
    expect(echoed(before, h)).toBe(false);
    expect(echoed([...before, line("g2", "Hello there.", "agent")], h)).toBe(false);
    expect(echoed([...before, line("o2", "Hello  there.")], h)).toBe(true);
    // A friend's page: its own lines are "friend".
    expect(echoed([...before, line("f2", "Hello there.", "friend")], h)).toBe(true);
    // Already there before the send (same words said twice): not the echo.
    const twice = [...before, line("o2", "Hello there.")];
    expect(echoed(twice, holdOf(3, "Hello there.", twice, 1))).toBe(false);
  });

  it("an amendment echoes in the line it continues", () => {
    const h = holdOf(1, "And more.", before, 1000, "a1");
    expect(echoed(before, h)).toBe(false);
    expect(echoed([line("a1", "Earlier. And more.")], h)).toBe(true);
  });

  it("is dropped at its echo or after HOLD_MS", () => {
    const h = holdOf(1, "Hi.", before, 1000);
    expect(liveHolds([h], before, 1000 + HOLD_MS - 1)).toEqual([h]);
    expect(liveHolds([h], before, 1000 + HOLD_MS)).toEqual([]);
    expect(liveHolds([h], [...before, line("o9", "Hi.")], 1001)).toEqual([]);
  });

  it("never takes a hub id", () => {
    expect(LIVE_ID).not.toMatch(/^[0-9a-f-]{12}$/);
  });
});

describe("DebugChat mounts", () => {
  // In its own process, outside the coverage gate (see unit/support/debug-chat-mount.tsx).
  it("renders its log and the live line (unit/support/debug-chat-mount.tsx)", () => {
    const r = Bun.spawnSync(
      ["bun", "test", "./debug-chat-mount.tsx"],
      // From unit/support: the root bunfig (coverage on, its 90% gate) is not read there.
      { cwd: `${import.meta.dir}/support`, stdout: "pipe", stderr: "pipe" },
    );
    const out = `${r.stdout.toString()}${r.stderr.toString()}`;
    if (r.exitCode !== 0) console.error(out);
    expect(r.exitCode).toBe(0);
    expect(out).toMatch(/\b3 pass\b/);
    expect(out).toMatch(/\b0 fail\b/);
  }, 60_000);
});

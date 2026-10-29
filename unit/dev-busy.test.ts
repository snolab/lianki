import { describe, expect, it } from "bun:test";
import {
  BUSY_EVERY_MAX,
  BUSY_MAX_S,
  beatMessage,
  endsBeat,
  parseBusyArgs,
} from "@/scripts/dev/busy";

describe("eval.ts busy: arguments", () => {
  it("one beat by default; --every loops and stops at the agent's reply", () => {
    expect(parseBusyArgs([])).toEqual({ untilSay: true, maxSeconds: BUSY_MAX_S });
    expect(parseBusyArgs(["--every", "4", "--to", "f@x.com", "--label", "fixing"])).toEqual({
      every: 4,
      to: "f@x.com",
      label: "fixing",
      untilSay: true,
      maxSeconds: BUSY_MAX_S,
    });
    expect(parseBusyArgs(["--every", "0.2", "--keep", "--max", "60"])).toEqual({
      every: 1,
      untilSay: false,
      maxSeconds: 60,
    });
    expect(parseBusyArgs(["--keep", "--until-say"])).toMatchObject({ untilSay: true });
  });

  it("refuses what would break the spinner or is not understood", () => {
    expect(parseBusyArgs(["--every", String(BUSY_EVERY_MAX + 1)])).toEqual({
      error: `--every must be at most ${BUSY_EVERY_MAX} s, or the spinner lapses`,
    });
    expect(parseBusyArgs(["--every", "soon"])).toEqual({
      error: "--every needs a number of seconds",
    });
    expect(parseBusyArgs(["--max", "-1"])).toEqual({ error: "--max needs a number of seconds" });
    expect(parseBusyArgs(["--to"])).toEqual({ error: "--to needs a value" });
    expect(parseBusyArgs(["--label", "--keep"])).toEqual({ error: "--label needs a value" });
    expect(parseBusyArgs(["now"])).toEqual({ error: "unknown argument now" });
  });
});

describe("eval.ts busy: wire", () => {
  it("beatMessage carries only what was given", () => {
    expect(JSON.parse(beatMessage({}))).toEqual({ type: "busy" });
    expect(JSON.parse(beatMessage({ to: "f@x.com", label: "x" }))).toEqual({
      type: "busy",
      to: "f@x.com",
      label: "x",
    });
  });

  it("endsBeat: an agent reply in the beat's own thread, nothing else", () => {
    const chat = (from: string, thread?: string) => ({
      type: "chat",
      message: { from, text: "t", ...(thread ? { thread } : {}) },
    });
    expect(endsBeat(chat("agent", "owner"), "owner")).toBe(true);
    expect(endsBeat(chat("agent"), "owner")).toBe(true);
    expect(endsBeat(chat("agent", "f1"), "f1")).toBe(true);
    expect(endsBeat(chat("agent", "f1"), "owner")).toBe(false);
    expect(endsBeat(chat("owner", "owner"), "owner")).toBe(false);
    expect(endsBeat(chat("agent", "owner"), undefined)).toBe(false);
    expect(endsBeat({ type: "history", messages: [] }, "owner")).toBe(false);
    expect(endsBeat({ type: "chat" }, "owner")).toBe(false);
  });
});

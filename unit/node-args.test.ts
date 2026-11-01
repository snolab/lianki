import { describe, expect, it } from "bun:test";
import { LOUD_DEPRECATED, chatLine, nodeOpts, sayVolume } from "@/scripts/dev/node-args";

describe("eval.ts say --quiet", () => {
  it("--quiet is sent as quiet: true; without it, nothing", () => {
    expect(sayVolume({ quiet: true })).toEqual({ quiet: true });
    expect(sayVolume({ quiet: false })).toEqual({});
  });
  it("--loud is a deprecated no-op: eval.ts only prints a note", () => {
    expect(LOUD_DEPRECATED).toContain("deprecated");
  });
});

describe("eval.ts --task-path / --agent", () => {
  it("reads the flags, else LIANKI_TASK_PATH / LIANKI_AGENT", () => {
    expect(nodeOpts({ taskPath: "/words › prefetch", agent: "pf" }, {})).toEqual({
      node: "/words/prefetch",
      agent: "pf",
    });
    expect(nodeOpts({}, { LIANKI_TASK_PATH: "/home", LIANKI_AGENT: "h1" })).toEqual({
      node: "/home",
      agent: "h1",
    });
    expect(nodeOpts({ taskPath: "/a" }, { LIANKI_TASK_PATH: "/b" })).toEqual({ node: "/a" });
    expect(nodeOpts({}, {})).toEqual({});
    expect(nodeOpts({ taskPath: "/" }, {})).toEqual({});
  });
  it("refuses a bad path or agent id", () => {
    expect(nodeOpts({ taskPath: "/a b" }, {})).toHaveProperty("error");
    expect(nodeOpts({ agent: "a/b" }, {})).toHaveProperty("error");
  });
});

describe("eval.ts chat output", () => {
  const owner = { id: "1", from: "owner", text: "hi", at: 0, label: "/words", to: "/words/pf" };
  it("prints the node fields, and observed when it is for a node below", () => {
    expect(chatLine(owner, { node: "/words" }, true)).toMatchObject({
      type: "chat",
      to: "/words/pf",
      observed: true,
    });
    expect(chatLine({ ...owner, to: undefined }, {}, false)).not.toHaveProperty("to");
  });
  it("skips agent replies to the main thread and its own lines, keeps agent → node lines", () => {
    const agent = { id: "2", from: "agent", text: "x", at: 0, label: "a" };
    expect(chatLine(agent, {}, false)).toBeNull();
    const toMe = { ...agent, to: "/words/pf", taskPath: "/words", agentId: "w" };
    expect(chatLine(toMe, { node: "/words/pf", agent: "pf" }, false)).toMatchObject({
      taskPath: "/words",
      agentId: "w",
    });
    expect(chatLine(toMe, { node: "/words", agent: "w" }, true)).toBeNull();
  });
});

describe("eval.ts chat output: voice lines", () => {
  const base = { id: "1", from: "owner", text: "hi", at: 0, label: "/words" };
  it("prints source stt, so the chat lane knows an edit is allowed; typed lines have none", () => {
    expect(chatLine({ ...base, source: "stt" }, {}, false)).toMatchObject({ source: "stt" });
    expect(chatLine(base, {}, false)).not.toHaveProperty("source");
  });
  it("prints raw and edited for a polished line", () => {
    const edited = { at: 1, by: "lane", count: 1 };
    expect(
      chatLine({ ...base, source: "stt", text: "Hi.", raw: "hi", edited }, {}, false),
    ).toMatchObject({ text: "Hi.", raw: "hi", edited });
  });
  it("prints the mic's wake mode and why it is in it; a line sent with the mic off has neither", () => {
    expect(
      chatLine({ ...base, source: "stt", wake: "active", wakeReason: "wake-word" }, {}, false),
    ).toMatchObject({ wake: "active", wakeReason: "wake-word" });
    expect(chatLine({ ...base, wake: "passive", wakeReason: "rejects" }, {}, false)).toMatchObject({
      wake: "passive",
      wakeReason: "rejects",
    });
    const off = chatLine(base, {}, false);
    expect(off).not.toHaveProperty("wake");
    expect(off).not.toHaveProperty("wakeReason");
    expect(chatLine({ ...base, wake: "sleepy" }, {}, false)).not.toHaveProperty("wake");
  });
});

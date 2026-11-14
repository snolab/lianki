// lib/lane-route.ts: which lane answers an owner line (docs/lane-listen.md).
// One matcher for every listener, so each line gets exactly one lane.
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_LANE,
  ROUTE_LANES,
  isRouteLane,
  laneTakes,
  routeLine,
  testText,
} from "../lib/lane-route";

describe("routeLine: addressed lines", () => {
  it.each([
    ["codex, 看一下 PR #700", ["codex"], "看一下 PR #700"],
    ["Codex，帮我看看这个", ["codex"], "帮我看看这个"],
    ["codex: review the diff", ["codex"], "review the diff"],
    ["codex review the diff", ["codex"], "review the diff"],
    ["codex帮我看看", ["codex"], "帮我看看"],
    ["Codex 线，在吗", ["codex"], "在吗"],
    ["@codex 你好", ["codex"], "你好"],
    ["Code X, are you there?", ["codex"], "are you there?"],
    ["Codecs, are you there?", ["codex"], "are you there?"],
    ["扣德克斯，在吗？", ["codex"], "在吗？"],
    ["coco, 看一下", ["codex"], "看一下"],
    ["Coco 帮我看看", ["codex"], "帮我看看"],
    ["可可，在吗", ["codex"], "在吗"],
    ["杰咪，在吗", ["agy"], "在吗"],
    ["agy, 你好", ["agy"], "你好"],
    ["AGY。试一下", ["agy"], "试一下"],
    ["A G Y, hello", ["agy"], "hello"],
    ["A.G.Y. hello", ["agy"], "hello"],
    ["antigravity, hi", ["agy"], "hi"],
    ["Anti-gravity: hi", ["agy"], "hi"],
    ["反重力，你在吗", ["agy"], "你在吗"],
    ["Gemini, 你看看", ["agy"], "你看看"],
    ["xiaoke, 进度怎么样", ["chat"], "进度怎么样"],
    ["Xiao Ke, 批准", ["chat"], "批准"],
    ["小可，批准", ["chat"], "批准"],
    ["小克，驳回", ["chat"], "驳回"],
    ["晓可，搁置", ["chat"], "搁置"],
    ["Linky, codex, 在吗", ["codex"], "在吗"],
    ["嘿，agy，你好", ["agy"], "你好"],
    ["hey codex, ping", ["codex"], "ping"],
    ["codex 和 agy，你们都看一下", ["codex", "agy"], "你们都看一下"],
    ["codex and agy: both look", ["codex", "agy"], "both look"],
    ["codex", ["codex"], ""],
  ] as const)("%s → %j", (text, lanes, rest) => {
    const r = routeLine(text);
    expect(r.addressed).toBe(true);
    expect(r.lanes).toEqual([...lanes]);
    expect(r.text).toBe(rest);
  });
});

describe("routeLine: not addressed → the chat lane only", () => {
  it.each([
    "帮我看看今天的进度",
    "Codecs are hard to get right",
    "Gemini says it is fine",
    "codex的 review 说什么了",
    "codexes are many",
    "agyle is not a word",
    "a gym is near",
    "反重力的设计很有意思",
    "codex 和反重力的设计",
    "我觉得 codex, agy 都行",
    "",
    "   ",
  ])("%j", (text) => {
    const r = routeLine(text);
    expect(r.addressed).toBe(false);
    expect(r.lanes).toEqual([DEFAULT_LANE]);
  });
});

describe("isRouteLane", () => {
  it("knows the three lanes only", () => {
    expect(ROUTE_LANES.every(isRouteLane)).toBe(true);
    expect(isRouteLane("main")).toBe(false);
    expect(isRouteLane(undefined)).toBe(false);
  });
});

describe("laneTakes: exactly one lane per line (no triple replies)", () => {
  const owner = (text: string) => ({ from: "owner", thread: "owner", text });
  const takers = (m: Parameters<typeof laneTakes>[1], tests = false) =>
    ROUTE_LANES.filter((l) => laneTakes(l, m, { tests }));

  it("an addressed owner line goes to that lane alone", () => {
    expect(takers(owner("codex, 在吗"))).toEqual(["codex"]);
    expect(takers(owner("agy，在吗"))).toEqual(["agy"]);
    expect(takers(owner("小可，在吗"))).toEqual(["chat"]);
  });
  it("an unaddressed owner line goes to the chat lane alone", () => {
    expect(takers(owner("今天学了什么"))).toEqual(["chat"]);
  });
  it("all: every owner line, never an agent line or another thread", () => {
    expect(laneTakes("codex", owner("今天学了什么"), { all: true })).toBe(true);
    expect(laneTakes("codex", { from: "agent", thread: "owner", text: "hi" }, { all: true })).toBe(
      false,
    );
    expect(laneTakes("codex", { from: "owner", thread: "f1", text: "hi" }, { all: true })).toBe(
      false,
    );
  });
  it("two names: both of them, nobody else", () => {
    expect(takers(owner("codex 和 agy，看一下"))).toEqual(["codex", "agy"]);
  });
  it("agent lines, friend lines and other threads: nobody", () => {
    expect(takers({ from: "agent", thread: "owner", text: "codex, hi" })).toEqual([]);
    expect(takers({ from: "friend", thread: "owner", text: "codex, hi" })).toEqual([]);
    expect(takers({ from: "owner", thread: "u123", text: "codex, hi" })).toEqual([]);
    expect(takers({ from: "owner", thread: "owner", text: 42 })).toEqual([]);
  });
  it("a missing thread is the owner's", () => {
    expect(takers({ from: "owner", text: "agy, hi" })).toEqual(["agy"]);
  });
  it("a marked test line counts only with tests on", () => {
    const t = { from: "agent", thread: "owner", text: "【main】[lane-test] codex, 测试" };
    expect(takers(t)).toEqual([]);
    expect(takers(t, true)).toEqual(["codex"]);
    expect(testText(t)).toBe("codex, 测试");
    expect(testText({ from: "owner", text: "[lane-test] codex, x" })).toBeNull();
    expect(testText({ from: "agent", text: "codex, x" })).toBeNull();
  });
});

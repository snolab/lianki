// lib/lane-route.ts: which lane answers an owner line (docs/lane-listen.md).
// One matcher for every listener, so each line gets exactly one lane.
import { afterEach, describe, expect, it } from "bun:test";
import {
  PHONETIC_MAX_NEAR_DEFAULT,
  setPhoneticMaxNear,
} from "../packages/debug-chat/src/lane-phonetic";
import {
  DEFAULT_LANE,
  LANE_NAMES,
  ROUTE_LANES,
  getEffectiveLaneNames,
  isRouteLane,
  laneHotwords,
  laneTakes,
  namesLane,
  routeLine,
  setCustomLaneNames,
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
    ["Q扣，看下", ["codex"], "看下"],
    ["扣扣，在吗", ["codex"], "在吗"],
    ["杰咪，在吗", ["agy"], "在吗"],
    // 哈基米: agy's name since 2026-11-16, and how STT writes it.
    ["哈基米，在吗", ["agy"], "在吗"],
    ["哈吉米，看一下", ["agy"], "看一下"],
    ["海吉米，在吗", ["agy"], "在吗"],
    ["哈急米，在吗", ["agy"], "在吗"],
    ["哈几米，看下", ["agy"], "看下"],
    ["ハチミ、聞こえる？", ["agy"], "聞こえる？"],
    ["ハッチミ、聞こえる？", ["agy"], "聞こえる？"],
    ["Hajimi, are you there?", ["agy"], "are you there?"],
    ["hajimi, 你好", ["agy"], "你好"],
    ["杰明，看一下", ["agy"], "看一下"],
    ["咪宝，在吗", ["agy"], "在吗"],
    ["咪宝，在吗？", ["agy"], "在吗？"],
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
    ["小柯，在吗", ["chat"], "在吗"],
    ["晓可，搁置", ["chat"], "搁置"],
    ["lianki, 看一下", ["chat"], "看一下"],
    ["liagent: status", ["chat"], "status"],
    ["agent-yes, review PR", ["chat"], "review PR"],
    ["otoji，播放", ["chat"], "播放"],
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

describe("routeLine: 小柯 and all hands further in (2026-11-15)", () => {
  it("小柯 is 小克's own name: no separator needed", () => {
    const r = routeLine("小柯你给Li配置一下");
    expect(r.addressed).toBe(true);
    expect(r.lanes).toEqual(["chat"]);
    expect(r.text).toBe("你给Li配置一下");
  });
  it.each(["小朋友们全体都有包书一。", "小朋友们全体都有报数", "大家都有报数", "全体都有，报数"])(
    "%j addresses every lane",
    (text) => {
      const r = routeLine(text);
      expect(r.addressed).toBe(true);
      expect(r.lanes).toEqual([...ROUTE_LANES]);
    },
  );
  it("全体 far into a line is not an all-hands call", () => {
    expect(routeLine("我今天读了一篇很长的文章，讲的是全体会议").addressed).toBe(false);
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

describe("customLaneNames and laneHotwords", () => {
  it("getEffectiveLaneNames returns default LANE_NAMES initially", () => {
    setCustomLaneNames(null);
    expect(getEffectiveLaneNames()).toEqual(LANE_NAMES);
  });

  it("setCustomLaneNames overrides or extends lane names dynamically", () => {
    setCustomLaneNames({
      agy: { exact: ["jamie", "agy"] },
      codex: { heard: ["koko"] },
    });
    // One table (chat.lanes): the names are added to the built-in ones, which stay.
    const eff = getEffectiveLaneNames();
    expect(eff.agy.exact).toEqual([...LANE_NAMES.agy.exact, "jamie"]);
    expect(eff.agy.heard).toEqual(LANE_NAMES.agy.heard);
    expect(eff.codex.heard).toEqual(LANE_NAMES.codex.heard);
    expect(eff.codex.exact).toEqual(LANE_NAMES.codex.exact);

    expect(routeLine("jamie, 在吗").lanes).toEqual(["agy"]);
    // Set again: that lane's wake names are replaced, not piled up.
    setCustomLaneNames({ agy: { exact: ["jay"] } });
    expect(getEffectiveLaneNames().agy.exact).toEqual([...LANE_NAMES.agy.exact, "jay"]);

    setCustomLaneNames(null);
    expect(getEffectiveLaneNames()).toEqual(LANE_NAMES);
  });

  it("laneHotwords gathers all unique exact and heard names", () => {
    const words = laneHotwords();
    expect(words).toContain("codex");
    expect(words).toContain("杰咪");
    expect(words).toContain("哈基米");
    expect(words).toContain("哈吉米");
    expect(words).toContain("咪宝");
    expect(words).toContain("lianki");
    expect(words).toContain("liagent");
    expect(words).toContain("agent-yes");
    expect(words).toContain("otoji");
    expect(words).toContain("可可");
  });
});

describe("routeLine: names by sound (lane-phonetic.ts, 2026-11-15)", () => {
  afterEach(() => setPhoneticMaxNear(PHONETIC_MAX_NEAR_DEFAULT));
  it.each([
    // Spellings he reported, now also the same pinyin.
    ["建明，在吗", ["agy"]],
    ["解密，在吗", ["agy"]],
    ["解米，在吗", ["agy"]],
    ["杰米，在吗", ["agy"]],
    ["小客，在吗", ["chat"]],
    ["小贺，在吗", ["chat"]],
    ["小课，在吗", ["chat"]],
    ["小科，在吗", ["chat"]],
    ["晓可，在吗", ["chat"]],
    ["可可，在吗", ["codex"]],
    ["扣扣，在吗", ["codex"]],
    // Never listed: the same pinyin, or one near syllable.
    ["借咪，在吗", ["agy"]],
    ["切咪，在吗", ["agy"]],
    ["谢咪，在吗", ["agy"]],
    ["杰民，在吗", ["agy"]],
    ["晓刻，在吗", ["chat"]],
    ["寇寇，在吗", ["codex"]],
    ["切咪和晓刻，在吗", ["agy", "chat"]],
  ])("%s → %j", (line, lanes) => {
    const r = routeLine(line);
    expect(r.addressed).toBe(true);
    expect(r.lanes).toEqual(lanes);
    expect(r.text).toBe("在吗");
  });
  it.each(["节目，很好看", "街面，很干净", "小河边有棵树", "小鸡，在吃米", "切民，在吗"])(
    "%s → not a name",
    (line) => expect(routeLine(line).addressed).toBe(false),
  );
  it("known limit: 小河 is xiao he like the own name 小贺, so with a mark after it, it calls 小克", () => {
    expect(routeLine("小河，很长的那条")).toMatchObject({ lanes: ["chat"], addressed: true });
  });
  it("a sound match needs a punctuation mark, as a heard spelling does", () => {
    expect(routeLine("切咪在吗").addressed).toBe(false);
  });
  it("a name said twice is an address without a mark (建明建明在吗)", () => {
    expect(routeLine("建明建明在吗？")).toEqual({
      lanes: ["agy"],
      addressed: true,
      text: "在吗？",
    });
    expect(routeLine("切咪切咪在吗").lanes).toEqual(["agy"]);
  });
  it("cap 0: only the same pinyin", () => {
    setPhoneticMaxNear(0);
    expect(routeLine("切咪，在吗").addressed).toBe(false);
    expect(routeLine("借咪，在吗").lanes).toEqual(["agy"]);
  });
});

describe("namesLane: any lane name in a line keeps Li quiet (2026-11-16)", () => {
  it("heard spellings of 哈基米 from his thread route to agy with a mark", () => {
    for (const n of ["韩吉敏", "韩今明", "韩吉明", "韩金明"])
      expect(routeLine(`${n}，回答。`).lanes).toEqual(["agy"]);
    expect(routeLine("韩吉敏回答。").addressed).toBe(false);
  });
  it("names a lane: an address, a heard spelling without a mark, a name further in", () => {
    expect(namesLane("agy，看一下")).toBe(true);
    expect(namesLane("韩今明要实施监控这个页面的改动。")).toBe(true);
    expect(namesLane("韩吉敏回答。")).toBe(true);
    expect(namesLane("这个你问一下哈基米吧")).toBe(true);
    expect(namesLane("let coco check it")).toBe(true);
    // By sound at the start, no mark (ha ji mi, written as no list has it).
    expect(routeLine("哈机米去看看").addressed).toBe(false);
    expect(namesLane("哈机米去看看")).toBe(true);
  });
  it("Latin names only as whole words; plain lines name nobody", () => {
    expect(namesLane("今天学什么")).toBe(false);
    expect(namesLane("codexes everywhere")).toBe(false);
    expect(namesLane("the cocoon")).toBe(false);
    expect(namesLane("xcoco")).toBe(false);
    expect(namesLane(undefined as unknown as string)).toBe(false);
  });
});

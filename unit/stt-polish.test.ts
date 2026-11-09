/**
 * The polish guard (packages/debug-chat/src/polish.ts): text fixtures only, no
 * audio. Each case is a realistic STT mishearing, the polish an agent might
 * send, and the context the line carried — and whether the hub takes it.
 */
import { describe, expect, it } from "bun:test";
import {
  FUNCTION_WORDS,
  MAX_FUNCTION_FIXES,
  polishCheck,
  polishContext,
  polishWords,
  SUMMARY_SHARE,
  summaryCheck,
  MAX_UNCLEAR_BRACKETS,
  MAX_UNCLEAR_CANDIDATES,
  UNCLEAR_PHRASES,
} from "../packages/debug-chat/src/polish";
import { cleanScene, MAX_SCENE_SCREEN } from "../packages/debug-chat/src/wire";
import { flagLive } from "../lib/debug-session";
import { FLAGS } from "../lib/flags";

type Case = { raw: string; polished: string; context: string[]; ok: boolean; why: string };

/** The before/after table in the PR: raw → polished, and the verdict. */
const CASES: Case[] = [
  {
    raw: "我们现在用的是流失传输吗",
    polished: "我们现在用的是流式传输吗？",
    context: ["/dev stt", "流式传输 延迟 0.4 s"],
    ok: true,
    why: "homophone 流失 → 流式, on screen",
  },
  {
    raw: "开十四巢模式",
    polished: "开思考模式。",
    context: ["思考模式", "设置"],
    ok: true,
    why: "a garble → a phrase on screen, same length of audio",
  },
  {
    raw: "open the sink settings",
    polished: "Open the sync settings.",
    context: ["settings", "Sync now · last synced 19:02"],
    ok: true,
    why: "sink → sync, the page's own button",
  },
  {
    raw: "我我我想看一下单词",
    polished: "我想看一下单词。",
    context: [],
    ok: true,
    why: "a stutter goes, nothing else",
  },
  {
    raw: "show the the deck",
    polished: "Show the deck.",
    context: [],
    ok: true,
    why: "a repeated word goes",
  },
  {
    raw: "所以经常离他",
    polished: "所以经常离他要在水区。",
    context: ["自动 polish 是上下文无关的"],
    ok: false,
    why: "adds words nobody said",
  },
  {
    raw: "所以经常离他",
    polished: "所以经常离谱。",
    context: ["这个润色经常离谱"],
    ok: true,
    why: "离他 → 离谱, from the thread",
  },
  {
    raw: "所以经常离他",
    polished: "所以经常离谱。",
    context: ["/words", "apple banana"],
    ok: false,
    why: "离谱 is nowhere in the context: keep raw",
  },
  {
    raw: "不要合并这个PR",
    polished: "要合并这个PR。",
    context: ["PR #476"],
    ok: false,
    why: "drops 不: changes the meaning",
  },
  {
    raw: "fix the card",
    polished: "Fix the vocabulary flashcard deck.",
    context: ["vocabulary flashcard deck"],
    ok: false,
    why: "a rewrite, not a misheard word",
  },
];

describe("polishCheck: realistic garbles", () => {
  for (const c of CASES)
    it(`${c.ok ? "takes" : "refuses"}: ${c.raw} → ${c.polished} (${c.why})`, () => {
      const v = polishCheck(c.raw, c.polished, c.context);
      expect(v.ok).toBe(c.ok);
      if (!v.ok) expect(v.reason.length).toBeGreaterThan(0);
    });

  it("punctuation, case and width alone always pass, in any script", () => {
    expect(polishCheck("hello world", "Hello, world!", []).ok).toBe(true);
    expect(polishCheck("今日はいい天気", "今日はいい天気。", []).ok).toBe(true);
    expect(polishCheck("ＡＢＣ test", "ABC test.", []).ok).toBe(true);
  });

  it("an unchanged text is fine; a polish of nothing to something is not", () => {
    expect(polishCheck("ok", "ok", []).ok).toBe(true);
    expect(polishCheck("", "deploy now", ["deploy now"]).ok).toBe(false);
  });

  it("a context word must be whole: part of one never counts", () => {
    expect(polishCheck("do not deploy", "do now deploy", ["snow"]).ok).toBe(false);
    expect(polishCheck("do not deploy", "Do not deploy.", ["snow"]).ok).toBe(true);
  });

  it("a repeat is whole words (or one character), never part of a longer word", () => {
    expect(polishCheck("do not notify anyone", "do notify anyone", []).ok).toBe(false);
    expect(polishCheck("do do it", "Do it.", []).ok).toBe(true);
    expect(polishCheck("I insist", "insist", []).ok).toBe(false);
    expect(polishCheck("a apple", "apple", []).ok).toBe(false);
    expect(polishCheck("I insist on skiing", "insist on skiing", []).ok).toBe(false);
  });

  it("a replacement that only drops characters is a removal (不要 → 要)", () => {
    expect(polishCheck("不要合并", "要合并", ["要"]).ok).toBe(false);
  });

  it("apostrophes and marks inside a word are punctuation", () => {
    expect(polishCheck("cant deploy", "can’t deploy.", []).ok).toBe(true);
    expect(polishCheck("lets eat", "Let's eat!", []).ok).toBe(true);
  });

  it("punctuation and spaces are not words", () => {
    expect(polishWords("Fix, the  sync-button!")).toEqual(["fix", "the", "sync", "button"]);
  });
});

describe("polishCheck: a truncated word completed from the context", () => {
  it("takes fl → flag when flag is on screen or in the thread, the agent's replies included", () => {
    expect(
      polishCheck("turn the fl on", "Turn the flag on.", ["/dev/flags", "stt.polish flag"]).ok,
    ).toBe(true);
    expect(
      polishCheck("turn the fl on", "Turn the flag on.", ["I flipped the flag for you"]).ok,
    ).toBe(true);
  });

  it("takes a lost leading letter: pinner → spinner, spinner in the context", () => {
    expect(
      polishCheck("the pinner never stops", "The spinner never stops.", [
        "a spinner shows while it loads",
      ]).ok,
    ).toBe(true);
  });

  it("refuses a completion the context does not hold", () => {
    expect(polishCheck("turn the fl on", "Turn the flag on.", ["settings"]).ok).toBe(false);
    expect(polishCheck("the pinner never stops", "The spinner never stops.", []).ok).toBe(false);
  });

  it("refuses when the fragment is itself a word in the context (he may have said it)", () => {
    expect(polishCheck("fix the pinner", "Fix the spinner.", ["spinner", "pinner"]).ok).toBe(false);
  });

  it("refuses one letter as evidence, a completion past the same audio, and spaceless scripts", () => {
    expect(polishCheck("the f is on", "The flag is on.", ["flag"]).ok).toBe(false);
    expect(polishCheck("the fl is on", "The flagship is on.", ["flagship"]).ok).toBe(false);
    // 要 → 不要 is an added negation, never a completion.
    expect(polishCheck("要合并", "不要合并。", ["不要合并"]).ok).toBe(false);
  });
});

describe("polishCheck: function words", () => {
  it("adds a particle or measure word in a clause, with no context needed", () => {
    expect(polishCheck("我在房间看书", "我在房间里看书。", []).ok).toBe(true);
    expect(polishCheck("这是我书", "这是我的书。", []).ok).toBe(true);
    expect(polishCheck("open settings page", "Open the settings page.", []).ok).toBe(true);
  });

  it("swaps one function word for another", () => {
    expect(polishCheck("我在房间上看书", "我在房间里看书。", []).ok).toBe(true);
    expect(polishCheck("go in the page", "Go to the page.", []).ok).toBe(true);
  });

  it("caps them at MAX_FUNCTION_FIXES a line", () => {
    expect(MAX_FUNCTION_FIXES).toBe(2);
    expect(polishCheck("open settings page", "Open the settings of page.", []).ok).toBe(true);
    expect(polishCheck("open settings page", "Open the settings of the page.", []).ok).toBe(false);
    const v = polishCheck(
      "open settings page now",
      "Open the settings of the page in a minute now.",
      ["minute"],
    );
    expect(v.ok).toBe(false);
  });

  it("never adds a negation, a question word or a content word", () => {
    expect(polishCheck("要合并", "不要合并。", []).ok).toBe(false);
    expect(polishCheck("你去学校", "你去学校吗？", []).ok).toBe(false);
    expect(polishCheck("deploy it", "Do not deploy it.", []).ok).toBe(false);
    expect(polishCheck("open settings", "Open the sync settings.", []).ok).toBe(false);
  });

  it("is data per script class, not per language", () => {
    expect(Object.keys(FUNCTION_WORDS).sort()).toEqual([
      "Cyrillic",
      "Han",
      "Hangul",
      "Kana",
      "Latin",
    ]);
    expect(FUNCTION_WORDS.Han).not.toContain("不");
    expect(FUNCTION_WORDS.Han).not.toContain("吗");
  });
});

describe("polishCheck: an unclear word as a bracket of candidates", () => {
  it("takes full-width and ASCII brackets with sound-alike candidates", () => {
    expect(polishCheck("给我一张票", "给我一张（没听清，票？，条？）。", []).ok).toBe(true);
    expect(polishCheck("给我一张票", "给我一张(没听清, 票?, 条?)", []).ok).toBe(true);
    expect(
      polishCheck("the pinner is stuck", "The (unclear, pinner?, spinner?) is stuck.", []).ok,
    ).toBe(true);
    expect(
      polishCheck("the pinner is stuck", "The （unclear，spinner？，spinster？） is stuck.", []).ok,
    ).toBe(true);
  });

  it("takes a candidate the context supports even when it sounds unlike", () => {
    expect(
      polishCheck("open the sink", "Open the (unclear, sink?, synchronisation?).", [
        "synchronisation",
      ]).ok,
    ).toBe(false); // past the same stretch of audio, context or not
    expect(polishCheck("open the sink", "Open the (unclear, sink?, sync?).", ["Sync now"]).ok).toBe(
      true,
    );
  });

  it("refuses a candidate that is neither a sound-alike nor in the context", () => {
    expect(
      polishCheck("the pinner is stuck", "The (unclear, pinner?, deployment?) is stuck.", []).ok,
    ).toBe(false);
    expect(polishCheck("给我一张票", "给我一张（没听清，票？，电影票？）", []).ok).toBe(false);
    // An added negation is never a sound-alike.
    expect(polishCheck("要合并", "（没听清，要？，不要？）合并", []).ok).toBe(false);
  });

  it("caps candidates a bracket and brackets a line", () => {
    expect(MAX_UNCLEAR_CANDIDATES).toBe(3);
    expect(MAX_UNCLEAR_BRACKETS).toBe(2);
    expect(polishCheck("给我一张票", "给我一张（没听清，票？，条？，跳？）", []).ok).toBe(true);
    expect(polishCheck("给我一张票", "给我一张（没听清，票？，条？，跳？，调？）", []).ok).toBe(
      false,
    );
    const three = "一张（没听清，票？，条？）一个（没听清，人？，认？）一本（没听清，书？，输？）";
    expect(polishCheck("一张票一个人一本书", three, []).ok).toBe(false);
    const two = "一张（没听清，票？，条？）一个（没听清，人？，认？）一本书";
    expect(polishCheck("一张票一个人一本书", two, []).ok).toBe(true);
  });

  it("the phrase is data per line language; an unknown phrase is no bracket", () => {
    expect(UNCLEAR_PHRASES.zh).toBe("没听清");
    expect(UNCLEAR_PHRASES.en).toBe("unclear");
    // Not a bracket: its words are added text, refused as ever.
    expect(polishCheck("给我一张票", "给我一张（嗯，票？，条？）", []).ok).toBe(false);
  });

  it("a bracket replaces one raw run; it never adds a word he did not say", () => {
    expect(polishCheck("给我票", "给我一张（没听清，票？，条？）", []).ok).toBe(false);
  });
});

describe("summaryCheck", () => {
  const room = ["那个房子一个月多少钱啊我觉得太贵了", "对啊而且离地铁站还挺远的你说呢"];

  it("takes one short sentence saying what was said", () => {
    expect(summaryCheck(room, "（旁人在聊租房，嫌贵）").ok).toBe(true);
    expect(
      summaryCheck(
        ["someone in the room is talking about rent being too high near the station"],
        "(talk about rent)",
      ).ok,
    ).toBe(true);
  });

  it("refuses a bare noise marker: it says what was said", () => {
    expect(summaryCheck(room, "（杂音）").ok).toBe(false);
    expect(summaryCheck(room, "noise").ok).toBe(false);
  });

  it("refuses one over SUMMARY_SHARE of the raw, more than one sentence, or nothing", () => {
    expect(SUMMARY_SHARE).toBe(0.4);
    expect(summaryCheck(room, "旁人在聊房子一个月多少钱太贵了离地铁站很远").ok).toBe(false);
    expect(summaryCheck(room, "聊租房。嫌贵。").ok).toBe(false);
    expect(summaryCheck(room, "  ").ok).toBe(false);
    expect(summaryCheck([], "聊租房").ok).toBe(false);
  });
});

describe("polishContext", () => {
  it("draws on the scene, the selection and the thread", () => {
    const ctx = polishContext(
      {
        scene: { path: "/words/en-ngsl", title: "NGSL", screen: "apple" },
        context: { selection: "pear" },
      },
      ["earlier line"],
    );
    expect(ctx).toEqual(["words en ngsl", "NGSL", "apple", "pear", "earlier line"]);
    expect(polishContext({}, [])).toEqual([]);
  });
});

describe("cleanScene", () => {
  it("keeps known keys, bounded; drops the query and odd values", () => {
    expect(
      cleanScene({ path: "/words?x=1", title: " A \n B ", screen: "x".repeat(5000), z: 1 }),
    ).toEqual({
      path: "/words",
      title: "A B",
      screen: "x".repeat(MAX_SCENE_SCREEN),
    });
    expect(cleanScene({ path: "words" })).toBeUndefined();
    expect(cleanScene("nope")).toBeUndefined();
    expect(cleanScene(null)).toBeUndefined();
  });
});

describe("the stt.polish flag", () => {
  it("is a positive registry flag, on by default (polish active), owner audience", () => {
    expect(FLAGS["stt.polish"]).toMatchObject({ default: true, audience: "owner" });
    expect("stt.polish-off" in FLAGS).toBe(false);
  });

  it("flagLive reads exactly 1 as on, for registry keys only", async () => {
    const asked: unknown[] = [];
    const db = (enabled: number | null) => ({
      prepare: () => ({
        bind: (...v: unknown[]) => (
          asked.push(...v),
          { all: async <T>() => ({ results: (enabled === null ? [] : [{ enabled }]) as T[] }) }
        ),
      }),
    });
    expect(await flagLive(db(1), "stt.polish")).toBe(true);
    expect(await flagLive(db(0), "stt.polish")).toBe(false);
    // No row: the registry default, on for stt.polish, off for a default-off flag.
    expect(await flagLive(db(null), "stt.polish")).toBe(true);
    expect(await flagLive(db(null), "stt.merge")).toBe(false);
    expect(await flagLive(db(1), "not.a.flag")).toBe(false);
    expect(await flagLive(undefined, "stt.polish")).toBe(false);
    expect(asked).toEqual(["stt.polish", "stt.polish", "stt.polish", "stt.merge"]);
  });
});

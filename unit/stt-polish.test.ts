/**
 * The polish guard (packages/debug-chat/src/polish.ts): text fixtures only, no
 * audio. Each case is a realistic STT mishearing, the polish an agent might
 * send, and the context the line carried — and whether the hub takes it.
 */
import { describe, expect, it } from "bun:test";
import { polishCheck, polishContext, polishWords } from "../packages/debug-chat/src/polish";
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

describe("the stt.polish-off flag", () => {
  it("is a registry flag, off by default (polish as before)", () => {
    expect(FLAGS["stt.polish-off"].default).toBe(false);
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
    expect(await flagLive(db(1), "stt.polish-off")).toBe(true);
    expect(await flagLive(db(0), "stt.polish-off")).toBe(false);
    expect(await flagLive(db(null), "stt.polish-off")).toBe(false);
    expect(await flagLive(db(1), "not.a.flag")).toBe(false);
    expect(await flagLive(undefined, "stt.polish-off")).toBe(false);
    expect(asked).toEqual(["stt.polish-off", "stt.polish-off", "stt.polish-off"]);
  });
});

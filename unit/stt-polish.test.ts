/**
 * The polish checks (packages/debug-chat/src/polish.ts): text fixtures only, no
 * audio. Polish is unrestricted (owner, 2026-11-14): any non-empty text is a
 * polish; summaries keep their own shape.
 */
import { describe, expect, it } from "bun:test";
import {
  polishCheck,
  polishWords,
  SUMMARY_SHARE,
  summaryCheck,
  mergeCheck,
} from "../packages/debug-chat/src/polish";
import { cleanScene, MAX_SCENE_SCREEN } from "../packages/debug-chat/src/wire";
import { flagLive } from "../lib/debug-session";
import { FLAGS } from "../lib/flags";

describe("polishCheck: unrestricted (owner, 2026-11-14)", () => {
  it("takes a substitution: 认色 → 润色", () => {
    expect(polishCheck("把认色的限制删掉", "把润色的限制删掉。").ok).toBe(true);
  });

  it("takes any rewrite: dropped, added, reordered words, a negation too", () => {
    expect(polishCheck("do not deploy", "Deploy.").ok).toBe(true);
    expect(polishCheck("要合并", "不要合并。").ok).toBe(true);
    expect(polishCheck("open settings page", "Please open the sync settings page now.").ok).toBe(
      true,
    );
    expect(polishCheck("开十四巢模式", "开思考模式。").ok).toBe(true);
  });

  it("refuses only an empty text", () => {
    expect(polishCheck("hello", "  ").ok).toBe(false);
    expect(polishCheck("", "deploy now").ok).toBe(true);
  });

  it("polishWords: punctuation and spaces are not words", () => {
    expect(polishWords("Hello, world!")).toEqual(["hello", "world"]);
  });
});

describe("mergeCheck (a run of his lines as one passage)", () => {
  const run = ["我想把那个按钮", "放到右边", "然后颜色改成红色"];

  it("takes any passage of two or more lines, however long", () => {
    expect(mergeCheck(run, "我想把那个按钮放到右边，然后把颜色改成红色。").ok).toBe(true);
    expect(mergeCheck(run, "啊".repeat(500)).ok).toBe(true);
  });

  it("refuses one line and empty text", () => {
    expect(mergeCheck([run[0]!], run[0]!).ok).toBe(false);
    expect(mergeCheck(run, "  ").ok).toBe(false);
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

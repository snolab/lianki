import { describe, expect, it } from "bun:test";
import {
  ECHO_MIN_CHARS,
  ECHO_SIMILARITY,
  dice,
  echoContained,
  echoScore,
  grams,
  normalizeEcho,
} from "@lianki/debug-chat/echo";

describe("echo guard: normalizing", () => {
  it("drops case, width, punctuation, symbols and spaces", () => {
    expect(normalizeEcho("Hello, World! It's 3:00 — ok?")).toBe("helloworldits300ok");
    expect(normalizeEcho("今日は、晴れです。")).toBe("今日は晴れです");
    expect(normalizeEcho("ＡＢＣ　１２３")).toBe("abc123");
    expect(normalizeEcho(" …！ ")).toBe("");
  });

  it("n-grams count repeats; a string shorter than n is one gram", () => {
    expect([...grams("abab", 2)]).toEqual([
      ["ab", 2],
      ["ba", 1],
    ]);
    expect([...grams("はい", 3)]).toEqual([["はい", 1]]);
    expect(grams("", 2).size).toBe(0);
    expect(dice(grams("abc", 2), grams("abc", 2))).toBe(1);
    expect(dice(grams("abc", 2), grams("xyz", 2))).toBe(0);
    expect(dice(new Map(), new Map())).toBe(0);
  });
});

describe("echo guard: echoScore", () => {
  const spoken = [
    "I deployed the fix to production.",
    "The tests pass on main now.",
    "今日はいい天気ですね。",
  ];

  it("drops the agent's own sentence, even mis-heard by STT", () => {
    expect(echoScore("I deployed the fix to production", spoken)).toMatchObject({
      score: 1,
      drop: true,
      against: spoken[0],
    });
    const misheard = echoScore("I deploy the fix to the production", spoken);
    expect(misheard.score).toBeGreaterThanOrEqual(ECHO_SIMILARITY);
    expect(misheard.drop).toBe(true);
  });

  it("drops a substring of a sentence (STT caught part of it)", () => {
    expect(echoScore("tests pass on main", spoken)).toMatchObject({ score: 1, drop: true });
    expect(echoScore("いい天気", spoken)).toMatchObject({ score: 1, drop: true });
  });

  it("uses CJK bigrams: a near-miss Japanese transcript is dropped", () => {
    const r = echoScore("今日はいい天気ですよね", spoken);
    expect(r.drop).toBe(true);
    expect(r.against).toBe(spoken[2]);
  });

  it("catches a transcript spanning two sentences", () => {
    const r = echoScore("to production. The tests pass", spoken);
    expect(r.drop).toBe(true);
    expect(r.against).toBe(`${spoken[0]} ${spoken[1]}`);
  });

  it("keeps the user's own words", () => {
    const r = echoScore("Can you also update the docs please", spoken);
    expect(r.drop).toBe(false);
    expect(r.score).toBeLessThan(ECHO_SIMILARITY);
    expect(echoScore("明日は雨が降るかな", spoken).drop).toBe(false);
  });

  it("short replies are dropped only when they equal a whole sentence", () => {
    expect("ok".length).toBeLessThan(ECHO_MIN_CHARS);
    // "OK" inside an agent sentence: the user's "OK" stays.
    expect(echoScore("OK.", ["OK, I will do that."])).toMatchObject({ drop: false, score: 0 });
    expect(echoScore("はい", ["はい、そうします。"]).drop).toBe(false);
    // The agent said just "OK.": that one is echo.
    expect(echoScore("ok", ["OK."])).toMatchObject({ drop: true, score: 1 });
  });

  it("nothing to compare: no drop", () => {
    expect(echoScore("anything at all", [])).toEqual({ score: 0, against: null, drop: false });
    expect(echoScore("  ...  ", spoken)).toEqual({ score: 0, against: null, drop: false });
    expect(echoScore("anything at all", ["!!!"])).toEqual({ score: 0, against: null, drop: false });
  });
});

describe("echo guard: containment (talk-over)", () => {
  it("a fragment of a sentence is fully inside it, though Dice would score it low", () => {
    const said = "今天天气很好，我们去公园散步吧。";
    expect(echoContained("我们去公园", [said])).toBe(1);
    expect(dice(grams("我们去公园", 2), grams(normalizeEcho(said), 2))).toBeLessThan(
      ECHO_SIMILARITY,
    );
  });

  it("a slightly misheard fragment stays high; his own words score low", () => {
    const said = "The weather is lovely today. Shall we go for a walk?";
    expect(echoContained("the weather is lovly today", [said])).toBeGreaterThanOrEqual(0.6);
    expect(echoContained("wait what does that mean", [said])).toBeLessThan(0.3);
  });

  it("mostly his words with a bit of hers is not echo; nothing spoken scores 0", () => {
    const said = "The weather is lovely today.";
    expect(
      echoContained("lovely today but can you explain the grammar first", [said]),
    ).toBeLessThan(0.6);
    expect(echoContained("hello", [])).toBe(0);
    expect(echoContained("…", [said])).toBe(0);
    expect(echoContained("好", ["好的。"])).toBe(1);
  });
});

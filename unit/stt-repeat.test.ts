/**
 * The repetition guard (packages/debug-chat/src/stt-repeat.ts): a decoding
 * loop is cut back to its head or dropped; real speech, including natural
 * repetition, passes untouched.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  REPEAT_MAX_UNIT,
  STT_REPEAT,
  repeatGuard,
  repeatLimits,
  repeatLimitsOf,
  setRepeatLimits,
} from "@lianki/debug-chat/stt-repeat";

afterEach(() => setRepeatLimits({}));

describe("repeatGuard", () => {
  it("cuts the café loop of 2026-11-15 to the head and one copy", () => {
    const t = "あなたが" + "ウィッター".repeat(300);
    expect(repeatGuard(t)).toMatchObject({
      action: "trim",
      text: "あなたがウィッター",
      unit: "ウィッター",
      runs: 300,
    });
  });

  it("reads through punctuation and spacing between copies", () => {
    const t = "今日は、" + "ウィッター、".repeat(20);
    expect(repeatGuard(t)).toMatchObject({ action: "trim", text: "今日は、ウィッター" });
    const en = "I think " + "the the ".repeat(12);
    expect(repeatGuard(en)).toMatchObject({ action: "trim", text: "I think the", unit: "the" });
  });

  it("drops a line that is nothing but the loop", () => {
    expect(repeatGuard("ウィッター".repeat(50))).toMatchObject({
      action: "trim",
      text: "ウィッター",
    });
    const v = repeatGuard("好".repeat(40));
    expect(v).toMatchObject({ action: "drop", text: "", unit: "好", runs: 40 });
    if (v.action !== "keep") expect(v.share).toBe(1);
    expect(repeatGuard("na na na na na na na na")).toMatchObject({ action: "drop", text: "" });
    expect(repeatGuard("谢谢".repeat(10))).toMatchObject({ action: "drop" });
  });

  it("catches CJK, kana, Latin words and mixed text", () => {
    expect(repeatGuard("我想说" + "对不起".repeat(10))).toMatchObject({
      action: "trim",
      text: "我想说对不起",
    });
    expect(repeatGuard("ok " + "ありがとう ".repeat(8))).toMatchObject({
      action: "trim",
      text: "ok ありがとう",
    });
    expect(repeatGuard("Hello " + "Bonjour ".repeat(10))).toMatchObject({
      action: "trim",
      text: "Hello Bonjour",
    });
    // Case and full width fold: ＨＥＹ hey Hey are one unit.
    expect(repeatGuard("so " + "ＨＥＹ hey Hey ".repeat(4))).toMatchObject({
      action: "trim",
      text: "so ＨＥＹ",
    });
    // A whole word longer than REPEAT_MAX_UNIT letters.
    const long = "wonderfully";
    expect([...long].length).toBeGreaterThan(REPEAT_MAX_UNIT);
    expect(repeatGuard(`it is ${`${long} `.repeat(10)}`)).toMatchObject({
      action: "trim",
      text: `it is ${long}`,
      unit: long,
    });
  });

  it("leaves natural repetition and long real texts alone", () => {
    for (const t of [
      "好好好",
      "好好好，我知道了",
      "no no no",
      "哈哈哈哈哈",
      "はいはいはい、わかりました",
      "Bye bye!",
      "",
      "。。。",
      "1000000",
      "電話番号は 0120-000-000 です",
      "今日は朝から雨が降っていて、駅まで歩くのが大変でしたが、カフェで温かいコーヒーを飲んで少し落ち着きました。",
      "The quick brown fox jumps over the lazy dog, and then the dog wakes up and chases the fox around the yard.",
      "我们明天下午三点在公司楼下的咖啡店见面，然后一起去看那个展览，好不好？",
      // A loop in a long sentence, under the share: untouched.
      "今日はとても良い天気だったので、公園まで散歩して、ベンチに座って本を読みました。" +
        "ねねねねねねね",
    ])
      expect(repeatGuard(t)).toEqual({ action: "keep", text: t });
  });

  it("needs both the run count and the share", () => {
    const t = "ab".repeat(5); // 5 copies: under 6
    expect(repeatGuard(t).action).toBe("keep");
    expect(repeatGuard("ab".repeat(6)).action).toBe("drop");
    const mostlyReal = "这是一个完整而且很长的句子，我们在测试比例" + "嗯".repeat(8);
    expect(repeatGuard(mostlyReal).action).toBe("keep");
    expect(repeatGuard(mostlyReal, { ...STT_REPEAT, maxShare: 0.2 })).toMatchObject({
      action: "trim",
    });
  });

  it("drops when the kept head is shorter than minKeepChars, else trims", () => {
    const t = "あ" + "いう".repeat(10); // head "あいう": 3 letters
    expect(repeatGuard(t).action).toBe("drop");
    expect(repeatGuard(t, { ...STT_REPEAT, minKeepChars: 3 })).toMatchObject({
      action: "trim",
      text: "あいう",
    });
  });

  it("prefers the earliest, then the smallest, unit", () => {
    // "abab…" is also "abab" repeated: the unit is "ab".
    expect(repeatGuard("xyz " + "ab".repeat(20))).toMatchObject({ unit: "ab", text: "xyz ab" });
  });
});

describe("limits", () => {
  it("takes valid config values and keeps defaults for the rest", () => {
    expect(repeatLimits()).toEqual(STT_REPEAT);
    setRepeatLimits({ maxRuns: 3, maxShare: 0.5, minKeepChars: 2 });
    expect(repeatLimits()).toEqual({ maxRuns: 3, maxShare: 0.5, minKeepChars: 2 });
    // The live limits are the default for repeatGuard.
    expect(repeatGuard("好好好").action).toBe("drop");
    setRepeatLimits({ maxRuns: "6", maxShare: 2, minKeepChars: Number.NaN });
    expect(repeatLimits()).toEqual(STT_REPEAT);
    expect(repeatLimitsOf({ maxRuns: 1, maxShare: -1, minKeepChars: -2 })).toEqual(STT_REPEAT);
    expect(repeatLimitsOf({ maxRuns: 7.4, minKeepChars: 2.6 })).toEqual({
      ...STT_REPEAT,
      maxRuns: 7,
      minKeepChars: 3,
    });
  });
});

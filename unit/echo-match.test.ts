import { describe, expect, it } from "bun:test";
import {
  type EchoConf,
  type EchoLine,
  containedSimilarity,
  echoMatch,
  lineSimilarity,
  normalizeEcho,
} from "@/lib/echo-match";

const conf: EchoConf = { windowMs: 8000, readWindowMs: 60_000, similarity: 0.8, minChars: 4 };
const owner = (id: string, text: string, at: number, label = "phone-a"): EchoLine => ({
  id,
  from: "owner",
  label,
  text,
  at,
  source: "stt",
});
const agent = (id: string, text: string, at: number): EchoLine => ({
  id,
  from: "agent",
  label: "main",
  text,
  at,
});
const kept = (...lines: EchoLine[]) => lines.map((l, i) => [`k${i}`, l] as const);

describe("echo similarity", () => {
  it("normalizes punctuation, spaces and case", () => {
    expect(normalizeEcho("表里 Alive，只表示进程活着。")).toBe("表里alive只表示进程活着");
    expect(lineSimilarity("同时发送着，两个麦克风。", "同时发送着两个麦克风")).toBe(1);
  });
  it("a one-character slip in ten still reads as the same sentence", () => {
    expect(lineSimilarity("现在是流失传输吗对吧", "现在是流式传输吗对吧")).toBeGreaterThanOrEqual(
      0.9,
    );
    expect(lineSimilarity("今天天气很好", "我要去买菜了")).toBeLessThan(0.3);
  });
  it("one sentence of a long reply read aloud is a stretch of it", () => {
    const reply = "好的。表里 alive 只表示进程活着，忙不忙要看 state。我去查一下。";
    expect(
      containedSimilarity("表里机费，只表示进程活着，忙不忙要看 state", reply),
    ).toBeGreaterThanOrEqual(0.8);
    expect(containedSimilarity("我想明天再学十个单词", reply)).toBeLessThan(0.5);
    // A line longer than the text is never inside it.
    expect(containedSimilarity(`${reply}还有我自己的话很多很多`, "忙不忙要看state")).toBe(0);
  });

  it("texts past the edit-distance size compare by character bigrams", () => {
    const long = "今天我们学习了很多新的单词和句子".repeat(50); // > 600 characters
    expect(lineSimilarity(long, `${long}嗯`)).toBeGreaterThan(0.95);
    expect(lineSimilarity(long, "完全不同的内容".repeat(100))).toBeLessThan(0.2);
    expect(containedSimilarity(long.replace(/单词/g, "词语"), long + long)).toBeGreaterThan(0.3);
    expect(containedSimilarity("完全不同的内容".repeat(100), long + long)).toBeLessThan(0.2);
  });
});

describe("echoMatch", () => {
  it("a merged line's parts count, and its latest part's time keeps the window open", () => {
    const merged: EchoLine = {
      ...owner("m", "我们明天去公园散步吧，顺便买点菜", 1000),
      parts: [
        { text: "我们明天去公园散步吧", at: 1000 },
        { text: "顺便买点菜", at: 9000 },
      ],
    };
    const hit = echoMatch(
      kept(merged),
      { text: "我们明天去公园散步吧", label: "phone-b", at: 12_000 },
      conf,
    );
    expect(hit?.entry[1].id).toBe("m");
  });
  it("his line from another device within the window; never from the same device", () => {
    const k = kept(owner("a", "我们明天去公园散步吧", 1000));
    const hit = echoMatch(k, { text: "我们明天去公园散布吧。", label: "phone-b", at: 6000 }, conf);
    expect(hit).toMatchObject({ kind: "other-device" });
    expect(hit!.entry[1].id).toBe("a");
    expect(
      echoMatch(k, { text: "我们明天去公园散步吧", label: "phone-a", at: 6000 }, conf),
    ).toBeUndefined();
    expect(
      echoMatch(k, { text: "我们明天去公园散步吧", label: "phone-b", at: 10_000 }, conf),
    ).toBeUndefined();
  });
  it("an agent line read aloud, within the read window; a quiet one is never read", () => {
    const reply = "表里 alive 只表示进程活着，忙不忙要看 state。";
    const cur = {
      text: "表里机费，只表示进程活着，忙不忙要看 state",
      label: "phone-b",
      at: 30_000,
    };
    expect(echoMatch(kept(agent("r", reply, 1000)), cur, conf)).toMatchObject({
      kind: "read-aloud",
    });
    expect(echoMatch(kept({ ...agent("r", reply, 1000), quiet: true }), cur, conf)).toBeUndefined();
    expect(echoMatch(kept(agent("r", reply, 1000)), { ...cur, at: 70_000 }, conf)).toBeUndefined();
  });
  it("his polished line read back, heard by the other phone after the two-mic window", () => {
    const line: EchoLine = {
      ...owner("p", "现在是流式传输吗？", 1000),
      raw: "现在是流失传输吗",
      edited: { at: 4000, by: "auto", count: 1 },
    };
    const hit = echoMatch(
      kept(line),
      { text: "现在是流式传输吗", label: "phone-b", at: 20_000 },
      conf,
    );
    expect(hit).toMatchObject({ kind: "read-aloud" });
  });
  it("a short line is never an echo", () => {
    expect(
      echoMatch(kept(agent("r", "好的", 1000)), { text: "好的", label: "x", at: 2000 }, conf),
    ).toBeUndefined();
  });
});

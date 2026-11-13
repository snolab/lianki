/**
 * Two mics, one line (packages/debug-chat/src/two-mic.ts): the same sentence
 * heard by his Windows PC and his Mac is one utterance. The texts below are
 * the owner's own example (2026-11-14 02:15 JST) and its kind: a swapped
 * character, an extra comma, a start clipped by a few characters.
 */
import { describe, expect, it } from "bun:test";
import {
  TWO_MIC_WINDOW_MS,
  normalizeSpoken,
  sameSentence,
  twoMicKeep,
  twoMicMatch,
} from "@lianki/debug-chat/two-mic";
import type { ChatMessage } from "@lianki/debug-chat/wire";

const line = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "a",
  from: "owner",
  label: "/words Windows",
  text: "同时发送着两个麦克风",
  at: 1000,
  source: "stt",
  ...over,
});
const cur = (over: Partial<Parameters<typeof twoMicKeep>[1]> = {}) => ({
  text: "同时发送的两个麦克风",
  label: "/words Macintosh",
  at: 2500,
  ...over,
});
const kept = (...xs: ChatMessage[]) => xs.map((x, i) => [`k${i}`, x] as const);

describe("sameSentence", () => {
  it("normalizes punctuation, spaces and case", () => {
    expect(normalizeSpoken("Hello, World！ 你好。")).toBe("helloworld你好");
  });

  it("the owner's examples are one sentence", () => {
    expect(sameSentence("同时发送着两个麦克风", "同时发送的两个麦克风")).toBe(true);
    expect(sameSentence("同时发送着两个麦克风", "同时，发送着两个麦克风。")).toBe(true);
    expect(sameSentence("同时发送着两个麦克风", "发送着两个麦克风")).toBe(true);
    expect(sameSentence("I'm sending two mics at once", "I am sending two mics at once.")).toBe(
      true,
    );
  });

  it("different sentences, a short word inside a long line, and empty text are not", () => {
    expect(sameSentence("同时发送着两个麦克风", "那你能不能给我显示一个按钮")).toBe(false);
    expect(sameSentence("好", "这个方案好不好你觉得")).toBe(false);
    expect(sameSentence("。", "。")).toBe(false);
    expect(sameSentence("a", "b")).toBe(false);
  });

  it("long texts compare by bigrams", () => {
    const long = "abcdefghij".repeat(70);
    expect(sameSentence(long, `x${long.slice(1)}`)).toBe(true);
    expect(sameSentence(long, "klmnopqrst".repeat(70))).toBe(false);
  });
});

describe("twoMicMatch", () => {
  it("another page's line, same sentence, within the window", () => {
    const k = kept(line());
    expect(twoMicMatch(k, cur(), TWO_MIC_WINDOW_MS)?.[1].id).toBe("a");
  });

  it("not past the window, not from the same page, not with the window 0", () => {
    expect(twoMicMatch(kept(line()), cur({ at: 6000 }), TWO_MIC_WINDOW_MS)).toBeUndefined();
    expect(
      twoMicMatch(kept(line()), cur({ label: "/words Windows" }), TWO_MIC_WINDOW_MS),
    ).toBeUndefined();
    expect(twoMicMatch(kept(line()), cur(), 0)).toBeUndefined();
  });

  it("skips typed lines, agents' lines, hidden and summary lines, and looks past them", () => {
    const k = kept(
      line({ id: "t", source: undefined }),
      line({ id: "g", from: "agent" }),
      line({ id: "h", collapsedInto: "x" }),
      line({ id: "s", summary: { ids: ["s"], by: "x", at: 1 } as ChatMessage["summary"] }),
      line({ id: "p", passage: { ids: ["p"], by: "x", at: 1 } as ChatMessage["passage"] }),
      line({ id: "a" }),
    );
    expect(twoMicMatch(k, cur(), TWO_MIC_WINDOW_MS)?.[1].id).toBe("a");
  });

  it("never pairs a line the Mac called someone else's with his", () => {
    const me = { decision: "me" as const, score: 0.6 };
    const other = { decision: "other" as const, score: 0.1 };
    expect(twoMicMatch(kept(line({ speaker: other })), cur({ speaker: me }), 4000)).toBeUndefined();
    expect(twoMicMatch(kept(line({ speaker: me })), cur({ speaker: other }), 4000)).toBeUndefined();
    expect(twoMicMatch(kept(line({ speaker: other })), cur(), 4000)).toBeUndefined();
    expect(twoMicMatch(kept(line({ speaker: other })), cur({ speaker: other }), 4000)).toBeTruthy();
  });

  it("a merged line matches on any of its parts, timed by its last", () => {
    const merged = line({
      text: "那你能不能给，同时发送着两个麦克风",
      at: 0,
      parts: [
        { id: "a", text: "那你能不能给，", at: 0 },
        { id: "b", text: "同时发送着两个麦克风", at: 1000 },
      ],
    });
    expect(twoMicMatch(kept(merged), cur(), 4000)?.[1].id).toBe("a");
  });
});

describe("twoMicKeep", () => {
  it("the verified line wins; then the higher score; then the longer text", () => {
    const me = { decision: "me" as const, score: 0.6 };
    expect(twoMicKeep(line(), cur({ speaker: me }))).toBe("replace");
    expect(twoMicKeep(line({ speaker: me }), cur())).toBe("drop");
    expect(
      twoMicKeep(line({ speaker: { decision: "me", score: 0.61 } }), cur({ speaker: me })),
    ).toBe("drop");
    expect(
      twoMicKeep(
        line({ speaker: { decision: "me", score: 0.6 } }),
        cur({ speaker: { decision: "me", score: 0.65 } }),
      ),
    ).toBe("replace");
    expect(twoMicKeep(line({ text: "发送着两个麦克风" }), cur())).toBe("replace");
    expect(twoMicKeep(line(), cur({ text: "发送着两个麦克风" }))).toBe("drop");
    // Equal scores fall through to length.
    expect(twoMicKeep(line({ text: "两个麦克风", speaker: me }), cur({ speaker: me }))).toBe(
      "replace",
    );
  });

  it("never replaces a merged or polished line", () => {
    const me = { decision: "me" as const, score: 0.9 };
    expect(twoMicKeep(line({ parts: [] }), cur({ speaker: me }))).toBe("drop");
    expect(
      twoMicKeep(line({ edited: { at: 1, by: "lane", count: 1 } }), cur({ speaker: me })),
    ).toBe("drop");
  });
});

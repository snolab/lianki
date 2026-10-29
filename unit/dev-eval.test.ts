import { describe, expect, it } from "bun:test";
import {
  CHAT_HISTORY,
  MAX_CHAT,
  MAX_CODE,
  type ChatMessage,
  chatText,
  cleanLabel,
  compile,
  matchesTarget,
  parseControllerMessage,
  parsePageMessage,
  pickLang,
  pickVoice,
  shortCode,
  summarize,
  trimHistory,
} from "@/lib/dev-eval";

describe("parseControllerMessage", () => {
  it("accepts an eval with code and an optional target", () => {
    expect(parseControllerMessage('{"type":"eval","code":"1+1"}')).toEqual({
      ok: true,
      value: { type: "eval", code: "1+1" },
    });
    const r = parseControllerMessage('{"type":"eval","code":"x","target":"iPhone"}');
    expect(r.ok && r.value.type === "eval" && r.value.target).toBe("iPhone");
  });

  it("refuses anything else", () => {
    expect(parseControllerMessage("nope").ok).toBe(false);
    expect(parseControllerMessage('{"type":"allow","pair":"x"}').ok).toBe(false);
    expect(parseControllerMessage('{"type":"eval","code":"  "}').ok).toBe(false);
    expect(
      parseControllerMessage(JSON.stringify({ type: "eval", code: "a".repeat(MAX_CODE + 1) })).ok,
    ).toBe(false);
  });
});

describe("parsePageMessage", () => {
  it("reads answers and results", () => {
    expect(parsePageMessage('{"type":"allow","pair":"p1"}')).toEqual({ type: "allow", pair: "p1" });
    const r = parsePageMessage('{"type":"result","id":"a","to":"p1","ok":true,"value":"2"}');
    expect(r).toMatchObject({ type: "result", id: "a", to: "p1", ok: true, value: "2" });
  });

  it("drops malformed messages", () => {
    expect(parsePageMessage('{"type":"allow"}')).toBeNull();
    expect(parsePageMessage('{"type":"eval","code":"x"}')).toBeNull();
    expect(parsePageMessage('{"type":"result","id":"a"}')).toBeNull();
  });
});

describe("labels and codes", () => {
  it("cleanLabel strips control characters and bounds length", () => {
    expect(cleanLabel("a\nb\u0000c")).toBe("a b c");
    expect(cleanLabel("x".repeat(500), 10)).toHaveLength(10);
    expect(cleanLabel(null)).toBe("");
  });

  it("shortCode is four hex digits", () => {
    expect(shortCode(new Uint8Array([0xab, 0x01, 0xff]))).toBe("ab01");
  });

  it("matchesTarget is a case-insensitive substring, and no target matches all", () => {
    expect(matchesTarget("/words pwa Mozilla (iPhone)", "iphone")).toBe(true);
    expect(matchesTarget("/words Mozilla (Mac)", "iphone")).toBe(false);
    expect(matchesTarget("anything", undefined)).toBe(true);
  });
});

describe("summarize", () => {
  it("serialises awkward values instead of throwing", () => {
    const o: Record<string, unknown> = { n: BigInt(1), f: function named() {}, u: undefined };
    o.self = o;
    const s = summarize(o);
    expect(s).toContain('"n":"1n"');
    expect(s).toContain("[function named]");
    expect(s).toContain("[circular]");
    expect(summarize(undefined)).toBe('"[undefined]"');
    expect(summarize(new Map([["a", 1]]))).toContain("[Map]");
    expect(summarize(new Error("boom"))).toContain("boom");
  });

  it("truncates", () => {
    const s = summarize("x".repeat(10_000), 100);
    expect(s.startsWith(`"${"x".repeat(99)}`)).toBe(true);
    expect(s).toContain("more]");
  });
});

describe("compile", () => {
  it("returns an expression's value, awaited", async () => {
    expect(await compile("1 + 1")()).toBe(2);
    expect(await compile("await Promise.resolve(3)")()).toBe(3);
  });

  it("runs a function body with return", async () => {
    expect(await compile("const a = 2;\nreturn a * 5;")()).toBe(10);
  });

  it("rejects with the thrown error", async () => {
    expect(compile("throw new Error('nope')")()).rejects.toThrow("nope");
  });
});

describe("chat messages", () => {
  it("a controller may say text, trimmed and bounded", () => {
    expect(parseControllerMessage('{"type":"say","text":" hi "}')).toEqual({
      ok: true,
      value: { type: "say", text: "hi" },
    });
    expect(parseControllerMessage('{"type":"say","text":"  "}').ok).toBe(false);
    expect(parseControllerMessage('{"type":"say"}').ok).toBe(false);
    expect(
      parseControllerMessage(JSON.stringify({ type: "say", text: "a".repeat(MAX_CHAT + 1) })).ok,
    ).toBe(false);
  });

  it("a page may chat with an id and text", () => {
    expect(parsePageMessage('{"type":"chat","id":"c1","text":"你好"}')).toEqual({
      type: "chat",
      id: "c1",
      text: "你好",
    });
    expect(parsePageMessage('{"type":"chat","text":"x"}')).toBeNull();
    expect(parsePageMessage('{"type":"chat","id":"c1","text":5}')).toBeNull();
    expect(
      parsePageMessage(JSON.stringify({ type: "chat", id: "c", text: "a".repeat(MAX_CHAT + 1) })),
    ).toBeNull();
  });

  it("allow carries the chat-only scope when asked, and nothing else", () => {
    expect(parsePageMessage('{"type":"allow","pair":"p","scope":"chat"}')).toEqual({
      type: "allow",
      pair: "p",
      scope: "chat",
    });
    expect(parsePageMessage('{"type":"allow","pair":"p","scope":"root"}')).toEqual({
      type: "allow",
      pair: "p",
    });
  });

  it("chatText and trimHistory", () => {
    expect(chatText(" a ")).toBe("a");
    expect(chatText(null)).toBeUndefined();
    const list = Array.from(
      { length: CHAT_HISTORY + 3 },
      (_, i): ChatMessage => ({ id: `${i}`, from: "owner", label: "", text: "x", at: i }),
    );
    expect(trimHistory(list)[0].id).toBe("3");
    expect(trimHistory(list.slice(0, 2))).toHaveLength(2);
  });
});

describe("reading replies aloud", () => {
  it("picks the language from the script", () => {
    expect(pickLang("Done — pushed the fix.")).toBe("en-US");
    expect(pickLang("修正しました")).toBe("ja-JP");
    expect(pickLang("カード")).toBe("ja-JP");
    expect(pickLang("已经修好了")).toBe("zh-CN");
    expect(pickLang("漢字")).toBe("zh-CN");
    expect(pickLang("고쳤어요")).toBe("ko-KR");
    expect(pickLang("")).toBe("en-US");
  });

  it("picks an installed voice: exact locale, then the same language, default first", () => {
    const voices = [
      { name: "a", lang: "en-GB" },
      { name: "b", lang: "zh_TW" },
      { name: "c", lang: "zh-CN" },
      { name: "d", lang: "en-US", default: false },
      { name: "e", lang: "en-US", default: true },
    ];
    expect(pickVoice(voices, "zh-CN")?.name).toBe("c");
    expect(pickVoice(voices, "en-US")?.name).toBe("e");
    expect(pickVoice(voices, "zh-HK")?.name).toBe("b");
    expect(pickVoice(voices, "ja-JP")).toBeUndefined();
  });
});

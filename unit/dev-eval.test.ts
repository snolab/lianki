import { describe, expect, it } from "bun:test";
import {
  CHAT_HISTORY,
  MAX_CHAT,
  MAX_CODE,
  MAX_LABEL,
  BUSY_GRACE_MS,
  BUSY_MS,
  type ChatMessage,
  chatText,
  cleanLabel,
  compile,
  isUserId,
  matchesTarget,
  parseControllerMessage,
  parsePageMessage,
  pickLang,
  pickVoice,
  shortCode,
  summarize,
  trimHistory,
  pageParts,
  busyLeft,
  allowLabel,
  isPageId,
  pairSentence,
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

describe("threads", () => {
  it("say may name a thread to reply in", () => {
    expect(parseControllerMessage('{"type":"say","text":"hi","to":" a@x.com "}')).toEqual({
      ok: true,
      value: { type: "say", text: "hi", to: "a@x.com" },
    });
  });

  it("isUserId takes only ids that cannot collide as storage prefixes", () => {
    expect(isUserId("Ab3_x-9")).toBe(true);
    expect(isUserId("a:b")).toBe(false);
    expect(isUserId("")).toBe(false);
    expect(isUserId("owner")).toBe(false);
    expect(isUserId("x".repeat(65))).toBe(false);
    expect(isUserId(42)).toBe(false);
  });
});

describe("heartbeat and page messages", () => {
  it("parses a working beat with an optional thread and label", () => {
    expect(parseControllerMessage('{"type":"busy"}')).toEqual({
      ok: true,
      value: { type: "busy" },
    });
    expect(
      parseControllerMessage(
        JSON.stringify({ type: "busy", to: " f@x.com ", label: "fix\nng", junk: 1 }),
      ),
    ).toEqual({ ok: true, value: { type: "busy", to: "f@x.com", label: "fix ng" } });
    const r = parseControllerMessage(JSON.stringify({ type: "busy", label: "x".repeat(500) }));
    expect(r.ok && r.value.type === "busy" && r.value.label?.length).toBe(80);
  });

  it("parses a page relabel: cleaned, bounded, never empty", () => {
    expect(parsePageMessage('{"type":"page","label":"/home pwa iPhone"}')).toEqual({
      type: "page",
      label: "/home pwa iPhone",
    });
    expect(parsePageMessage('{"type":"page","label":"  "}')).toBeNull();
    expect(parsePageMessage('{"type":"page"}')).toBeNull();
    const long = parsePageMessage(
      JSON.stringify({ type: "page", label: `/a\u0000${"b".repeat(900)}` }),
    );
    expect(long?.type === "page" && long.label.length).toBe(MAX_LABEL);
    expect(long?.type === "page" && long.label.startsWith("/a b")).toBe(true);
  });

  it("parses end-page with an id", () => {
    expect(parsePageMessage('{"type":"end-page","id":"ab12cd34"}')).toEqual({
      type: "end-page",
      id: "ab12cd34",
    });
    expect(parsePageMessage('{"type":"end-page"}')).toBeNull();
  });

  it("busyLeft: live, recent, and newer than the last agent reply", () => {
    const beat = { beatAt: 50_000, seenAt: 1_000 };
    expect(busyLeft(true, beat, 0, 1_000)).toBe(BUSY_MS);
    expect(busyLeft(true, beat, 0, 1_000 + BUSY_MS - 1)).toBe(1);
    expect(busyLeft(true, beat, 0, 1_000 + BUSY_MS)).toBe(0);
    expect(busyLeft(false, beat, 0, 1_000)).toBe(0);
    expect(busyLeft(true, null, 0, 1_000)).toBe(0);
    // A reply after the beat stops it; a beat just after a reply is the loop's last one.
    expect(busyLeft(true, beat, 50_001, 1_000)).toBe(0);
    expect(busyLeft(true, beat, 50_000 - BUSY_GRACE_MS + 1, 1_000)).toBe(0);
    expect(busyLeft(true, beat, 50_000 - BUSY_GRACE_MS, 1_000)).toBe(BUSY_MS);
  });
});

describe("pageParts", () => {
  it("splits a page label into its path and a device hint", () => {
    expect(pageParts("/words pwa Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toEqual({
      path: "/words",
      device: "pwa · Android",
    });
    expect(pageParts("/home Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toEqual({
      path: "/home",
      device: "iPhone",
    });
    expect(pageParts("/list Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)").device).toBe("Mac");
    expect(pageParts("/a Mozilla/5.0 (iPad; CPU OS 18_0)").device).toBe("iPad");
    expect(pageParts("/a Mozilla/5.0 (Windows NT 10.0)").device).toBe("Windows");
    expect(pageParts("/a Mozilla/5.0 (X11; Linux x86_64)").device).toBe("Linux");
    expect(pageParts("/a curl/8")).toEqual({ path: "/a", device: "" });
    expect(pageParts("")).toEqual({ path: "/", device: "" });
  });
});

describe("pairing: requested scope, pages, wording", () => {
  it("allow carries page ids or 'all'; junk ids are dropped", () => {
    expect(parsePageMessage('{"type":"allow","pair":"p","pages":"all"}')).toEqual({
      type: "allow",
      pair: "p",
      pages: "all",
    });
    expect(
      parsePageMessage(JSON.stringify({ type: "allow", pair: "p", pages: ["abc123", "x:y", 5] })),
    ).toEqual({ type: "allow", pair: "p", pages: ["abc123"] });
    expect(parsePageMessage('{"type":"allow","pair":"p","pages":"some"}')).toEqual({
      type: "allow",
      pair: "p",
    });
    expect(isPageId("tab-123456")).toBe(true);
    expect(isPageId("short")).toBe(false);
  });

  it("pairSentence says what Allow grants", () => {
    expect(pairSentence({ label: "agent", scope: "chat" }, false)).toBe(
      "agent wants to chat with you for 30 days.",
    );
    expect(pairSentence({ label: "lane", scope: "eval" }, false)).toBe(
      "lane wants to run code on your debug pages for 1 hour.",
    );
    expect(pairSentence({ label: "agent", scope: "eval" }, true)).toBe(
      "agent wants to preview a change on this page for 1 hour.",
    );
  });

  it("allowLabel follows the ticks", () => {
    expect(allowLabel(1, 1, true)).toBe("Authorize this page");
    expect(allowLabel(1, 3, true)).toBe("Authorize this page");
    expect(allowLabel(3, 3, true)).toBe("Authorize all pages");
    expect(allowLabel(2, 3, true)).toBe("Authorize 2 pages");
    expect(allowLabel(1, 3, false)).toBe("Authorize 1 page");
  });
});

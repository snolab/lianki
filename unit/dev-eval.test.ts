import { describe, expect, it } from "bun:test";
import {
  CHAT_HISTORY,
  MAX_CHAT,
  MAX_CHUNK,
  MAX_CHUNKS,
  MAX_CODE,
  MAX_LABEL,
  BUSY_GRACE_MS,
  BUSY_MS,
  type ChatMessage,
  applyEdit,
  dictatedDraft,
  draftSource,
  chatText,
  chunkMessages,
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

  it("hands the code $lk, the page's streaming context", async () => {
    const sent: string[] = [];
    const lk = { send: (d: string) => sent.push(d) - 1 };
    expect(await compile("$lk.send('a') + $lk.send('b')")(lk)).toBe(1);
    expect(sent).toEqual(["a", "b"]);
    expect(await compile("typeof $lk")()).toBe("undefined");
  });
});

describe("streamed chunks", () => {
  it("cuts a piece into ordered chunks that join back to it", () => {
    const data = "abcdefghij";
    const ms = chunkMessages("e1", "p1", 2, data, 4);
    expect(ms.map((m) => [m.seq, m.total, m.data])).toEqual([
      [0, 3, "abcd"],
      [1, 3, "efgh"],
      [2, 3, "ij"],
    ]);
    expect(
      ms.every((m) => m.type === "chunk" && m.id === "e1" && m.to === "p1" && m.part === 2),
    ).toBe(true);
    expect(ms.map((m) => m.data).join("")).toBe(data);
  });

  it("sends an empty piece as one empty chunk, and refuses one too large", () => {
    expect(chunkMessages("e", "p", 0, "")).toEqual([
      { type: "chunk", id: "e", to: "p", part: 0, seq: 0, total: 1, data: "" },
    ]);
    expect(() => chunkMessages("e", "p", 0, "x".repeat(MAX_CHUNKS + 1), 1)).toThrow("too large");
  });

  it("the hub accepts a full-size chunk, though it is far over the usual message size", () => {
    const [m] = chunkMessages("e", "p", 0, "A".repeat(MAX_CHUNK));
    expect(JSON.stringify(m).length).toBeGreaterThan(MAX_CODE + 2048);
    expect(parsePageMessage(JSON.stringify(m))).toEqual(m);
    // Data that JSON escapes still fits.
    const [esc] = chunkMessages("e", "p", 0, "\u0001".repeat(MAX_CHUNK));
    expect(parsePageMessage(JSON.stringify(esc))).toEqual(esc);
  });

  it("drops a malformed chunk, and any other message that large", () => {
    const ok = { type: "chunk" as const, id: "e", to: "p", part: 0, seq: 0, total: 1, data: "x" };
    expect(parsePageMessage(JSON.stringify(ok))).toEqual(ok);
    for (const bad of [
      { ...ok, id: undefined },
      { ...ok, to: "" },
      { ...ok, part: -1 },
      { ...ok, part: 1.5 },
      { ...ok, seq: 1 },
      { ...ok, total: 0 },
      { ...ok, total: MAX_CHUNKS + 1 },
      { ...ok, data: 5 },
      { ...ok, data: "x".repeat(MAX_CHUNK + 1) },
    ])
      expect(parsePageMessage(JSON.stringify(bad))).toBeNull();
    const big = JSON.stringify({
      type: "chat",
      id: "c",
      text: "x",
      pad: "y".repeat(MAX_CODE + 2048),
    });
    expect(parsePageMessage(big)).toBeNull();
    expect(parsePageMessage("x".repeat(MAX_CHUNK * 7))).toBeNull();
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
      "lane wants to run code on your pages for 8 hours.",
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

it("pickVoice skips iOS Eloquence and novelty voices", () => {
  const vs = [
    { lang: "zh-CN", name: "Eddy", default: true, voiceURI: "com.apple.eloquence.zh-CN.Eddy" },
    {
      lang: "zh-CN",
      name: "Tingting",
      default: true,
      voiceURI: "com.apple.voice.compact.zh-CN.Tingting",
    },
    {
      lang: "en-US",
      name: "Bahh",
      default: true,
      voiceURI: "com.apple.speech.synthesis.voice.Bahh",
    },
    {
      lang: "en-US",
      name: "Samantha",
      default: true,
      voiceURI: "com.apple.voice.compact.en-US.Samantha",
    },
    { lang: "en-US", name: "Ava", default: true, voiceURI: "com.apple.voice.premium.en-US.Ava" },
  ];
  expect(pickVoice(vs, "zh-CN")?.name).toBe("Tingting");
  expect(pickVoice(vs, "en-US")?.name).toBe("Ava");
  expect(pickVoice(vs.slice(0, 1), "zh-CN")?.name).toBe("Eddy");
});

describe("voice edits on the wire", () => {
  it("a page's chat keeps source stt and drops any other source", () => {
    expect(
      parsePageMessage(JSON.stringify({ type: "chat", id: "a", text: "hi", source: "stt" })),
    ).toEqual({
      type: "chat",
      id: "a",
      text: "hi",
      source: "stt",
    });
    expect(
      parsePageMessage(JSON.stringify({ type: "chat", id: "a", text: "hi", source: "x" })),
    ).toEqual({
      type: "chat",
      id: "a",
      text: "hi",
    });
  });

  it("a controller's edit needs an id and text", () => {
    expect(
      parseControllerMessage(JSON.stringify({ type: "edit", id: "m1", text: " Hi. " })),
    ).toEqual({
      ok: true,
      value: { type: "edit", id: "m1", text: "Hi." },
    });
    expect(parseControllerMessage(JSON.stringify({ type: "edit", text: "Hi." })).ok).toBe(false);
    expect(parseControllerMessage(JSON.stringify({ type: "edit", id: "m1", text: "" })).ok).toBe(
      false,
    );
  });

  it("a draft is stt only while nothing typed is in it", () => {
    const a = dictatedDraft("", null, "hello there");
    expect(draftSource("hello there", a)).toBe("stt");
    // Edited before sending: typed.
    expect(draftSource("hello there!", a)).toBeUndefined();
    // More dictation on pure dictation stays pure; on typed text it is typed.
    const b = dictatedDraft("hello there", a, "hello there. And more");
    expect(draftSource("hello there. And more", b)).toBe("stt");
    expect(dictatedDraft("typed ", null, "typed and spoken")).toBeNull();
    expect(draftSource("typed and spoken", null)).toBeUndefined();
    expect(draftSource("", "")).toBeUndefined();
  });

  it("applyEdit updates only the matching line of the matching thread", () => {
    const e = {
      id: "m1",
      thread: "owner",
      text: "Hi.",
      raw: "hi",
      edited: { at: 1, by: "a", count: 1 },
    };
    const m: ChatMessage = { id: "m1", from: "owner", label: "", text: "hi", at: 0, source: "stt" };
    expect(applyEdit(m, e)).toEqual({ ...m, text: "Hi.", raw: "hi", edited: e.edited });
    expect(applyEdit({ ...m, id: "m2" }, e)).toEqual({ ...m, id: "m2" });
    expect(applyEdit({ ...m, thread: "f1" }, e)).toEqual({ ...m, thread: "f1" });
  });
});

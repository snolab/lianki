import { describe, expect, it } from "bun:test";
import {
  MAX_CODE,
  cleanLabel,
  compile,
  matchesTarget,
  parseControllerMessage,
  parsePageMessage,
  shortCode,
  summarize,
} from "@/lib/dev-eval";

describe("parseControllerMessage", () => {
  it("accepts an eval with code and an optional target", () => {
    expect(parseControllerMessage('{"type":"eval","code":"1+1"}')).toEqual({
      ok: true,
      value: { type: "eval", code: "1+1" },
    });
    const r = parseControllerMessage('{"type":"eval","code":"x","target":"iPhone"}');
    expect(r.ok && r.value.target).toBe("iPhone");
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

import { describe, expect, it } from "bun:test";
import words from "@/app/(app)/words/page.content";
import newOrder from "@/app/(app)/words/new-order.content";
import { describeKeys, keyContext } from "@/lib/i18n-context";

// Owner rule (2026-10-30): a short string is never translated on its own —
// "Undo", "New swipe" or "Experimental" each read several ways. Every key
// carries context (where it appears, what it is for, how it is used) in the
// dictionary's description, which `intlayer fill` and translating agents read
// together with the source text. docs/i18n.md.

describe("describeKeys / keyContext", () => {
  it("round-trips one line per key, whitespace folded", () => {
    const d = describeKeys("About.", { a: "Button  on\nthe toolbar.", b: "Heading." });
    expect(d.startsWith("About.\n")).toBe(true);
    expect(keyContext(d)).toEqual({ a: "Button on the toolbar.", b: "Heading." });
  });

  it("reads nothing from a description without per-key context", () => {
    expect(keyContext(undefined)).toEqual({});
    expect(keyContext("Just a sentence.")).toEqual({});
  });
});

describe.each([
  ["words-page", words],
  ["new-order", newOrder],
])("%s", (_name, dict) => {
  const keys = Object.entries(dict.content as Record<string, { nodeType?: string }>)
    .filter(([, v]) => v?.nodeType === "translation")
    .map(([k]) => k);
  const context = keyContext(dict.description);
  const en = (k: string) =>
    (dict.content as Record<string, { translation: Record<string, string> }>)[k].translation.en;

  it("gives every key its translation context", () => {
    expect(keys.filter((k) => !context[k])).toEqual([]);
  });

  it("has no context left for a key that is gone", () => {
    expect(Object.keys(context).filter((k) => !keys.includes(k))).toEqual([]);
  });

  it("says more than the string itself: where, what for, how (5+ words)", () => {
    const thin = keys.filter((k) => {
      const c = context[k] ?? "";
      return c.split(/\s+/).length < 5 || c.trim() === en(k).trim();
    });
    expect(thin).toEqual([]);
  });
});

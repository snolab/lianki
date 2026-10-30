import { describe, expect, it } from "bun:test";
import {
  MAX_FOCUS_SUMMARY,
  cleanAmbient,
  cleanQuery,
  subtreeSummary,
} from "@lianki/debug-chat/ambient";
import { parsePageMessage } from "@/lib/dev-eval";

describe("ambient context", () => {
  it("cleanQuery drops secret-looking params and opaque values", () => {
    expect(cleanQuery("?deck=ja&token=abc&tab=2")).toBe("deck=ja&tab=2");
    expect(cleanQuery("x=abcdefghijklmnopqrstuvwxyz0123&ok=1")).toBe("ok=1");
    expect(cleanQuery("Auth_Code=1&%E0%A4%A=2")).toBe("%E0%A4%A=2");
    expect(cleanQuery("?")).toBeUndefined();
    expect(cleanQuery("&&")).toBeUndefined();
    expect(cleanQuery(5)).toBeUndefined();
  });

  it("cleanAmbient keeps a page path and a capped soft focus", () => {
    expect(cleanAmbient(null)).toBeUndefined();
    expect(cleanAmbient({ page: { path: "words" } })).toBeUndefined();
    expect(
      cleanAmbient({
        page: { path: "/words", query: "?key=1&deck=fr" },
        focus: {
          nodePath: "Plan › Mic",
          title: "  Mic   level ",
          status: "doing",
          summary: "x".repeat(900),
        },
      }),
    ).toEqual({
      page: { path: "/words", query: "deck=fr" },
      focus: {
        nodePath: "Plan › Mic",
        title: "Mic level",
        status: "doing",
        summary: "x".repeat(MAX_FOCUS_SUMMARY),
      },
    });
    // A focus without its title or path, or a status out of the set, is dropped or trimmed.
    expect(cleanAmbient({ page: { path: "/" }, focus: { title: "t" } })).toEqual({
      page: { path: "/" },
    });
    expect(
      cleanAmbient({ page: { path: "/" }, focus: { title: "t", nodePath: "t", status: "x" } }),
    ).toEqual({ page: { path: "/" }, focus: { title: "t", nodePath: "t" } });
  });

  it("subtreeSummary: titles and statuses, depth first, capped", () => {
    const n = {
      title: "Plan",
      children: [
        { title: "A", status: "doing", children: [{ title: "A1", status: "done" }] },
        { title: "B" },
      ],
    };
    expect(subtreeSummary(n)).toBe("A [doing]; ·A1 [done]; B");
    const wide = {
      title: "W",
      children: Array.from({ length: 200 }, (_, i) => ({ title: `n${i}` })),
    };
    expect(subtreeSummary(wide).length).toBeLessThanOrEqual(MAX_FOCUS_SUMMARY);
    expect(subtreeSummary(wide, 10)).toBe("n0; n1; n2");
  });

  it("a page's chat line carries it, cleaned", () => {
    const m = parsePageMessage(
      JSON.stringify({
        type: "chat",
        id: "a",
        text: "hi",
        ambient: { page: { path: "/words", query: "sig=1" }, focus: { title: "T", nodePath: "T" } },
      }),
    );
    expect(m).toMatchObject({ ambient: { page: { path: "/words" }, focus: { title: "T" } } });
    expect(
      parsePageMessage(JSON.stringify({ type: "chat", id: "a", text: "hi" })),
    ).not.toHaveProperty("ambient");
  });
});

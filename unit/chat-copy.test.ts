import { describe, expect, it } from "bun:test";
import { LINE_SELECTABLE } from "@lianki/debug-chat/copy-line";

describe("LINE_SELECTABLE", () => {
  it("takes the pointer and turns selection and the iOS callout on", () => {
    const c = LINE_SELECTABLE.split(" ");
    expect(c).toContain("pointer-events-auto");
    expect(c).toContain("select-text");
    expect(c).toContain("[-webkit-user-select:text]");
    expect(c).toContain("[-webkit-touch-callout:default]");
    expect(c).not.toContain("select-none");
  });
});

describe("the reader leaves the chat alone", () => {
  it("knows an event in the chat by its path", async () => {
    const { inChat, CHAT_SELECTOR } = await import("@/lib/read/reader-select");
    class El {
      constructor(private sel: string) {}
      matches(s: string) {
        return s === CHAT_SELECTOR && this.sel === "chat";
      }
    }
    const g = globalThis as { Element?: unknown };
    const had = g.Element;
    g.Element = El;
    try {
      expect(inChat({ composedPath: () => [new El("span"), new El("chat")] as never })).toBe(true);
      expect(inChat({ composedPath: () => [new El("span"), new El("book")] as never })).toBe(false);
    } finally {
      g.Element = had;
    }
  });
});

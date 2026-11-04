import { describe, expect, it } from "bun:test";
import { LINE_SELECTABLE, copyText, lineCopyText } from "@lianki/debug-chat/copy-line";
import { UI_EN, UI_JA, UI_ZH } from "@lianki/debug-chat/ui-strings";

describe("copyText", () => {
  it("writes the text through the Clipboard API", async () => {
    const got: string[] = [];
    const ok = await copyText("好的，我先修复复制。", {
      writeText: async (t) => {
        got.push(t);
      },
    });
    expect(ok).toBe(true);
    expect(got).toEqual(["好的，我先修复复制。"]);
  });

  it("falls back to execCommand when the Clipboard API refuses", async () => {
    let copied = "";
    let removed = false;
    const ta = {
      value: "",
      style: { cssText: "" },
      setAttribute() {},
      select() {},
      setSelectionRange() {},
      remove() {
        removed = true;
      },
    };
    const doc = {
      body: { appendChild() {} },
      createElement: () => ta,
      execCommand: (c: string) => {
        copied = c === "copy" ? ta.value : "";
        return true;
      },
    } as unknown as Document;
    const ok = await copyText(
      "hello",
      {
        writeText: async () => {
          throw new DOMException("no", "NotAllowedError");
        },
      },
      doc,
    );
    expect(ok).toBe(true);
    expect(copied).toBe("hello");
    expect(removed).toBe(true);
  });

  it("says false with no clipboard and no document", async () => {
    expect(await copyText("x", undefined, undefined)).toBe(false);
  });
});

describe("lineCopyText", () => {
  it("copies the text shown", () => {
    expect(lineCopyText({ text: "polished", raw: "raw" })).toBe("polished");
    expect(lineCopyText({ text: "polished", raw: "raw", showRaw: true })).toBe("raw");
    expect(
      lineCopyText({ text: "", ask: { questions: [{ question: "A?" }, { question: "B?" }] } }),
    ).toBe("A?\nB?");
  });
});

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

describe("copy strings", () => {
  it("has the copy label in every widget language", () => {
    for (const ui of [UI_EN, UI_ZH, UI_JA]) {
      expect(ui.copyLine.length).toBeGreaterThan(0);
      expect(ui.copiedLine.length).toBeGreaterThan(0);
    }
  });
});

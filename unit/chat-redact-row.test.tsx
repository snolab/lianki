// "Delete this line" in a line's details (packages/debug-chat/src/MessageDetails.tsx
// RedactRow; lib/chat-redact.ts): one tap never deletes, the red confirm does,
// Keep it changes nothing, and a deleted or someone else's line offers nothing.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { globalDescriptor, restoreGlobal } from "./support/globals";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { RedactRow } from "@lianki/debug-chat/MessageDetails";
import { EXTRA } from "@lianki/debug-chat/chat-ui-locales";
import type { ChatMessage } from "@lianki/debug-chat/wire";

const LINE: ChatMessage = { id: "4d87d0ca", from: "owner", label: "", text: "x", at: 1 };

describe("RedactRow", () => {
  const win = new Window({ url: "https://lianki.com/zh" });
  const g = globalThis as Record<string, unknown>;
  const keys = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = Object.fromEntries(keys.map((k) => [k, globalDescriptor(k)]));
  beforeAll(() => {
    g.window = win;
    g.document = win.document;
    g.HTMLElement = win.HTMLElement;
    g.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    for (const [k, d] of Object.entries(saved)) restoreGlobal(k, d);
  });
  const words = EXTRA.zh;
  const mount = async (message: ChatMessage) => {
    const asked: string[] = [];
    let done = 0;
    const box = win.document.createElement("div");
    win.document.body.appendChild(box);
    const root = createRoot(box as unknown as Element);
    await act(async () =>
      root.render(
        createElement(RedactRow, {
          message,
          option: { words, may: (m) => m.from === "owner", onRedact: (id) => asked.push(id) },
          onDone: () => done++,
        }),
      ),
    );
    const q = (id: string) => box.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    return { box, root, asked, q, done: () => done };
  };

  it("删除这条, then the confirm: only the second tap deletes", async () => {
    const r = await mount(LINE);
    expect(r.q("debug-chat-redact")?.textContent).toBe("删除这条");
    await act(async () => r.q("debug-chat-redact")!.click());
    expect(r.asked).toEqual([]);
    expect(r.box.textContent).toContain(words.redactHint);
    await act(async () => r.q("debug-chat-redact-no")!.click());
    expect(r.asked).toEqual([]);
    await act(async () => r.q("debug-chat-redact")!.click());
    await act(async () => r.q("debug-chat-redact-yes")!.click());
    expect(r.asked).toEqual(["4d87d0ca"]);
    expect(r.done()).toBe(1);
    await act(async () => r.root.unmount());
  });

  it("nothing for an agent's line or one already deleted", async () => {
    for (const m of [
      { ...LINE, from: "agent" as const },
      { ...LINE, redacted: { at: 2 } },
    ]) {
      const r = await mount(m);
      expect(r.q("debug-chat-redact")).toBeNull();
      await act(async () => r.root.unmount());
    }
  });
});

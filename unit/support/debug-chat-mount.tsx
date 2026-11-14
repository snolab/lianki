/**
 * DebugChat mounted in happy-dom (a previous change broke mounting with no
 * console error): it renders its log; a spoken draft is the live line
 * (live-speech.ts), the input empty; a failed send offers a retry; a sent one
 * holds as "sending" until its echo and goes in the render the echo appears;
 * typing takes the words into the input; minimized, the line floats.
 *
 * Run by unit/chat-live-speech.test.tsx in its own `bun test` (from unit/support,
 * so the root bunfig is not read): mounting loads the whole widget (React glue no unit suite holds to
 * 90%), which the per-file coverage gate would otherwise count.
 */
import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import type { ChatMessage } from "../../packages/debug-chat/src/wire";

const line = (id: string, text: string, from: ChatMessage["from"] = "owner"): ChatMessage => ({
  id,
  from,
  label: from,
  text,
  at: 1,
});

/** happy-dom as the page: the globals DebugChat and its imports read. */
async function page() {
  const win = new Window({ url: "https://lianki.com/en" });
  const g = globalThis as Record<string, unknown>;
  const w = win as unknown as Record<string, unknown>;
  // The page's own globals win over bun's; the rest of the window fills what bun lacks.
  const own = [
    "window",
    "document",
    "navigator",
    "localStorage",
    "sessionStorage",
    "location",
    "Event",
    "CustomEvent",
  ];
  const keys = [
    ...own,
    ...Object.getOwnPropertyNames(win).filter((k) => !(k in g) && !own.includes(k)),
    // happy-dom has no visual viewport; the page code reads it as optional.
    ...("visualViewport" in g || "visualViewport" in w ? [] : ["visualViewport"]),
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  const saved = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  for (const k of keys)
    Object.defineProperty(g, k, {
      value: k === "IS_REACT_ACT_ENVIRONMENT" ? true : k === "visualViewport" ? null : w[k],
      configurable: true,
      writable: true,
    });
  return {
    win,
    async close() {
      for (const [k, d] of saved)
        if (d) Object.defineProperty(g, k, d);
        else delete g[k];
      await win.happyDOM.close();
    },
  };
}

describe("DebugChat mounts", () => {
  it("renders its log; a spoken draft is the live line, sent it holds until its echo", async () => {
    const p = await page();
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { DebugChat } = await import("../../packages/debug-chat/src/DebugChat");
    const { chatUi } = await import("../../packages/debug-chat/src/ui-store");
    const host = p.win.document.createElement("div");
    p.win.document.body.appendChild(host);
    let root = createRoot(host as never);
    const sent: { text: string; source?: string }[] = [];
    let ok = true;
    const base = [line("o1", "Earlier line."), line("g1", "A reply.", "agent")];
    const props = {
      live: true,
      listeners: 1,
      messages: base,
      onSend: (text: string, _to?: string, opts?: { source?: string }) => {
        if (!ok) return false;
        sent.push({ text, source: opts?.source });
        return true;
      },
    };
    const q = (sel: string) => host.querySelector(sel) as unknown as HTMLElement | null;
    const qa = (sel: string) => [...host.querySelectorAll(sel)] as unknown as HTMLElement[];
    try {
      // Open, with a spoken draft kept from before a reload (ui-store.ts).
      p.win.localStorage.setItem("lk:debug-chat-open", "1");
      chatUi().setState({ draft: "Hello there.", pureDictation: "Hello there.", interim: null });
      await act(() => root.render(<DebugChat {...props} />));
      expect(q('[data-testid="debug-chat-log"]')).not.toBeNull();
      expect(qa('[data-testid="debug-chat-line"]').map((e) => e.dataset.msg)).toEqual(["o1", "g1"]);
      // The restored spoken words: the live line, last, the input empty.
      const liveEl = qa('[data-testid="debug-chat-live"]');
      expect(liveEl.length).toBeGreaterThan(0);
      expect(liveEl.at(-1)!.dataset.live).toBe("speaking");
      expect(liveEl.at(-1)!.textContent).toContain("Hello there.");
      const input = q('[data-testid="debug-chat-input"]') as unknown as HTMLTextAreaElement;
      expect(input.value).toBe("");

      // The send fails (offline): the live line stays, with a retry.
      ok = false;
      await act(async () => {
        input.dispatchEvent(
          new p.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never,
        );
      });
      expect(sent).toEqual([]);
      expect(qa('[data-testid="debug-chat-live"]').at(-1)!.dataset.live).toBe("unsent");
      // Retry, online: sent as the mic's, and held as "sending" with the draft gone.
      ok = true;
      await act(async () => q('[data-testid="debug-chat-live-retry"]')!.click());
      expect(sent).toEqual([{ text: "Hello there.", source: "stt" }]);
      expect(chatUi().getState().draft).toBe("");
      const held = qa('[data-testid="debug-chat-live"]');
      expect(held.map((e) => e.dataset.live)).toEqual(["sending"]);
      expect(held.at(-1)!.textContent).toContain("Hello there.");
      // The echo arrives: the held line goes in that same render, once in the log.
      await act(() =>
        root.render(<DebugChat {...props} messages={[...base, line("o2", "Hello there.")]} />),
      );
      expect(qa('[data-testid="debug-chat-live"]')).toEqual([]);
      expect(
        qa('[data-testid="debug-chat-line"]').filter((e) => e.textContent?.includes("Hello there."))
          .length,
      ).toBe(1);

      // Another spoken draft kept over a reload, then typing starts: the words come
      // into the input to be edited, and the live line goes.
      await act(() => root.unmount());
      chatUi().setState({ draft: "Second.", pureDictation: "Second." });
      root = createRoot(host as never);
      await act(() => root.render(<DebugChat {...props} />));
      expect(qa('[data-testid="debug-chat-live"]').map((e) => e.dataset.live)).toEqual([
        "speaking",
      ]);
      const input2 = q('[data-testid="debug-chat-input"]') as unknown as HTMLTextAreaElement;
      expect(input2.value).toBe("");
      await act(async () => {
        input2.dispatchEvent(
          new p.win.KeyboardEvent("keydown", { key: "x", bubbles: true }) as never,
        );
      });
      expect(input2.value).toBe("Second.");
      expect(qa('[data-testid="debug-chat-live"]')).toEqual([]);
      // Minimized: the live line floats over the pill too.
      await act(() => root.unmount());
      p.win.localStorage.setItem("lk:debug-chat-open", "0");
      chatUi().setState({ draft: "Third.", pureDictation: "Third." });
      root = createRoot(host as never);
      await act(() => root.render(<DebugChat {...props} />));
      expect(q('[data-testid="debug-chat-minimized"]')).not.toBeNull();
      expect(q('[data-testid="debug-chat-live-floats"]')?.textContent).toContain("Third.");
    } finally {
      await act(() => root.unmount());
      chatUi().setState({ draft: "", pureDictation: null, interim: null });
      await p.close();
    }
  });
});

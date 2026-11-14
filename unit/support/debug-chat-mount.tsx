/**
 * DebugChat mounted in happy-dom (a previous change broke mounting with no
 * console error): it renders its log; a spoken draft is the live line
 * (live-speech.ts), the input empty; a failed send retries after the normal pause; a sent one
 * holds as "sending" until its echo and goes in the render the echo appears;
 * typing takes the words into the input; minimized, the line floats; a line
 * read aloud (an agent's, or his own read back in his clone) is highlighted
 * sentence by sentence, a synchronized one only once it starts playing.
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
  it("an unscoped host cannot auto-send legacy input on mount or online; fresh typing still follows its normal pause", async () => {
    const p = await page();
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { DebugChat } = await import("../../packages/debug-chat/src/DebugChat");
    const { chatUi } = await import("../../packages/debug-chat/src/ui-store");
    const host = p.win.document.createElement("div");
    p.win.document.body.appendChild(host);
    const root = createRoot(host as never);
    const sent: string[] = [];
    try {
      p.win.localStorage.setItem("lk:debug-chat-open", "1");
      chatUi().setState({
        draft: "Legacy owner's voice.",
        pureDictation: "Legacy owner's voice.",
        interim: null,
      });
      await act(() =>
        root.render(
          <DebugChat
            live
            listeners={1}
            messages={[]}
            onSend={(text) => {
              sent.push(text);
              return true;
            }}
          />,
        ),
      );
      expect(sent).toEqual([]);
      const old = p.win.sessionStorage.getItem("lk:ui:chat");
      await act(async () => {
        p.win.dispatchEvent(new p.win.Event("online"));
        await new Promise((resolve) => setTimeout(resolve, 3200));
      });
      expect(sent).toEqual([]);
      expect(chatUi().getState()).toMatchObject({
        draft: "Legacy owner's voice.",
        pureDictation: "Legacy owner's voice.",
      });
      expect(p.win.sessionStorage.getItem("lk:ui:chat")).toBe(old);
      expect(host.querySelector('[data-testid="debug-chat-live-retry"]')).toBeNull();

      const input = host.querySelector(
        '[data-testid="debug-chat-input"]',
      ) as unknown as HTMLTextAreaElement;
      await act(async () => {
        input.dispatchEvent(
          new p.win.KeyboardEvent("keydown", { key: "x", bubbles: true }) as never,
        );
        const setter = Object.getOwnPropertyDescriptor(
          p.win.HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(input, "Newly typed words");
        input.dispatchEvent(new p.win.Event("input", { bubbles: true }) as never);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3200));
      });
      expect(sent).toEqual(["Newly typed words"]);
    } finally {
      await act(() => root.unmount());
      chatUi().setState({ draft: "", pureDictation: null, interim: null });
      await p.close();
    }
  }, 15_000);

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
    let ok = false;
    const base = [line("o1", "Earlier line."), line("g1", "A reply.", "agent")];
    const props = {
      draftScope: "fixture-account",
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
      chatUi("fixture-account").setState({
        draft: "Hello there.",
        pureDictation: "Hello there.",
        interim: null,
      });
      await act(() => root.render(<DebugChat {...props} />));
      expect(q('[data-testid="debug-chat-log"]')).not.toBeNull();
      expect(qa('[data-testid="debug-chat-line"]').map((e) => e.dataset.msg)).toEqual(["o1", "g1"]);
      // The restored spoken words: the live line, last, the input empty.
      const liveEl = qa('[data-testid="debug-chat-live"]');
      expect(liveEl.length).toBeGreaterThan(0);
      expect(liveEl.at(-1)!.dataset.live).toBe("unsent");
      expect(liveEl.at(-1)!.textContent).toContain("Hello there.");
      const input = q('[data-testid="debug-chat-input"]') as unknown as HTMLTextAreaElement;
      expect(input.value).toBe("");

      // A transient send failure keeps the live line without a retry button.
      ok = false;
      await act(async () => {
        input.dispatchEvent(
          new p.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never,
        );
      });
      expect(sent).toEqual([]);
      expect(qa('[data-testid="debug-chat-live"]').at(-1)!.dataset.live).toBe("unsent");
      expect(q('[data-testid="debug-chat-live-retry"]')).toBeNull();
      // A browser reconnect resumes it automatically, with no retry interaction.
      ok = true;
      await act(async () => {
        p.win.dispatchEvent(new p.win.Event("online"));
        await new Promise((resolve) => setTimeout(resolve, 3200));
      });
      expect(sent).toEqual([{ text: "Hello there.", source: "stt" }]);
      expect(chatUi("fixture-account").getState().draft).toBe("");
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
      ok = false;
      chatUi("fixture-account").setState({ draft: "Second.", pureDictation: "Second." });
      root = createRoot(host as never);
      await act(() => root.render(<DebugChat {...props} />));
      expect(qa('[data-testid="debug-chat-live"]').map((e) => e.dataset.live)).toEqual(["unsent"]);
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
      chatUi("fixture-account").setState({ draft: "Third.", pureDictation: "Third." });
      root = createRoot(host as never);
      await act(() => root.render(<DebugChat {...props} />));
      expect(q('[data-testid="debug-chat-minimized"]')).not.toBeNull();
      expect(q('[data-testid="debug-chat-live-floats"]')?.textContent).toContain("Third.");
    } finally {
      await act(() => root.unmount());
      chatUi("fixture-account").setState({ draft: "", pureDictation: null, interim: null });
      await p.close();
    }
  });
});

describe("DebugChat highlights the line read aloud", () => {
  it("an agent line and his own read-back, each sentence as it plays (after a sync wait)", async () => {
    const p = await page();
    const g = globalThis as Record<string, unknown>;
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { createVoice } = await import("../../packages/debug-chat/src/voice");
    // A fake session in the page's shared slot (voice.ts voice()): a fake clock, no sound.
    let t = Date.now();
    const timers = new Set<{ f: () => void; at: number }>();
    const setTimer = (f: () => void, ms: number) => {
      const x = { f, at: t + ms };
      timers.add(x);
      return x;
    };
    const advance = (ms: number) => {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        t = Math.max(t, due.at);
        due.f();
      }
      t = end;
    };
    type U = { onstart?: (() => void) | null; onend?: (() => void) | null };
    const v = createVoice({
      synth: () => ({
        speak: (u) => {
          setTimer(() => (u as U).onstart?.(), 5);
          setTimer(() => (u as U).onend?.(), 1_000);
        },
        cancel() {},
      }),
      utter: (text, lang) =>
        ({ text, lang, onend: null, onerror: null, onboundary: null, onstart: null }) as never,
      enabled: () => true,
      here: () => true,
      now: () => t,
      setTimer,
      clearTimer: (x) => void timers.delete(x as never),
    });
    g.__lkVoice = v;
    const { DebugChat } = await import("../../packages/debug-chat/src/DebugChat");
    const { clearReadback } = await import("../../packages/debug-chat/src/polish-readback");
    const host = p.win.document.createElement("div");
    p.win.document.body.appendChild(host);
    const root = createRoot(host as never);
    const reads = (id: string) =>
      [...host.querySelectorAll(`[data-msg="${id}"] [data-read]`)].map(
        (e) => (e as unknown as HTMLElement).dataset.read,
      );
    try {
      p.win.localStorage.setItem("lk:debug-chat-open", "1");
      const base = [line("o1", "Earlier line."), line("g1", "A reply.", "agent")];
      const props = { live: true, listeners: 1, onSend: () => true };
      await act(() => root.render(<DebugChat {...props} messages={base} />));
      // An agent line, stamped to start in step with his other device in 300 ms.
      const a = line("g2", "Une phrase. Une autre.", "agent");
      await act(async () => {
        root.render(<DebugChat {...props} messages={[...base, a]} />);
        v.reply(a.text, a, { live: true, startAt: t + 300 });
      });
      expect(reads("g2")).toEqual(["unread", "unread"]);
      await act(async () => advance(299));
      expect(reads("g2")).toEqual(["unread", "unread"]);
      await act(async () => advance(6));
      expect(reads("g2")).toEqual(["speaking", "unread"]);
      await act(async () => advance(1_000));
      expect(reads("g2")).toEqual(["spoken", "speaking"]);
      await act(async () => advance(1_000));
      expect(reads("g2")).toEqual(["spoken", "spoken"]);

      // His own voice line, polished, read back in his clone (polish-readback.ts):
      // it was heard with no highlight at all; now it reads like an agent line.
      const o: ChatMessage = {
        ...line("o2", "Deux phrases. Les voici."),
        source: "stt",
        raw: "deux phrases les voici",
        edited: { at: 2, by: "main", count: 1 },
      };
      await act(() => root.render(<DebugChat {...props} messages={[...base, a, o]} />));
      expect(reads("o2")).toEqual([]);
      const { polishReadback } = await import("../../packages/debug-chat/src/polish-readback");
      await act(async () => {
        polishReadback(
          { ...o, text: o.raw!, edited: undefined },
          { id: o.id, thread: "owner", text: o.text, raw: o.raw!, edited: o.edited! },
          {
            on: () => true,
            base: () => "https://clone.test",
            reply: (text, meta) => v.reply(text, meta),
          },
        );
      });
      await act(async () => advance(5));
      expect(reads("o2")).toEqual(["speaking", "unread"]);
      await act(async () => advance(2_000));
      expect(reads("o2")).toEqual(["spoken", "spoken"]);
    } finally {
      await act(() => root.unmount());
      clearReadback();
      delete g.__lkVoice;
      await p.close();
    }
  });
});

/**
 * M3 of Li chat from the userscript pill (docs/userscript-li-chat.md): the
 * real DebugChat, embedded as in the pill's frame, mounted in happy-dom. A
 * share fills the draft or the chip and nothing goes out until he presses
 * Enter, not even after typing and the 3 s typing pause.
 *
 * Run by unit/pill-chat-share.test.ts in its own `bun test` (from unit/mount,
 * so the root bunfig and its per-file coverage gate are not read): mounting
 * loads the whole widget. Same happy-dom page as unit/support/debug-chat-mount.tsx.
 */
import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";

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

describe("DebugChat in the pill's frame", () => {
  // M3 (docs/userscript-li-chat.md): Share from the pill's Li frame never sends.
  it("a share fills the draft or the chip; nothing goes out until he presses Enter, not even after typing", async () => {
    const p = await page();
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { DebugChat } = await import("../../packages/debug-chat/src/DebugChat");
    const { chatUi } = await import("../../packages/debug-chat/src/ui-store");
    const host = p.win.document.createElement("div");
    p.win.document.body.appendChild(host);
    const root = createRoot(host as never);
    const sent: { text: string; context?: unknown }[] = [];
    const asked: string[] = [];
    const wait = (ms: number) =>
      act(async () => void (await new Promise((r) => setTimeout(r, ms))));
    const $ = (id: string) =>
      host.querySelector(`[data-testid="${id}"]`) as unknown as HTMLElement | null;
    const press = async (el: HTMLElement | null, trusted = true) => {
      await act(async () => {
        const e = new p.win.MouseEvent("click", { bubbles: true }) as unknown as Event;
        if (trusted) Object.defineProperty(e, "isTrusted", { value: true });
        el!.dispatchEvent(e);
        await new Promise((r) => setTimeout(r, 10));
      });
    };
    try {
      p.win.localStorage.setItem("lk:debug-chat-open", "1");
      chatUi().setState({ draft: "", pureDictation: null, interim: null, attached: null });
      await act(() =>
        root.render(
          <DebugChat
            embedded
            attach={false}
            live
            listeners={1}
            messages={[]}
            share={async (what) => {
              asked.push(what);
              return what === "page"
                ? { what, title: "[x](javascript:1) Story", url: "https://news.example/a" }
                : {
                    what,
                    title: "Story",
                    url: "https://news.example/a",
                    selection: "chosen words",
                  };
            }}
            onSend={(text, _to, opts) => {
              sent.push({ text, context: opts?.context });
              return true;
            }}
          />,
        ),
      );
      expect(asked).toEqual([]); // nothing read from the page by itself
      await press($("debug-chat-attach"));
      expect($("debug-chat-share-page")).not.toBeNull();
      // A scripted (untrusted) press does nothing.
      await press($("debug-chat-share-page"), false);
      expect(asked).toEqual([]);
      await press($("debug-chat-share-page"));
      expect(asked).toEqual(["page"]);
      const input = $("debug-chat-input") as unknown as HTMLTextAreaElement;
      expect(input.value).toBe("\\[x\\](javascript:1) Story\nhttps://news.example/a");
      await wait(3300);
      expect(sent).toEqual([]);
      // He types a word: the typing debounce stays off while the share waits.
      await act(async () => {
        input.dispatchEvent(
          new p.win.KeyboardEvent("keydown", { key: "x", bubbles: true }) as never,
        );
        const setter = Object.getOwnPropertyDescriptor(
          p.win.HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(input, `${input.value} ok?`);
        input.dispatchEvent(new p.win.Event("input", { bubbles: true }) as never);
      });
      await wait(3300);
      expect(sent).toEqual([]);
      await press($("debug-chat-attach"));
      await press($("debug-chat-share-selection"));
      expect(asked).toEqual(["page", "selection"]);
      expect(host.textContent).toContain("chosen words");
      await wait(3300);
      expect(sent).toEqual([]);
      // His press sends it, once, with the selection attached.
      await act(async () => {
        input.dispatchEvent(
          new p.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never,
        );
      });
      expect(sent.length).toBe(1);
      expect(sent[0]!.text).toContain("https://news.example/a");
      expect(sent[0]!.context).toMatchObject({
        selection: "chosen words",
        host: "news.example",
        path: "/a",
      });
    } finally {
      await act(() => root.unmount());
      chatUi().setState({ draft: "", pureDictation: null, interim: null, attached: null });
      await p.close();
    }
  }, 20_000);
});

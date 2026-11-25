import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { stubGlobals } from "./support/globals";
import ChatLaunch from "../app/(app)/chat/ChatLaunch";

test("the direct chat route opens the existing chat UI and links only to a safe source", async () => {
  const win = new Window({ url: "https://lianki.com/chat?from=https%3A%2F%2Fexample.test" });
  const restore = stubGlobals({
    window: win,
    document: win.document,
    navigator: win.navigator,
    CustomEvent: win.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let root: ReturnType<typeof import("react-dom/client").createRoot> | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const host = win.document.createElement("div");
    win.document.body.append(host);
    const actions: unknown[] = [];
    win.addEventListener("lk:island-action", (e) =>
      actions.push((e as unknown as CustomEvent).detail),
    );
    root = createRoot(host as never);
    const props = {
      title: "Portable Li",
      openText: "Open Li chat",
      source: "https://example.test/path?private=hidden#secret",
      returnText: "Return to {host}",
    };
    await act(() => root!.render(createElement(ChatLaunch, props)));
    expect(actions).toEqual([{ name: "chat.open", payload: {} }]);
    const link = host.querySelector('[data-testid="portable-chat-return"]')!;
    expect(link.getAttribute("href")).toBe("https://example.test");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(host.textContent).not.toContain("hidden");
    await act(() => host.querySelector("button")!.click());
    expect(actions).toHaveLength(2);
    await act(() =>
      root!.render(createElement(ChatLaunch, { ...props, source: "javascript:alert(1)" })),
    );
    expect(host.querySelector('[data-testid="portable-chat-return"]')).toBeNull();
    expect(actions).toHaveLength(2);
  } finally {
    if (root) await act(() => root!.unmount());
    restore();
    await win.happyDOM.close();
  }
});

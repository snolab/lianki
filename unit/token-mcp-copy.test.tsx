import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, act } from "react";
import { stubGlobals } from "./support/globals";
import { McpConnectionCopy } from "../app/(app)/my/preferences/McpConnectionCopy";

test("copies a complete MCP URL only on click, resets for a new secret and handles clipboard refusal", async () => {
  const win = new Window();
  const token = `lk_${"a".repeat(64)}`;
  const copied: string[] = [];
  let refuse = false,
    errors = 0;
  const restore = stubGlobals({
    window: win,
    document: win.document,
    navigator: {
      userAgent: win.navigator.userAgent,
      clipboard: {
        writeText: async (text: string) => {
          if (refuse) throw Error("denied");
          copied.push(text);
        },
      },
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let root: ReturnType<typeof import("react-dom/client").createRoot> | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const host = win.document.createElement("div");
    win.document.body.append(host);
    root = createRoot(host as never);
    const render = (secret: string) =>
      root!.render(
        createElement(McpConnectionCopy, {
          token: secret,
          label: "Copy URL",
          copiedLabel: "Copied",
          onError: () => errors++,
        }),
      );
    await act(() => render(token));
    expect(copied).toEqual([]);
    expect(host.innerHTML).not.toContain(token);
    const button = host.querySelector("button") as any;
    await act(async () => button.click());
    expect(copied).toEqual([`https://lianki.com/mcp/${token}`]);
    expect(button.textContent).toBe("Copied");
    await act(() => render(`lk_${"b".repeat(64)}`));
    expect(button.textContent).toBe("Copy URL");
    refuse = true;
    await act(async () => button.click());
    expect(errors).toBe(1);
    expect(copied).toHaveLength(1);
  } finally {
    if (root) await act(() => root!.unmount());
    restore();
    await win.happyDOM.close();
  }
});

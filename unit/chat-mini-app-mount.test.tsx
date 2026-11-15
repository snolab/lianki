import { expect, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";
import { stubGlobals } from "./support/globals";
import type { MiniAppCardsProps } from "../packages/debug-chat/src/MiniAppCards";

test("cards load metadata without executing, open a bounded panel, and isolate scopes", async () => {
  const win = new Window({ url: "https://preview.lianki.com/en" });
  const pending: {
    url: string;
    signal: AbortSignal;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  const restore = stubGlobals({
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (url: string, opts: { signal: AbortSignal }) =>
      new Promise((resolve, reject) => pending.push({ url, signal: opts.signal, resolve, reject })),
  });
  const { createRoot } = await import("react-dom/client");
  const { MiniAppCards } = await import("../packages/debug-chat/src/MiniAppCards");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  let enclosingClicks = 0;
  let enclosingMenus = 0;
  let props: MiniAppCardsProps = {
    text: "Open /m/demo",
    scope: "A",
    labels: {
      open: "Open",
      close: "Close",
      fullscreen: "Expand",
      exitFullscreen: "Restore",
      resize: "Resize",
      loading: "Loading",
      unavailable: "Unavailable",
    },
    sizing: { height: 360, minHeight: 160, step: 24 },
    renderHost: (view) => (
      <iframe
        data-testid="fixture-host"
        title={view.name}
        sandbox={view.frame.sandbox}
        srcDoc={view.frame.srcdoc}
      />
    ),
  };
  const render = async (change: Partial<typeof props> = {}) => {
    props = { ...props, ...change };
    await act(async () =>
      root.render(
        <div onClick={() => enclosingClicks++} onContextMenu={() => enclosingMenus++}>
          <MiniAppCards {...props} />
        </div>,
      ),
    );
  };
  const query = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const click = async (id: string) => {
    await act(async () => query(id).click());
  };
  const response = (slug = "demo") => ({
    ok: true,
    json: async () => ({
      view: {
        slug,
        name: "Demo app",
        icon: "☆",
        version: "1.0.0",
        style: "none",
        permissions: [],
        grants: {},
        frame: {
          mode: "srcdoc",
          sandbox: "allow-scripts allow-forms",
          srcdoc: "<p>Local fixture</p>",
        },
      },
    }),
  });
  const key = async (value: string) => {
    await act(async () =>
      query("mini-app-resize").dispatchEvent(
        new win.KeyboardEvent("keydown", { key: value, bubbles: true }) as unknown as Event,
      ),
    );
  };
  const pointer = async (type: string, values: Record<string, number> = {}) => {
    await act(async () =>
      query("mini-app-resize").dispatchEvent(
        new win.PointerEvent(type, {
          pointerId: 1,
          clientY: 100,
          button: 0,
          bubbles: true,
          ...values,
        }) as unknown as Event,
      ),
    );
  };
  try {
    await render();
    expect(pending[0]!.url).toBe("https://preview.lianki.com/api/my/mini-apps/demo?embed=1");
    expect(query("fixture-host")).toBeNull();
    await click("mini-app-open");
    expect(query("mini-app-overlay").style.zIndex).toBe("calc(var(--lk-z-chat, 80) + 1)");
    expect(document.body.textContent).toContain("Loading");
    await act(async () =>
      query("mini-app-card").dispatchEvent(
        new win.MouseEvent("contextmenu", { bubbles: true }) as unknown as Event,
      ),
    );
    expect(enclosingClicks).toBe(0);
    expect(enclosingMenus).toBe(0);
    await act(async () => pending[0]!.resolve(response()));
    expect(query("fixture-host").getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(query("mini-app-card").textContent).toContain("Demo app");
    expect(query("mini-app-panel").style.height).toBe("360px");
    await key("ArrowUp");
    expect(query("mini-app-panel").style.height).toBe("384px");
    await key("a");
    expect(query("mini-app-panel").style.height).toBe("384px");
    await pointer("pointerdown", { button: 2 });
    await pointer("pointermove", { clientY: 50 });
    expect(query("mini-app-panel").style.height).toBe("384px");
    await pointer("pointerdown");
    await pointer("pointermove", { pointerId: 2, clientY: 50 });
    expect(query("mini-app-panel").style.height).toBe("384px");
    await pointer("pointermove", { clientY: 50 });
    expect(query("mini-app-panel").style.height).toBe("434px");
    await pointer("pointerup");
    await pointer("pointermove", { clientY: 0 });
    expect(query("mini-app-panel").style.height).toBe("434px");
    await pointer("pointerdown");
    await pointer("pointercancel");
    await click("mini-app-fullscreen");
    expect(query("mini-app-panel").dataset.fullscreen).toBe("true");
    expect(query("mini-app-resize")).toBeNull();
    await click("mini-app-fullscreen");
    expect(query("mini-app-panel").dataset.fullscreen).toBeUndefined();
    Object.defineProperty(win, "innerHeight", { value: 100, configurable: true });
    await act(async () => win.dispatchEvent(new win.Event("resize")));
    expect(query("mini-app-panel").style.height).toBe("100px");
    // A nested permission dialog handles its own Escape instead of closing the app panel.
    const nested = document.createElement("div");
    nested.setAttribute("role", "dialog");
    query("mini-app-panel").append(nested);
    await act(async () =>
      nested.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event,
      ),
    );
    expect(query("mini-app-panel")).not.toBeNull();
    nested.remove();
    await act(async () =>
      query("mini-app-panel").dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event,
      ),
    );
    expect(query("mini-app-panel")).toBeNull();
    await click("mini-app-open");
    await click("mini-app-close");
    expect(enclosingClicks).toBe(0);
    await render({ scope: "B", origin: "https://preview.lianki.com" });
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(query("mini-app-panel")).toBeNull();
    expect(query("mini-app-card").textContent).not.toContain("Demo app");
    await click("mini-app-open");
    await act(async () => pending[1]!.resolve({ ok: false }));
    expect(document.body.textContent).toContain("Unavailable");
    await render({ scope: "C" });
    await act(async () => pending[2]!.reject(new Error("offline")));
    await click("mini-app-open");
    expect(document.body.textContent).toContain("Unavailable");
    await render({ scope: "D" });
    const stale = pending[3]!;
    await render({ scope: "E" });
    expect(stale.signal.aborted).toBe(true);
    await act(async () => stale.resolve(response()));
    expect(query("mini-app-card").textContent).not.toContain("Demo app");
    await act(async () =>
      pending[4]!.resolve({ ok: true, json: async () => ({ view: { bad: true } }) }),
    );
    await click("mini-app-open");
    expect(document.body.textContent).toContain("Unavailable");
    await act(async () => root.unmount());
    mounted = false;
    expect(pending[4]!.signal.aborted).toBe(true);
  } finally {
    if (mounted) await act(async () => root.unmount());
    restore();
    await win.happyDOM.close();
  }
});

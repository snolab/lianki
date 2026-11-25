import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { useMessageDisplays } from "../packages/debug-chat/src/use-message-displays";
import { messageTelemetry } from "../packages/debug-chat/src/message-telemetry";

test("display timing requires visible viewport intersection and stops after unmount", async () => {
  const win = new Window({ url: "https://example.test" });
  const g = globalThis as Record<string, unknown>;
  const values = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: win.getComputedStyle.bind(win),
  };
  const saved = new Map(
    [...Object.keys(values), "IntersectionObserver"].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(g, k),
    ]),
  );
  const define = (k: string, value: unknown) =>
    Object.defineProperty(g, k, { value, configurable: true, writable: true });
  for (const [k, v] of Object.entries(values)) define(k, v);
  let observer: { fire: () => void; disconnected: boolean };
  let intersect = false;
  let visible = "hidden";
  Object.defineProperty(win.document, "visibilityState", {
    get: () => visible,
    configurable: true,
  });
  class Observer {
    disconnected = false;
    constructor(private callback: (entries: unknown[]) => void) {
      observer = { fire: () => this.fire(), disconnected: false };
      Object.defineProperty(observer, "disconnected", { get: () => this.disconnected });
    }
    observe() {
      this.disconnected = false;
    }
    disconnect() {
      this.disconnected = true;
    }
    fire() {
      this.callback([
        { target: line, isIntersecting: intersect, intersectionRect: { width: 20, height: 10 } },
      ]);
    }
  }
  define("IntersectionObserver", Observer);
  const container = win.document.createElement("div");
  const frame = win.document.createElement("section");
  const line = win.document.createElement("span");
  line.setAttribute("data-msg", "visible-message");
  line.setAttribute("data-testid", "debug-chat-compact-line");
  line.style.visibility = "visible";
  frame.append(line);
  win.document.body.append(container, frame);
  const metrics = messageTelemetry();
  metrics.configure({ sampleRate: 0, log: () => {} });
  metrics.received({ id: "visible-message", from: "agent" });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  function Fixture() {
    useMessageDisplays(
      { current: frame as unknown as HTMLElement },
      { messages: 1, open: true, compact: true, fullLog: "off", tree: false },
    );
    return null;
  }
  try {
    act(() => root.render(<Fixture />));
    act(() => observer!.fire());
    expect(metrics.snapshot()[0]?.displayedAt).toBeUndefined();
    visible = "visible";
    act(() => win.document.dispatchEvent(new win.Event("visibilitychange")));
    act(() => observer!.fire());
    expect(metrics.snapshot()[0]?.displayedAt).toBeUndefined();
    intersect = true;
    act(() => observer!.fire());
    expect(metrics.snapshot()[0]?.displayedAt).toBeNumber();
    act(() => root.unmount());
    expect(observer!.disconnected).toBe(true);
  } finally {
    metrics.configure({ log: null });
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(g, k, descriptor);
      else delete g[k];
    }
    await win.happyDOM.close();
  }
});

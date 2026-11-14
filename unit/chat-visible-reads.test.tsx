import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useVisibleReads } from "../packages/debug-chat/src/use-visible-reads";

test("mounted viewport reads respect visibility, scope, teardown and controlled throttling", async () => {
  const win = new Window({ url: "https://example.test" });
  const g = globalThis as Record<string, unknown>;
  const keys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "IS_REACT_ACT_ENVIRONMENT",
    "IntersectionObserver",
    "setTimeout",
    "clearTimeout",
  ];
  const saved = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  const oldNow = Date.now;
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { callback: () => void; at: number }>();
  const observers: FakeObserver[] = [];
  class FakeObserver {
    nodes: Element[] = [];
    disconnected = false;
    constructor(
      readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void,
    ) {
      observers.push(this);
    }
    observe(el: Element) {
      this.nodes.push(el);
    }
    disconnect() {
      this.disconnected = true;
    }
    fire(target: Element, isIntersecting = true) {
      this.callback([{ target, isIntersecting }]);
    }
  }
  const define = (key: string, value: unknown) =>
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
  for (const k of ["window", "document", "navigator", "HTMLElement", "Element"])
    define(k, k === "window" ? win : (win as unknown as Record<string, unknown>)[k]);
  define("IS_REACT_ACT_ENVIRONMENT", true);
  define("IntersectionObserver", FakeObserver);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let unmounted = false;
  const scroller = document.createElement("div");
  document.body.append(scroller);
  const line = document.createElement("span");
  line.dataset.testid = "debug-chat-line";
  line.dataset.readSeq = "1";
  scroller.append(line);
  const rect = (top: number, bottom: number, left = 0, right = 100) =>
    ({ top, bottom, left, right }) as DOMRect;
  scroller.getBoundingClientRect = () => rect(0, 100);
  let lineRect = rect(10, 20);
  line.getClientRects = () => [lineRect] as unknown as DOMRectList;
  let visibility = "visible";
  Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });
  let props: Parameters<typeof useVisibleReads>[0] = {
    root: { current: scroller },
    enabled: true,
    scope: "A",
    messages: 0,
    throttleMs: 2000,
    onReadSeq: (seq) => sent.push(seq),
  };
  const sent: number[] = [];
  function Fixture() {
    useVisibleReads(props);
    return null;
  }
  const render = async (change: Partial<typeof props> = {}) => {
    props = { ...props, ...change };
    await act(async () => root.render(<Fixture />));
  };
  const latest = () => observers.at(-1)!;
  const setSeq = (seq: number) => {
    line.dataset.readSeq = String(seq);
  };
  const advance = (ms: number) => {
    now += ms;
    // Snapshot: callbacks may schedule another timer while this clock tick runs.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const [id, t] of [...timers])
      if (t.at <= now) {
        timers.delete(id);
        t.callback();
      }
  };
  try {
    // Early-return branches never start observation.
    await render({ enabled: false });
    await render({ enabled: true, onReadSeq: undefined });
    await render({ onReadSeq: (seq) => sent.push(seq), root: { current: null } });
    define("IntersectionObserver", undefined);
    await render({ root: { current: scroller } });
    expect(observers).toHaveLength(0);
    define("IntersectionObserver", FakeObserver);
    await render({ messages: 1 });
    expect(latest().nodes).toEqual([line]);
    Date.now = () => now;
    define("setTimeout", (callback: () => void, delay: number) => {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    });
    define("clearTimeout", (id: number) => {
      timers.delete(id);
    });
    latest().fire(line, false);
    lineRect = rect(110, 120);
    latest().fire(line);
    visibility = "hidden";
    lineRect = rect(10, 20);
    latest().fire(line);
    visibility = "visible";
    scroller.hidden = true;
    latest().fire(line);
    expect(sent).toEqual([]);
    scroller.hidden = false;
    latest().fire(line);
    expect(sent).toEqual([1]);
    setSeq(2);
    latest().fire(line);
    setSeq(3);
    latest().fire(line);
    expect(timers.size).toBe(1);
    advance(1999);
    expect(sent).toEqual([1]);
    advance(1);
    expect(sent).toEqual([1, 3]);
    setSeq(4);
    latest().fire(line);
    visibility = "hidden";
    document.dispatchEvent(new win.Event("visibilitychange") as unknown as Event);
    expect(timers.size).toBe(0);
    visibility = "visible";
    document.dispatchEvent(new win.Event("visibilitychange") as unknown as Event);
    expect(timers.size).toBe(1);
    // Visual viewport excludes a line covered by the mobile keyboard and a zoomed-outside area.
    const viewport = new win.EventTarget();
    Object.assign(viewport, { offsetTop: 30, offsetLeft: 30, height: 40, width: 40 });
    Object.defineProperty(win, "visualViewport", { value: viewport, configurable: true });
    setSeq(5);
    lineRect = rect(10, 20);
    latest().fire(line);
    lineRect = rect(40, 50, 0, 20);
    latest().fire(line);
    advance(2000);
    expect(sent).toEqual([1, 3, 4]);
    lineRect = rect(40, 50, 40, 50);
    await render({ messages: 2 });
    viewport.dispatchEvent(new win.Event("resize"));
    viewport.dispatchEvent(new win.Event("scroll"));
    advance(2000);
    expect(sent).toEqual([1, 3, 4, 5]);
    // Listener cleanup on a viewport-equipped effect and timer cleanup on unmount.
    await render({ messages: 3 });
    setSeq(6);
    latest().fire(line);
    const old = latest();
    const lateTimer = [...timers.values()][0]!.callback;
    await render({ scope: "B" });
    expect(old.disconnected).toBe(true);
    old.fire(line);
    lateTimer();
    expect(sent).toEqual([1, 3, 4, 5]);
    setSeq(1);
    latest().fire(line);
    expect(sent).toEqual([1, 3, 4, 5, 1]);
    const disabled = latest();
    await render({ enabled: false });
    setSeq(9);
    disabled.fire(line);
    expect(sent.at(-1)).toBe(1);
    await render({ enabled: true });
    setSeq(2);
    latest().fire(line);
    const lastObserver = latest();
    await act(async () => root.unmount());
    unmounted = true;
    lastObserver.fire(line);
    viewport.dispatchEvent(new win.Event("resize"));
    expect(timers.size).toBe(0);
    expect(sent).toEqual([1, 3, 4, 5, 1]);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    Date.now = oldNow;
    for (const [k, descriptor] of saved)
      if (descriptor) Object.defineProperty(g, k, descriptor);
      else delete g[k];
    await win.happyDOM.close();
  }
});

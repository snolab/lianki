import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { useVisibleReads } from "../packages/debug-chat/src/use-visible-reads";

// IntersectionObserver and time advance only through fire()/advance(); no sleeps or async act.
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
      act(() => this.callback([{ target, isIntersecting }]));
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
  const { createRoot } = await import("react-dom/client");
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
  // The fixture has no async work: synchronous act flushes effects without React's
  // async-act scheduling timers being mistaken for the hook's throttle timer.
  const render = (change: Partial<typeof props> = {}) => {
    props = { ...props, ...change };
    act(() => root.render(<Fixture />));
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
        act(() => t.callback());
      }
  };
  try {
    Date.now = () => now;
    define("setTimeout", (callback: () => void, delay: number) => {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    });
    define("clearTimeout", (id: number) => {
      timers.delete(id);
    });
    // Early-return branches never start observation.
    render({ enabled: false });
    render({ enabled: true, onReadSeq: undefined });
    render({ onReadSeq: (seq) => sent.push(seq), root: { current: null } });
    define("IntersectionObserver", undefined);
    render({ root: { current: scroller } });
    expect(observers).toHaveLength(0);
    define("IntersectionObserver", FakeObserver);
    render({ messages: 1 });
    expect(latest().nodes).toEqual([line]);
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
    render({ messages: 2 });
    viewport.dispatchEvent(new win.Event("resize"));
    viewport.dispatchEvent(new win.Event("scroll"));
    advance(2000);
    expect(sent).toEqual([1, 3, 4, 5]);
    // Listener cleanup on a viewport-equipped effect and timer cleanup on unmount.
    render({ messages: 3 });
    setSeq(6);
    latest().fire(line);
    const old = latest();
    const lateTimer = [...timers.values()][0]!.callback;
    render({ scope: "B" });
    expect(old.disconnected).toBe(true);
    old.fire(line);
    lateTimer();
    expect(sent).toEqual([1, 3, 4, 5]);
    setSeq(1);
    latest().fire(line);
    expect(sent).toEqual([1, 3, 4, 5, 1]);
    const disabled = latest();
    render({ enabled: false });
    setSeq(9);
    disabled.fire(line);
    expect(sent.at(-1)).toBe(1);
    render({ enabled: true });
    setSeq(2);
    latest().fire(line);
    const lastObserver = latest();
    expect(timers.size).toBe(1); // A real pending read notification must be cancelled.
    act(() => root.unmount());
    unmounted = true;
    lastObserver.fire(line);
    viewport.dispatchEvent(new win.Event("resize"));
    expect(timers.size).toBe(0);
    advance(10_000); // No notification can escape teardown, even after its old deadline.
    expect(sent).toEqual([1, 3, 4, 5, 1]);
  } finally {
    if (!unmounted) act(() => root.unmount());
    Date.now = oldNow;
    for (const [k, descriptor] of saved)
      if (descriptor) Object.defineProperty(g, k, descriptor);
      else delete g[k];
    await win.happyDOM.close();
  }
});

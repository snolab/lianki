/**
 * The Learning Partner's lianki.com frame (docs/dev-debug-widget.md, "The
 * frame"): the protocol's checks, the frame's side (frame-guest.ts) and the
 * userscript's shell (src/partner-frame.ts), with a fake DOM and real
 * MessageChannels. The real-browser handshake (allowed and CSP-blocked) is in
 * scripts/qa/qa-partner-embed.ts.
 */
import { describe, expect, it } from "bun:test";
import {
  FRAME_UP,
  HELLO,
  MAX_H,
  MIN_W,
  frameBlocked,
  frameUrl,
  helloFrom,
  isFrameUp,
  portMsg,
} from "@lianki/debug-chat/embed/frame-protocol";
import { startFrameGuest } from "@lianki/debug-chat/embed/frame-guest";
import { frameShell } from "@/src/partner-frame";

const ORIGIN = "https://lianki.com";
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("frame protocol checks", () => {
  it("frame-up only from our frame window, on the app origin", () => {
    const fw = {};
    expect(isFrameUp({ source: fw, origin: ORIGIN, data: { lk: FRAME_UP } }, fw, ORIGIN)).toBe(
      true,
    );
    expect(isFrameUp({ source: {}, origin: ORIGIN, data: { lk: FRAME_UP } }, fw, ORIGIN)).toBe(
      false,
    );
    expect(
      isFrameUp({ source: fw, origin: "https://evil.example", data: { lk: FRAME_UP } }, fw, ORIGIN),
    ).toBe(false);
    expect(isFrameUp({ source: fw, origin: ORIGIN, data: "x" }, fw, ORIGIN)).toBe(false);
    expect(isFrameUp({ source: null, origin: ORIGIN, data: { lk: FRAME_UP } }, null, ORIGIN)).toBe(
      false,
    );
  });

  it("a hello needs the parent as source and a port; the label is bounded", () => {
    const parent = {};
    const port = {};
    expect(
      helloFrom(
        { source: parent, data: { lk: HELLO, label: "x".repeat(400) }, ports: [port] },
        parent,
      ),
    ).toEqual({
      port,
      label: "x".repeat(300),
    });
    expect(helloFrom({ source: parent, data: { lk: HELLO }, ports: [port] }, parent)?.label).toBe(
      "",
    );
    expect(helloFrom({ source: {}, data: { lk: HELLO }, ports: [port] }, parent)).toBeNull();
    expect(helloFrom({ source: parent, data: { lk: HELLO }, ports: [] }, parent)).toBeNull();
    expect(helloFrom({ source: parent, data: { lk: "other" }, ports: [port] }, parent)).toBeNull();
  });

  it("port messages are checked and sizes clamped", () => {
    expect(portMsg({ type: "ready" })).toEqual({ type: "ready" });
    expect(portMsg({ type: "need-ticket" })).toEqual({ type: "need-ticket" });
    expect(portMsg({ type: "ticket", ticket: "a.b" })).toEqual({ type: "ticket", ticket: "a.b" });
    expect(portMsg({ type: "ticket", ticket: 5 })).toEqual({ type: "ticket", ticket: null });
    expect(portMsg({ type: "ticket", ticket: "x".repeat(2000) })).toEqual({
      type: "ticket",
      ticket: null,
    });
    expect(portMsg({ type: "size", w: 1, h: 99999 })).toEqual({ type: "size", w: MIN_W, h: MAX_H });
    expect(portMsg({ type: "size", w: "a", h: 1 })).toBeNull();
    expect(portMsg({ type: "eval", code: "x" })).toBeNull();
    expect(portMsg(null)).toBeNull();
  });

  it("a CSP report refusing our frame (frame-src, child-src, default-src) blocks; others do not", () => {
    expect(
      frameBlocked(
        { effectiveDirective: "frame-src", blockedURI: `${ORIGIN}/embed/partner` },
        ORIGIN,
      ),
    ).toBe(true);
    expect(
      frameBlocked({ violatedDirective: "child-src 'self'", blockedURI: ORIGIN }, ORIGIN),
    ).toBe(true);
    expect(
      frameBlocked({ effectiveDirective: "frame-src", blockedURI: "https://ads.example" }, ORIGIN),
    ).toBe(false);
    expect(frameBlocked({ effectiveDirective: "connect-src", blockedURI: ORIGIN }, ORIGIN)).toBe(
      false,
    );
    expect(frameBlocked({}, ORIGIN)).toBe(false);
    expect(frameUrl(ORIGIN)).toBe("https://lianki.com/embed/partner");
  });
});

// ── the frame's side ─────────────────────────────────────────────────────────

function fakeWin() {
  const listeners = new Set<(e: MessageEvent) => void>();
  const sentUp: [unknown, string][] = [];
  const parent = { postMessage: (m: unknown, t: string) => void sentUp.push([m, t]) };
  return {
    parent,
    sentUp,
    listeners,
    addEventListener: (_t: string, f: (e: MessageEvent) => void) => void listeners.add(f),
    removeEventListener: (_t: string, f: (e: MessageEvent) => void) => void listeners.delete(f),
    fire(e: Partial<MessageEvent>) {
      for (const f of listeners) f(e as MessageEvent);
    },
  };
}

describe("frame guest", () => {
  it("says it is up to its parent (nothing secret), takes the first hello's port, says ready", async () => {
    const w = fakeWin();
    const guests: {
      label: string;
      ticket(): Promise<string | null>;
      size(w: number, h: number): void;
    }[] = [];
    const stop = startFrameGuest(w as never, (g) => guests.push(g), 200);
    expect(w.sentUp).toEqual([[{ lk: FRAME_UP, v: 1 }, "*"]]);
    const ours = new MessageChannel();
    const fromFrame: unknown[] = [];
    ours.port1.onmessage = (m) => {
      fromFrame.push(m.data);
      if ((m.data as { type: string }).type === "need-ticket")
        ours.port1.postMessage({ type: "ticket", ticket: "T1" });
    };
    w.fire({
      source: w.parent as never,
      data: { lk: HELLO, label: "github.com/x" },
      ports: [ours.port2],
    });
    // A second hello (a hostile parent's) is ignored.
    const theirs = new MessageChannel();
    const toThem: unknown[] = [];
    theirs.port1.onmessage = (m) => void toThem.push(m.data);
    w.fire({ source: w.parent as never, data: { lk: HELLO }, ports: [theirs.port2] });
    expect(guests.length).toBe(1);
    expect(guests[0].label).toBe("github.com/x");
    expect(await guests[0].ticket()).toBe("T1");
    guests[0].size(300, 400);
    await tick(10);
    expect(fromFrame).toEqual([
      { type: "ready" },
      { type: "need-ticket" },
      { type: "size", w: 300, h: 400 },
    ]);
    expect(toThem).toEqual([]);
    stop();
    expect(w.listeners.size).toBe(0);
    theirs.port1.close();
  });

  it("no answer to a ticket request in time: null", async () => {
    const w = fakeWin();
    let g: { ticket(): Promise<string | null> } | undefined;
    startFrameGuest(w as never, (x) => (g = x), 30);
    const silent = new MessageChannel();
    w.fire({ source: w.parent as never, data: { lk: HELLO }, ports: [silent.port2] });
    expect(await g!.ticket()).toBeNull();
    silent.port1.close();
  });
});

// ── the userscript's shell ──────────────────────────────────────────────────

type L = (e: unknown) => void;
class El {
  listeners = new Map<string, L[]>();
  props = new Map<string, string>();
  attrs = new Map<string, string>();
  children: El[] = [];
  parent?: El;
  shadow?: El;
  shadowMode?: string;
  src = "";
  title = "";
  referrerPolicy = "";
  contentWindow: {
    posted: [unknown, string, unknown[]][];
    postMessage(m: unknown, o: string, t: unknown[]): void;
  } | null = null;
  style = { setProperty: (k: string, v: string) => void this.props.set(k, v) };
  constructor(public tag: string) {
    if (tag === "iframe")
      this.contentWindow = {
        posted: [],
        postMessage(m, o, t) {
          this.posted.push([m, o, t]);
        },
      };
  }
  addEventListener(t: string, f: L) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]);
  }
  removeEventListener(t: string, f: L) {
    this.listeners.set(
      t,
      (this.listeners.get(t) ?? []).filter((x) => x !== f),
    );
  }
  fire(t: string, e: unknown = {}) {
    for (const f of this.listeners.get(t) ?? []) f(e);
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  setPointerCapture() {}
  attachShadow(o: { mode: string }) {
    this.shadowMode = o.mode;
    this.shadow = new El("#root");
    return this.shadow;
  }
  append(...els: El[]) {
    for (const e of els) {
      e.parent = this;
      this.children.push(e);
    }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
}
function shellSetup(
  o: { ticket?: () => Promise<string | null>; readyMs?: number; capMs?: number } = {},
) {
  const html = new El("html");
  const doc = Object.assign(new El("#doc"), {
    documentElement: html,
    createElement: (t: string) => new El(t),
  });
  const win = new El("#win");
  const saved: { x: number; y: number }[] = [];
  const shell = frameShell({
    doc: doc as never,
    win: win as never,
    origin: ORIGIN,
    label: "github.com/a",
    ticket: o.ticket ?? (async () => "TK"),
    gripLabel: "grip",
    pos: { get: () => ({ x: -10, y: 0 }), set: (p) => void saved.push(p) },
    readyMs: o.readyMs ?? 30,
    capMs: o.capMs ?? 2000,
  });
  const host = html.children[0];
  const box = host.shadow!.children[0];
  const [grip, iframe] = box.children;
  return { shell, html, doc, win, host, grip, iframe, saved };
}

describe("frame shell (userscript side)", () => {
  it("a plain div with a closed root, the frame from the app origin, no referrer", () => {
    const { host, iframe, shell } = shellSetup();
    expect(host.tag).toBe("div");
    expect(host.shadowMode).toBe("closed");
    expect(iframe.tag).toBe("iframe");
    expect(iframe.src).toBe("https://lianki.com/embed/partner");
    expect(iframe.referrerPolicy).toBe("no-referrer");
    expect(host.props.get("right")).toBe("18px"); // the kept position
    shell.destroy();
  });

  it("handshake: up from our frame → hello with a port → ready; tickets and sizes over the port", async () => {
    const asked: number[] = [];
    const { shell, win, iframe } = shellSetup({ ticket: async () => (asked.push(1), "TK") });
    // A message from another window (the page) is ignored.
    win.fire("message", { source: {}, origin: ORIGIN, data: { lk: FRAME_UP } });
    expect(iframe.contentWindow!.posted.length).toBe(0);
    win.fire("message", { source: iframe.contentWindow, origin: ORIGIN, data: { lk: FRAME_UP } });
    const [hello, target, transfer] = iframe.contentWindow!.posted[0];
    expect(hello).toEqual({ lk: HELLO, v: 1, label: "github.com/a" });
    expect(target).toBe(ORIGIN); // never "*"
    const port = transfer[0] as MessagePort;
    const got: unknown[] = [];
    port.onmessage = (m) => void got.push(m.data);
    port.postMessage({ type: "ready" });
    expect(await shell.result).toBe("ready");
    port.postMessage({ type: "need-ticket" });
    port.postMessage({ type: "size", w: 300, h: 420 });
    await tick(20);
    expect(got).toEqual([{ type: "ticket", ticket: "TK" }]);
    expect(asked.length).toBe(1);
    expect(iframe.props.get("width")).toBe("300px");
    expect(iframe.props.get("height")).toBe("420px");
    // A second "up" makes no second hello.
    win.fire("message", { source: iframe.contentWindow, origin: ORIGIN, data: { lk: FRAME_UP } });
    expect(iframe.contentWindow!.posted.length).toBe(1);
    shell.destroy();
    port.close();
  });

  it("a failing ticket fetch answers null", async () => {
    const { shell, win, iframe } = shellSetup({
      ticket: async () => {
        throw new Error("network");
      },
    });
    win.fire("message", { source: iframe.contentWindow, origin: ORIGIN, data: { lk: FRAME_UP } });
    const port = iframe.contentWindow!.posted[0][2][0] as MessagePort;
    const got: unknown[] = [];
    port.onmessage = (m) => void got.push(m.data);
    port.postMessage({ type: "need-ticket" });
    port.postMessage({ type: "bogus" });
    await tick(20);
    expect(got).toEqual([{ type: "ticket", ticket: null }]);
    shell.destroy();
    port.close();
  });

  it("blocked: no answer after the frame's load, a CSP report, or nothing at all", async () => {
    const a = shellSetup({ readyMs: 10 });
    a.iframe.fire("load");
    expect(await a.shell.result).toBe("blocked");
    a.shell.destroy();
    const b = shellSetup();
    b.doc.fire("securitypolicyviolation", {
      effectiveDirective: "frame-src",
      blockedURI: `${ORIGIN}/embed/partner`,
    });
    expect(await b.shell.result).toBe("blocked");
    b.shell.destroy();
    const c = shellSetup();
    c.doc.fire("securitypolicyviolation", { effectiveDirective: "img-src", blockedURI: ORIGIN });
    const d = shellSetup({ capMs: 10 });
    expect(await d.shell.result).toBe("blocked");
    c.shell.destroy();
    expect(await c.shell.result).toBe("blocked");
    expect(c.html.children.length).toBe(0);
  });

  it("drags by the grip (kept), and a double-click minimizes and restores", () => {
    const { grip, host, iframe, saved, shell } = shellSetup();
    grip.fire("pointermove", { clientX: 5, clientY: 5 }); // no drag yet
    grip.fire("pointerdown", { clientX: 100, clientY: 100, pointerId: 1 });
    grip.fire("pointermove", { clientX: 80, clientY: 90 });
    grip.fire("pointerup");
    expect(host.props.get("right")).toBe("38px");
    expect(host.props.get("bottom")).toBe("18px");
    expect(saved).toEqual([{ x: -30, y: -10 }]);
    grip.fire("pointerup");
    expect(saved.length).toBe(1);
    grip.fire("dblclick");
    expect(iframe.props.get("display")).toBe("none");
    grip.fire("dblclick");
    expect(iframe.props.get("display")).toBe("block");
    shell.destroy();
  });
});

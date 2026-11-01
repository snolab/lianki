/**
 * The userscript's shell around the Learning Partner's lianki.com frame
 * (docs/dev-debug-widget.md, "On every site", "The frame"). Trusted
 * userscript code, plain DOM, styled through the CSSOM:
 *
 * - a plain div host with a closed shadow root, holding a grip and the iframe
 *   (`${origin}/embed/partner`);
 * - the handshake: the frame says it is up (postMessage to its parent), the
 *   shell answers with a hello and a MessagePort, the frame says ready on it.
 *   No "up" within READY_MS of the frame's load (or LOAD_CAP_MS overall), or
 *   a CSP report that the frame was refused (frame-src/child-src): blocked;
 *   the caller then falls back to the read-only shadow widget;
 * - over the port: tickets (fetched with GM_xmlhttpRequest by the caller)
 *   when the frame asks, and the frame's size, which the iframe follows, so
 *   the rest of the page keeps its clicks;
 * - position, drag (the grip) and minimize (double-click the grip).
 *
 * What he types is typed inside the cross-origin frame: the host page's key
 * listeners never see it.
 */
import {
  HELLO,
  LOAD_CAP_MS,
  MIN_H,
  MIN_W,
  PROTOCOL_V,
  READY_MS,
  frameBlocked,
  frameUrl,
  isFrameUp,
  portMsg,
} from "../packages/debug-chat/src/embed/frame-protocol";

export type FrameResult = "ready" | "blocked";

type Pos = { x: number; y: number };

export type FrameShellDeps = {
  doc: Document;
  win: Pick<Window, "addEventListener" | "removeEventListener">;
  origin: string;
  /** This page for the agent: host + path. */
  label: string;
  ticket: () => Promise<string | null>;
  gripLabel: string;
  /** The shell's offset from the bottom-right corner, kept per device. */
  pos?: { get(): Pos | null; set(p: Pos): void };
  readyMs?: number;
  capMs?: number;
  Channel?: typeof MessageChannel;
};

export type FrameShell = {
  result: Promise<FrameResult>;
  iframe: HTMLIFrameElement;
  host: HTMLElement;
  destroy(): void;
};

const css = (el: HTMLElement, rules: [string, string][]) => {
  for (const [k, v] of rules) el.style.setProperty(k, v, "important");
};

export function frameShell(d: FrameShellDeps): FrameShell {
  const { doc, win, origin } = d;
  const host = doc.createElement("div");
  let pos: Pos = d.pos?.get() ?? { x: 0, y: 0 };
  const place = () =>
    css(host, [
      ["all", "initial"],
      ["display", "block"],
      ["position", "fixed"],
      ["right", `${8 - pos.x}px`],
      ["bottom", `${8 - pos.y}px`],
      ["z-index", "2147483647"],
    ]);
  place();
  const root = host.attachShadow({ mode: "closed" });
  const box = doc.createElement("div");
  css(box, [
    ["all", "initial"],
    ["display", "flex"],
    ["flex-direction", "column"],
    ["align-items", "flex-end"],
    ["gap", "2px"],
  ]);
  const grip = doc.createElement("div");
  grip.setAttribute("role", "button");
  grip.setAttribute("aria-label", d.gripLabel);
  grip.title = d.gripLabel;
  css(grip, [
    ["all", "initial"],
    ["display", "block"],
    ["width", "48px"],
    ["height", "12px"],
    ["border-radius", "6px"],
    ["background", "oklch(0.55 0.02 65 / 0.55)"],
    ["cursor", "grab"],
    ["touch-action", "none"],
  ]);
  const iframe = doc.createElement("iframe");
  iframe.src = frameUrl(origin);
  iframe.referrerPolicy = "no-referrer";
  iframe.setAttribute("title", d.gripLabel);
  css(iframe, [
    ["all", "initial"],
    ["display", "block"],
    ["border", "0"],
    ["width", `${MIN_W}px`],
    ["height", `${MIN_H}px`],
    ["background", "transparent"],
    ["color-scheme", "normal"],
  ]);
  box.append(grip, iframe);
  root.append(box);

  let settle: (r: FrameResult) => void = () => {};
  let settled = false;
  const result = new Promise<FrameResult>((resolve) => {
    settle = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
  });
  const timers: ReturnType<typeof setTimeout>[] = [];
  timers.push(setTimeout(() => settle("blocked"), d.capMs ?? LOAD_CAP_MS));
  iframe.addEventListener("load", () =>
    timers.push(setTimeout(() => settle("blocked"), d.readyMs ?? READY_MS)),
  );

  let port: MessagePort | null = null;
  const onMessage = (e: MessageEvent) => {
    if (port || !isFrameUp(e, iframe.contentWindow, origin)) return;
    const ch = new (d.Channel ?? MessageChannel)();
    port = ch.port1;
    port.onmessage = (m) => {
      const msg = portMsg(m.data);
      if (!msg) return;
      if (msg.type === "ready") settle("ready");
      else if (msg.type === "need-ticket")
        void d.ticket().then(
          (ticket) => port?.postMessage({ type: "ticket", ticket }),
          () => port?.postMessage({ type: "ticket", ticket: null }),
        );
      else if (msg.type === "size")
        css(iframe, [
          ["width", `${msg.w}px`],
          ["height", `${msg.h}px`],
        ]);
    };
    iframe.contentWindow?.postMessage({ lk: HELLO, v: PROTOCOL_V, label: d.label }, origin, [
      ch.port2,
    ]);
  };
  const onViolation = (e: SecurityPolicyViolationEvent) => {
    if (frameBlocked(e, origin)) settle("blocked");
  };
  win.addEventListener("message", onMessage as EventListener);
  doc.addEventListener("securitypolicyviolation", onViolation as EventListener);

  // Drag by the grip; double-click minimizes (the frame stays, with its socket).
  let drag: { x: number; y: number; from: Pos } | null = null;
  grip.addEventListener("pointerdown", (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY, from: pos };
    grip.setPointerCapture?.(e.pointerId);
  });
  grip.addEventListener("pointermove", (e: PointerEvent) => {
    if (!drag) return;
    pos = { x: drag.from.x + e.clientX - drag.x, y: drag.from.y + e.clientY - drag.y };
    place();
  });
  grip.addEventListener("pointerup", () => {
    if (drag) d.pos?.set(pos);
    drag = null;
  });
  let minimized = false;
  grip.addEventListener("dblclick", () => {
    minimized = !minimized;
    css(iframe, [["display", minimized ? "none" : "block"]]);
  });

  (doc.documentElement ?? doc.body).append(host);
  return {
    result,
    iframe,
    host,
    destroy() {
      for (const t of timers) clearTimeout(t);
      settle("blocked");
      win.removeEventListener("message", onMessage as EventListener);
      doc.removeEventListener("securitypolicyviolation", onViolation as EventListener);
      port?.close();
      host.remove();
    },
  };
}

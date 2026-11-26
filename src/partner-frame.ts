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
 * - a share (docs/userscript-li-chat.md, M3): only when the frame asks
 *   (he pressed Share in its composer) does the shell read the page's
 *   selection or title and link, and it writes that only into the port;
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
import type { ShareWhat, SharedPage } from "../packages/debug-chat/src/embed/share";
import { SIDEBAR_QUERY } from "../packages/debug-chat/src/full-screen";
import {
  iconSvg,
  labelAt,
  labelStyle,
  previewStyle,
  zoneStyle,
} from "../packages/debug-chat/src/snap-overlay";
import {
  SNAP_DEFAULTS,
  pointerOffScreen,
  snapAt,
  snapTargets,
  type SnapTarget,
  type SnapViewport,
} from "../packages/debug-chat/src/snap-targets";
import { measureSnapViewport } from "../packages/debug-chat/src/snap-viewport";

export type FrameResult = "ready" | "blocked";

type Pos = { x: number; y: number };

export type FrameShellDeps = {
  doc: Document;
  win: Pick<Window, "addEventListener" | "removeEventListener">;
  origin: string;
  /** This page for the agent: host + path. */
  label: string;
  ticket: () => Promise<string | null>;
  /** Read the page for a share he asked for in the frame (null: nothing to share). */
  share?: (what: ShareWhat) => SharedPage | null;
  gripLabel: string;
  /** The Minimize drop zone's label while the grip is dragged (intlayer portable-li `collapse`). */
  minimizeLabel?: string;
  /** The shell's offset from the bottom-right corner, kept per device. */
  pos?: { get(): Pos | null; set(p: Pos): void };
  readyMs?: number;
  capMs?: number;
  /** The frame's UI language (frame-protocol.ts frameUrl, ?lang=): his Lianki language, not the browser's. */
  locale?: string;
  /**
   * A fixed size (CSS lengths) instead of following the frame's reported size:
   * 随身Li's window is as big as the bundled one, never content-sized or clipped.
   */
  fixedSize?: { w: string; h: string };
  Channel?: typeof MessageChannel;
};

export type FrameShell = {
  result: Promise<FrameResult>;
  /** What the frame said it can do in its "ready" (frame-protocol.ts PORTABLE_CAP); [] before. */
  caps(): string[];
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
  iframe.src = frameUrl(origin, d.locale);
  iframe.referrerPolicy = "no-referrer";
  iframe.setAttribute("title", d.gripLabel);
  css(iframe, [
    ["all", "initial"],
    ["display", "block"],
    ["border", "0"],
    ["width", d.fixedSize?.w ?? `${MIN_W}px`],
    ["height", d.fixedSize?.h ?? `${MIN_H}px`],
    ["background", "transparent"],
    // The same color-scheme as the page inside: /embed/partner forces
    // "normal" (globals.css html[data-embed]). A mismatch makes the browser
    // paint an opaque canvas behind the frame (the dark box seen on 2.24.58).
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
  let caps: string[] = [];
  const onMessage = (e: MessageEvent) => {
    if (port || !isFrameUp(e, iframe.contentWindow, origin)) return;
    const ch = new (d.Channel ?? MessageChannel)();
    port = ch.port1;
    port.onmessage = (m) => {
      const msg = portMsg(m.data);
      if (!msg) return;
      if (msg.type === "ready") {
        caps = msg.caps ?? [];
        settle("ready");
      } else if (msg.type === "need-ticket")
        void d.ticket().then(
          (ticket) => port?.postMessage({ type: "ticket", ticket }),
          () => port?.postMessage({ type: "ticket", ticket: null }),
        );
      else if (msg.type === "need-share") {
        let share: SharedPage | null = null;
        try {
          share = d.share?.(msg.what) ?? null;
        } catch {}
        port?.postMessage({ type: "share", what: msg.what, share });
      } else if (msg.type === "size" && !d.fixedSize)
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

  // Drag by the grip (docs/chat-drag-ux.md, "随身Li frame path"): past a
  // threshold, one write per frame, kept on the HOST page's screen, the
  // bottom-right corner a Minimize zone drawn as on lianki.com
  // (snap-targets.ts, the same function). Escape, pointercancel or a release
  // off-screen puts it back. A tap on the minimized grip, or a double-click,
  // brings the frame back (the frame stays, with its socket).
  let minimized = false;
  const setMinimized = (on: boolean) => {
    minimized = on;
    css(iframe, [["display", on ? "none" : "block"]]);
  };
  const view = (doc.defaultView ?? null) as (Window & typeof globalThis) | null;
  const raf = (f: () => void) =>
    view?.requestAnimationFrame ? view.requestAnimationFrame(f) : (f(), 0);
  const caf = (id: number) => view?.cancelAnimationFrame?.(id);
  let drag: {
    x: number;
    y: number;
    from: Pos;
    moved: boolean;
    /** The host rect at the start (clamp), the viewport and zones (snap-targets.ts). */
    rect?: DOMRect;
    vp?: SnapViewport;
    targets?: SnapTarget[];
    hot?: SnapTarget | null;
    cx: number;
    cy: number;
    frame: number;
  } | null = null;
  const overlay = doc.createElement("div");
  css(overlay, [["all", "initial"]]);
  root.append(overlay);
  const drawOverlay = () => {
    overlay.replaceChildren();
    const g = drag;
    if (!g?.vp || !g.targets) return;
    for (const t of g.targets) {
      const hot = g.hot?.id === t.id;
      const zone = doc.createElement("div");
      Object.assign(
        zone.style,
        zoneStyle(t, { hot, shown: true, ms: SNAP_DEFAULTS.hintMs, reduce: reduced() }),
      );
      overlay.append(zone);
      if (hot) {
        const p = doc.createElement("div");
        Object.assign(p.style, previewStyle(t.result, { alpha: SNAP_DEFAULTS.previewPct / 100 }));
        p.dataset.lkSnapPreview = t.id;
        overlay.append(p);
      }
      const label = doc.createElement("div");
      Object.assign(
        label.style,
        labelStyle(labelAt(t, g.vp), {
          hot,
          vertical: false,
          ms: SNAP_DEFAULTS.hintMs,
          reduce: reduced(),
        }),
      );
      label.append(iconSvg(doc, t.id), doc.createTextNode(d.minimizeLabel ?? "Minimize"));
      overlay.append(label);
    }
  };
  const reduced = () => {
    try {
      return !!view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  };
  const stop = () => {
    if (drag) caf(drag.frame);
    const drew = !!drag?.targets;
    drag = null;
    if (drew) overlay.replaceChildren();
    view?.removeEventListener("keydown", onKey, true);
    view?.removeEventListener("resize", cancelDrag);
    view?.visualViewport?.removeEventListener("resize", cancelDrag);
    view?.visualViewport?.removeEventListener("scroll", cancelDrag);
  };
  /** Back to where the drag found it, nothing saved. */
  function cancelDrag() {
    if (!drag) return;
    pos = drag.from;
    place();
    stop();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || !drag) return;
    e.preventDefault();
    e.stopPropagation();
    cancelDrag();
  }
  const step = () => {
    const g = drag;
    if (!g) return;
    g.frame = 0;
    let dx = g.cx - g.x;
    let dy = g.cy - g.y;
    // Kept on the host page's screen: the shell's rect at the start, moved by (dx, dy).
    if (g.rect && g.vp) {
      dx = Math.max(-g.rect.left, Math.min(g.vp.w - g.rect.right, dx));
      dy = Math.max(g.vp.y - g.rect.top, Math.min(g.vp.y + g.vp.h - g.rect.bottom, dy));
    }
    // right/bottom insets: a move right or down lowers them.
    pos = { x: g.from.x + dx, y: g.from.y + dy };
    place();
    const hot = g.targets ? snapAt(g.targets, g.cx, g.cy) : null;
    if (hot?.id !== g.hot?.id) {
      g.hot = hot;
      drawOverlay();
    }
  };
  grip.addEventListener("pointerdown", (e: PointerEvent) => {
    if ((e.button ?? 0) !== 0) return;
    drag = {
      x: e.clientX,
      y: e.clientY,
      from: pos,
      moved: false,
      cx: e.clientX,
      cy: e.clientY,
      frame: 0,
    };
    grip.setPointerCapture?.(e.pointerId);
  });
  grip.addEventListener("pointermove", (e: PointerEvent) => {
    const g = drag;
    if (!g) return;
    g.cx = e.clientX;
    g.cy = e.clientY;
    if (!g.moved) {
      if (Math.hypot(g.cx - g.x, g.cy - g.y) < SNAP_DEFAULTS.dragThresholdPx) return;
      g.moved = true;
      if (view) {
        g.rect = host.getBoundingClientRect();
        g.vp = measureSnapViewport(view, SIDEBAR_QUERY);
        const r = grip.getBoundingClientRect();
        g.targets = snapTargets(g.vp, {
          fullAllowed: false,
          dockAllowed: false,
          open: !minimized,
          dockWidth: 0,
          pill: { w: r.width, h: r.height },
          home: { right: g.vp.x + g.vp.w - 8, bottom: g.vp.y + g.vp.h - 8 },
        });
        g.hot = null;
        drawOverlay();
        view.addEventListener("keydown", onKey, true);
        // The host page's viewport changing under the drag (a resize, the
        // keyboard panning or a pinch: visualViewport resize/scroll) cancels it,
        // the shell back where it was (docs/chat-drag-ux.md, "Resize & rotation").
        view.addEventListener("resize", cancelDrag);
        view.visualViewport?.addEventListener("resize", cancelDrag);
        view.visualViewport?.addEventListener("scroll", cancelDrag);
      }
    }
    if (!g.frame) g.frame = raf(step);
  });
  grip.addEventListener("pointerup", (e: PointerEvent) => {
    const g = drag;
    if (!g) return;
    if (!g.moved) {
      stop();
      // A tap on the minimized grip brings the frame back (touch has no double-click).
      if (minimized) setMinimized(false);
      return;
    }
    if (g.frame) {
      caf(g.frame);
      step();
    }
    const x = e.clientX;
    const y = e.clientY;
    if (g.vp && pointerOffScreen(g.vp, x, y)) return cancelDrag();
    const hot = g.targets ? snapAt(g.targets, x, y) : null;
    if (hot?.id === "minimize") {
      // Folded to the grip in its home corner, as the preview showed.
      pos = { x: 0, y: 0 };
      place();
      setMinimized(true);
    }
    d.pos?.set(pos);
    stop();
  });
  grip.addEventListener("pointercancel", () => cancelDrag());
  grip.addEventListener("dblclick", () => setMinimized(!minimized));

  (doc.documentElement ?? doc.body).append(host);
  return {
    result,
    caps: () => caps,
    iframe,
    host,
    destroy() {
      for (const t of timers) clearTimeout(t);
      stop();
      settle("blocked");
      win.removeEventListener("message", onMessage as EventListener);
      doc.removeEventListener("securitypolicyviolation", onViolation as EventListener);
      port?.close();
      host.remove();
    },
  };
}

/**
 * Live Google Docs (docs/connections.md, "Live stream"), the Docs page's side.
 *
 * Two speeds. The page receives each edit on Google's own channel, so those go
 * straight to the reader (measured 2026-11-06: about 120 ms from Google to the
 * Mac). The export lags that by seconds (1.6 to 5.4 s measured), so it only
 * saves the book, after a pause. Canvas draws also ask for a save: they are how
 * typing in this very tab is seen, and they keep saving working if the channel's
 * undocumented format ever changes.
 *
 * Only a doc the user switched on is ever sent; the switch is remembered per doc.
 */
import { parseBindOps, type TailOp } from "../lib/read/gdoc-tail";

declare const unsafeWindow: Window & typeof globalThis;

export interface GdocStreamDeps {
  origin: string;
  gmFetch: (url: string, opts?: Record<string, unknown>) => Promise<any>;
  getValue: (key: string, fallback?: unknown) => any;
  setValue: (key: string, value: unknown) => void;
  /** Tests only: shorter waits. */
  timing?: Partial<typeof TIMING>;
}

/** After the last draw, how long to wait; and the most a stream of draws can delay a read. */
const TIMING = { quietMs: 4000, maxWaitMs: 20_000, exportLagMs: 6000, retryShortMs: 1500 };

export function docIdOfPath(path: string): string | null {
  return /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{25,128})(?:\/|$)/.exec(path)?.[1] ?? null;
}

/** The markup worth sending: images are dropped, as the server's own export read does. */
export function stripImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, "");
}

/** A much shorter answer may be an error page, or a real deletion: only a repeat is believed. */
export function looksTruncated(next: string, prev: string | null): boolean {
  return prev !== null && next.length < prev.length / 2;
}

export function startGdocStream(deps: GdocStreamDeps): void {
  const id = docIdOfPath(location.pathname);
  if (!id) return;
  const { quietMs, maxWaitMs, exportLagMs, retryShortMs } = { ...TIMING, ...deps.timing };
  const key = `lk:gdoc-stream:${id}`;
  const zh = /^zh\b/i.test(navigator.language);
  const label = {
    start: zh ? "同步到 Lianki" : "Stream to Lianki",
    stop: zh ? "停止同步" : "Stop streaming",
    failed: zh ? "同步失败，重试中" : "Sync failed, retrying",
    open: zh ? "在 Lianki 中打开" : "Open in Lianki",
  };

  let on = false;
  let last: string | null = null;
  let suspect: string | null = null;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let lastSignal = 0;
  let lagCheck: ReturnType<typeof setTimeout> | undefined;
  let bookId: string | null = null;
  let liveQueue: TailOp[] = [];
  let liveBusy = false;
  let busy = false;
  let dirty = false;
  let blockedUntil = 0;
  let button: HTMLButtonElement | null = null;
  let link: HTMLAnchorElement | null = null;
  /** The tab opened by the click (a browser blocks one opened later), waiting for the book's id. */
  let pending: Window | null = null;

  const docTitle = () => document.title.replace(/\s*-\s*Google (Docs|文档|ドキュメント)\s*$/i, "");

  const read = async (): Promise<string | null> => {
    const res = await fetch(`/document/d/${id}/export?format=html`, { credentials: "include" });
    if (!res.ok || !/^text\/html\b/i.test(res.headers.get("content-type") ?? "")) return null;
    return stripImages(await res.text());
  };

  const send = async (html: string) => {
    const res = await deps.gmFetch(`${deps.origin}/api/read/gdoc/stream`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId: id, html, title: docTitle() }),
    });
    if (res.status === 429) {
      blockedUntil = Date.now() + 1000 * (Number(res.headers.get("retry-after")) || 30);
      return false;
    }
    if (!res.ok) return res.status === 422; // No text yet: nothing to retry.
    const d = await res.json();
    bookId = d.id;
    void sendLive();
    const url = `${deps.origin}/read/${d.id}?streamingFrom=google-docs`;
    if (link) {
      link.href = url;
      link.style.display = "inline";
    }
    if (pending) {
      pending.location.href = url;
      pending = null;
    }
    return true;
  };

  /** In order, one at a time: what arrived meanwhile goes together next. */
  const sendLive = async () => {
    if (liveBusy || !bookId || !liveQueue.length || !on) return;
    if (Date.now() < blockedUntil) return;
    liveBusy = true;
    const ops = liveQueue;
    liveQueue = [];
    try {
      await deps.gmFetch(`${deps.origin}/api/read/gdoc/stream`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ book: bookId, ops }),
      });
    } catch (err) {
      // The next save brings the text anyway.
      console.warn("[Lianki] Docs live edit failed", err);
    }
    liveBusy = false;
    void sendLive();
  };

  const check = async () => {
    clearTimeout(quiet);
    clearTimeout(deadline);
    deadline = undefined;
    if (!on) return;
    if (busy) {
      dirty = true;
      return;
    }
    if (Date.now() < blockedUntil) return;
    busy = true;
    let ok = true;
    try {
      const html = await read();
      if (html !== null && html !== last) {
        if (looksTruncated(html, last) && suspect !== html) {
          suspect = html;
          setTimeout(() => void check(), retryShortMs);
        } else {
          suspect = null;
          ok = await send(html);
          if (ok) last = html;
        }
      }
    } catch (err) {
      ok = false;
      console.warn("[Lianki] Docs stream failed", err);
    }
    busy = false;
    if (button) button.textContent = ok ? label.stop : label.failed;
    if (dirty) {
      dirty = false;
      void check();
    } else if (Date.now() - lastSignal < exportLagMs) {
      // The export may not hold the last edit yet: look once more when it should.
      clearTimeout(lagCheck);
      lagCheck = setTimeout(() => void check(), exportLagMs);
    }
  };

  const signal = () => {
    if (!on) return;
    lastSignal = Date.now();
    clearTimeout(quiet);
    quiet = setTimeout(() => void check(), quietMs);
    deadline ??= setTimeout(() => void check(), maxWaitMs);
  };

  // Both live in the page's own world, which the script's sandbox does not
  // share. Installed once, only for a doc switched on; they only look.
  let hooked = false;
  const hook = () => {
    if (hooked) return;
    hooked = true;
    const page = (typeof unsafeWindow !== "undefined" ? unsafeWindow : window) as any;
    const proto = page.CanvasRenderingContext2D.prototype;
    const original = proto.fillText;
    proto.fillText = function (this: unknown, ...args: unknown[]) {
      signal();
      return original.apply(this, args);
    };
    const xhr = page.XMLHttpRequest.prototype;
    const text = Object.getOwnPropertyDescriptor(xhr, "responseText");
    if (!text?.get) return;
    const read = new WeakMap<object, number>();
    // A channel opened from now on is read from its start.
    const open = xhr.open;
    xhr.open = function (this: object, ...args: unknown[]) {
      read.set(this, 0);
      return open.apply(this, args);
    };
    Object.defineProperty(xhr, "responseText", {
      configurable: true,
      get(this: XMLHttpRequest) {
        const v = text.get!.call(this) as string;
        try {
          if (on && v && /\/bind(\?|$)/.test(this.responseURL)) {
            // A channel already open when this was installed: only what comes next.
            const from = read.get(this) ?? v.length;
            const { ops, consumed } = parseBindOps(v.slice(from));
            read.set(this, from + consumed);
            if (ops.length) {
              liveQueue.push(...ops);
              signal();
              void sendLive();
            }
          }
        } catch {
          // The page's own read must never fail because of this.
        }
        return v;
      },
    });
  };

  const setOn = (next: boolean) => {
    on = next;
    deps.setValue(key, next);
    if (button) button.textContent = next ? label.stop : label.start;
    if (next) {
      hook();
      void check();
    } else {
      clearTimeout(quiet);
      clearTimeout(deadline);
      clearTimeout(lagCheck);
      deadline = undefined;
      last = null;
      liveQueue = [];
      if (link) link.style.display = "none";
    }
  };

  const mount = () => {
    const host = document.createElement("div");
    host.style.cssText =
      "all: initial; position: fixed; z-index: 2147483647; left: 12px; bottom: 12px;";
    const shadow = host.attachShadow({ mode: "open" });
    button = document.createElement("button");
    button.type = "button";
    button.textContent = label.start;
    button.style.cssText =
      "font: 12px system-ui, sans-serif; padding: 6px 10px; border-radius: 999px; cursor: pointer; " +
      "border: 1px solid oklch(0.8 0 0); background: oklch(1 0 0); color: oklch(0.25 0 0);";
    button.addEventListener("click", () => {
      if (!on) pending = window.open("", "_blank");
      setOn(!on);
    });
    link = document.createElement("a");
    link.textContent = label.open;
    link.target = "_blank";
    link.rel = "noopener";
    link.style.cssText =
      "display: none; margin-left: 8px; font: 12px system-ui, sans-serif; color: oklch(0.45 0.15 260);";
    shadow.append(button, link);
    document.documentElement.append(host);
  };

  deps
    .gmFetch(`${deps.origin}/api/read/gdoc/stream`, { credentials: "include" })
    .then((res: { ok: boolean }) => {
      if (!res.ok) return;
      mount();
      if (deps.getValue(key, false) === true) {
        setOn(true);
      }
    })
    .catch(() => {});
}

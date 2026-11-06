/**
 * Live Google Docs (docs/connections.md, "Live stream"), the Docs page's side.
 *
 * The page already holds the live doc. Google draws its text on canvases, so a
 * burst of `fillText` means something changed (measured 2026-11-06: 9 bursts,
 * 9 changed exports while the owner typed from his phone). The page then reads
 * its own export with the user's login and sends it to Lianki.
 *
 * Only a doc the user switched on is ever sent; the switch is remembered per
 * doc. A hidden tab may stop drawing, so while hidden a slow timer checks too:
 * the one network timer here, to Google, only on a doc that is switched on.
 */
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
const TIMING = { quietMs: 800, maxWaitMs: 2500, hiddenCheckMs: 5000, retryShortMs: 1500 };

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
  const { quietMs, maxWaitMs, hiddenCheckMs, retryShortMs } = { ...TIMING, ...deps.timing };
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
  let hiddenTimer: ReturnType<typeof setInterval> | undefined;
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
    }
  };

  const signal = () => {
    if (!on) return;
    clearTimeout(quiet);
    quiet = setTimeout(() => void check(), quietMs);
    deadline ??= setTimeout(() => void check(), maxWaitMs);
  };

  const onVisibility = () => {
    clearInterval(hiddenTimer);
    hiddenTimer = undefined;
    if (on && document.hidden) hiddenTimer = setInterval(() => void check(), hiddenCheckMs);
    else if (on) signal();
  };

  // Docs draws in the page's own world, which the script's sandbox does not
  // share: the hook goes on the page's canvas prototype. Installed once, only
  // for a doc switched on; it just notes the draw.
  let hooked = false;
  const hook = () => {
    if (hooked) return;
    hooked = true;
    const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const proto = (page as any).CanvasRenderingContext2D.prototype;
    const original = proto.fillText;
    proto.fillText = function (this: unknown, ...args: unknown[]) {
      signal();
      return original.apply(this, args);
    };
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
      deadline = undefined;
      last = null;
      if (link) link.style.display = "none";
    }
    onVisibility();
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
      document.addEventListener("visibilitychange", onVisibility);
      if (deps.getValue(key, false) === true) {
        setOn(true);
      }
    })
    .catch(() => {});
}

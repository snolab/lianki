"use client";

import { useEffect, useState } from "react";
import { getKey } from "@lianki/debug-chat/storage-keys";

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

/** Debug turned on for this device (seven taps on /words' stats line, or ?debug=1 / ?agent=1). */
function debugDevice(): boolean {
  return getKey("lk:debug") === "1";
}
/** True the first time this tab is told about `build`; later calls say false. */
function reloadOnceFor(build: string): boolean {
  try {
    if (sessionStorage.getItem("lk:reloaded-for") === build) return false;
    sessionStorage.setItem("lk:reloaded-for", build);
    return true;
  } catch {
    return false;
  }
}
/** Hidden or unfocused this long before the socket is dropped. */
const IDLE_MS = 30_000;

/**
 * "New version — Refresh" once a deploy lands, pushed — never polled — by
 * lianki-push (workers/push): a WebSocket that names the serving build on
 * connect and again when CI publishes a new one.
 *
 * Connected only while the page is visible and focused. Leaving it drops the
 * socket after IDLE_MS (debounced: a quick switch away and back keeps the
 * same one); coming back reconnects at once, and the build id it hears on
 * connect covers any deploy made meanwhile. A socket the network drops is
 * reopened on that event, if the page is still in use — no timers.
 */
export function NewVersionNotice() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (typeof WebSocket === "undefined") return;
    // An open socket means the network is never idle, which test runners
    // wait for: under automation, only when a test asks for it.
    try {
      if (navigator.webdriver && localStorage.getItem("lk:version-notice") !== "1") return;
    } catch {
      return;
    }
    let ws: WebSocket | null = null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    const connect = () => {
      if (ws || done) return;
      const sock = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/version/ws`,
      );
      ws = sock;
      sock.onopen = () => opened.add(sock);
      sock.onmessage = (e) => {
        let build: unknown;
        try {
          build = JSON.parse(String(e.data)).build;
        } catch {
          return;
        }
        if (typeof build !== "string" || build === BUILD_ID) return;
        done = true;
        disconnect();
        // The owner's debug devices pick up a deploy by themselves — so a fix can
        // be tried on the phone without anyone tapping Refresh. Once per build:
        // if the reload still serves the old one (the push beat the rollout),
        // fall back to the button instead of reloading every 1.5 s forever.
        if (debugDevice() && reloadOnceFor(build))
          return void setTimeout(() => location.reload(), 1500);
        setStale(true);
      };
      // Dropped by the network (or never opened): reopen on that event if
      // the page is in use; otherwise the next focus does it.
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        if (!done && active() && !failedFast(sock)) connect();
      };
    };
    /** A socket that closed before it ever opened: no push service here (dev, QA). */
    const opened = new WeakSet<WebSocket>();
    const failedFast = (sock: WebSocket) => !opened.has(sock);
    const disconnect = () => {
      clearTimeout(idle);
      const sock = ws;
      ws = null;
      sock?.close();
    };
    const active = () => document.visibilityState === "visible" && document.hasFocus();
    const update = () => {
      clearTimeout(idle);
      if (active()) connect();
      else if (ws) idle = setTimeout(disconnect, IDLE_MS);
    };

    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      disconnect();
    };
  }, []);

  if (!stale) return null;
  const zh = typeof document !== "undefined" && document.documentElement.lang.startsWith("zh");
  return (
    <button
      onClick={() => window.location.reload()}
      className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))] z-50 rounded-full bg-emerald-600 px-4 py-2 text-sm text-white shadow-lg hover:bg-emerald-700"
    >
      {zh ? "有新版本 · 刷新" : "New version · Refresh"}
    </button>
  );
}

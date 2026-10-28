"use client";

import { useEffect, useState } from "react";

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";
/** Hidden or unfocused this long before the stream is dropped. */
const IDLE_MS = 30_000;

/**
 * "New version — Refresh" once a deploy lands (see app/api/version/stream).
 *
 * Connected only while the page is visible and focused. Leaving it drops the
 * connection after IDLE_MS (debounced: a quick switch away and back keeps
 * the same one); coming back reconnects at once, and the build id it hears
 * covers any deploy made meanwhile.
 */
export function NewVersionNotice() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    // An open stream means the network is never idle, which test runners
    // wait for: under automation, only when a test asks for it.
    try {
      if (navigator.webdriver && localStorage.getItem("lk:version-notice") !== "1") return;
    } catch {
      return;
    }
    let es: EventSource | null = null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    const connect = () => {
      if (es || done) return;
      es = new EventSource("/api/version/stream");
      es.addEventListener("version", (e) => {
        if ((e as MessageEvent<string>).data === BUILD_ID) return;
        done = true;
        setStale(true);
        disconnect();
      });
    };
    const disconnect = () => {
      clearTimeout(idle);
      es?.close();
      es = null;
    };
    const active = () => document.visibilityState === "visible" && document.hasFocus();
    const update = () => {
      clearTimeout(idle);
      if (active()) connect();
      else if (es) idle = setTimeout(disconnect, IDLE_MS);
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
      className="fixed bottom-4 right-4 z-50 rounded-full bg-emerald-600 px-4 py-2 text-sm text-white shadow-lg hover:bg-emerald-700"
    >
      {zh ? "有新版本 · 刷新" : "New version · Refresh"}
    </button>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { getKey } from "@lianki/debug-chat/storage-keys";
import { pageBuildId } from "@/lib/build-id";
import { pageIsDirty, reloadDecision, whenClean } from "@/lib/page-dirty";
import { versionNoticeStrings } from "./version-notice-strings";
import { onLivePage } from "@/lib/live-view/live-page";
import { type VersionNews, parseNews, refreshDecision } from "@/lib/smart-refresh";

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
 * "New version — Refresh" once a deploy lands that changed this page, pushed —
 * never polled — by lianki-push (workers/push): a WebSocket that names the
 * serving build on connect and again when a new one is published, with what
 * changed since the page's own build (smart refresh, lib/smart-refresh.ts).
 *
 * Only when the page's route, or the shared shell, loads different client code
 * (or the deploy is forced) does the button show. Otherwise the news is kept:
 * a later move to a route that did change shows it then. Server-only deploys
 * change no client chunk, so they never show it.
 *
 * Connected only while the page is visible and focused. Leaving it drops the
 * socket after IDLE_MS (debounced: a quick switch away and back keeps the
 * same one); coming back reconnects at once, and the build id it hears on
 * connect covers any deploy made meanwhile. A socket the network drops is
 * reopened on that event, if the page is still in use — no timers.
 *
 * `pathname` is the page's route path (NewVersionNotice passes Next's).
 */
export function VersionNotice({ pathname }: { pathname: string }) {
  const [stale, setStale] = useState(false);
  const path = useRef(pathname);
  /** Re-judge the kept news for a new path (set by the effect below). */
  const rejudge = useRef<() => void>(() => {});

  useEffect(() => {
    path.current = pathname;
    rejudge.current();
  }, [pathname]);

  useEffect(() => {
    if (typeof WebSocket === "undefined") return;
    // The owner's live preview is a dev build: its id never matches the one
    // announced, so neither the notice nor the reload-once applies there.
    if (onLivePage()) return;
    // An open socket means the network is never idle, which test runners
    // wait for: under automation, only when a test asks for it.
    try {
      if (navigator.webdriver && localStorage.getItem("lk:version-notice") !== "1") return;
    } catch {
      return;
    }
    const own = pageBuildId();
    let ws: WebSocket | null = null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    /** The latest news of a build this page is not, kept while it changed nothing here. */
    let kept: VersionNews | null = null;
    let unwait = () => {};
    const waitClean = () => {
      unwait();
      unwait = whenClean(document, () => location.reload());
      setStale(true);
    };

    /** This page is out of date: the button (or, on a debug device, a reload). */
    const prompt = (build: string) => {
      done = true;
      kept = null;
      disconnect();
      // The owner's debug devices pick up a deploy by themselves — so a fix can
      // be tried on the phone without anyone tapping Refresh — but never over
      // unsaved work (lib/page-dirty.ts): a dirty page shows the button and
      // reloads the moment it is clean (whenClean: on the page's events, no
      // timer). Once per build: if the reload still serves the old one (the
      // push beat the rollout), fall back to the button instead of reloading
      // every 1.5 s forever.
      const debug = debugDevice();
      const decision = reloadDecision({
        debug,
        first: debug && reloadOnceFor(build),
        dirty: pageIsDirty(document),
      });
      if (decision === "reload")
        return void setTimeout(() => {
          if (!pageIsDirty(document)) location.reload();
          else waitClean();
        }, 1500);
      if (decision === "wait") waitClean();
      setStale(true);
    };
    const judge = (news: VersionNews) => {
      const d = refreshDecision(news, own, path.current);
      if (d === "prompt") prompt(news.build);
      else kept = d === "quiet" ? news : null;
    };
    rejudge.current = () => {
      if (!done && kept) judge(kept);
    };

    const connect = () => {
      if (ws || done) return;
      const sock = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/version/ws?b=${encodeURIComponent(own)}`,
      );
      ws = sock;
      sock.onopen = () => opened.add(sock);
      sock.onmessage = (e) => {
        const news = parseNews(e.data);
        if (news) judge(news);
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
      rejudge.current = () => {};
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      disconnect();
      unwait();
    };
  }, []);

  if (!stale) return null;
  // Mounted outside the Intlayer client provider: the page's lang picks the words.
  const words = versionNoticeStrings(
    typeof document !== "undefined" ? document.documentElement.lang : undefined,
  );
  return (
    <button
      data-testid="new-version"
      onClick={() => window.location.reload()}
      className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))] z-[var(--lk-z-notice)] rounded-full bg-primary px-4 py-2 text-sm text-on-primary shadow-lg hover:bg-blue-700"
    >
      {words.refresh}
    </button>
  );
}

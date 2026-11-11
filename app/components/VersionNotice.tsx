"use client";

import { useEffect, useRef, useState } from "react";
import { getKey } from "@lianki/debug-chat/storage-keys";
import { onDirtyNotify } from "@lianki/ui-state/dirty";
import { pageBuildId } from "@/lib/build-id";
import { pageIsDirty, reloadDecision, whenClean } from "@/lib/page-dirty";
import {
  type ApplyMoment,
  RESUME_KEY,
  anchorSelector,
  autoUpdateOn,
  autoUpdatePref,
  mayApplyAt,
  registerUpdateChecks,
  resumeFor,
  trackWrites,
  updateState,
} from "@/lib/auto-update";
import { publicCfg } from "@/lib/config-client";
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
/** Input that means the user is doing something: the quiet spell starts over. */
const BUSY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll", "input"] as const;

/** Keep where the user is (route, scroll, the element at the top), then reload. */
function reloadHere() {
  try {
    const top = document.elementFromPoint(window.innerWidth / 2, 8);
    const holder = (top?.closest("[id], [data-testid]") as HTMLElement | null) ?? null;
    const anchor = anchorSelector(holder);
    sessionStorage.setItem(
      RESUME_KEY,
      JSON.stringify({
        path: location.pathname + location.search,
        y: window.scrollY,
        ...(anchor && holder ? { anchor, offset: holder.getBoundingClientRect().top } : {}),
      }),
    );
  } catch {}
  location.reload();
}

/** After an auto reload: back to the same place, once the page is tall enough. */
function resumeScroll() {
  let r: ReturnType<typeof resumeFor> = null;
  try {
    r = resumeFor(sessionStorage.getItem(RESUME_KEY), location.pathname + location.search);
    sessionStorage.removeItem(RESUME_KEY);
  } catch {}
  if (!r) return;
  const place = r;
  const go = () => {
    const el = place.anchor ? document.querySelector(place.anchor) : null;
    if (el)
      window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - (place.offset ?? 0));
    else window.scrollTo(0, place.y);
  };
  go();
  // Content that loads after hydration makes the page taller: once more when it has.
  if (document.readyState !== "complete") window.addEventListener("load", go, { once: true });
}

/**
 * "New version" once a deploy lands that changed this page, pushed — never
 * polled — by lianki-push (workers/push): a WebSocket that names the serving
 * build on connect and again when a new one is published, with what changed
 * since the page's own build (smart refresh, lib/smart-refresh.ts).
 *
 * Only when the page's route, or the shared shell, loads different client code
 * (or the deploy is forced) does it show. Otherwise the news is kept: a later
 * move to a route that did change shows it then. Server-only deploys change no
 * client chunk, so they never show it.
 *
 * Then, with auto-update on (`autoUpdate`: the flag `app.auto-update`, and the
 * user's switch, lib/auto-update.ts), a clean page reloads by itself — in the
 * background, on the next move to another page, or after a quiet spell — and
 * comes back to the same place; the pill says "updates when idle", or "unsaved
 * changes" while the page is dirty. Off: the plain "Refresh" button. A tap on
 * the pill always reloads at once.
 *
 * Connected only while the page is visible and focused. Leaving it drops the
 * socket after IDLE_MS (debounced: a quick switch away and back keeps the
 * same one); coming back reconnects at once, and the build id it hears on
 * connect covers any deploy made meanwhile. A socket the network drops is
 * reopened on that event, if the page is still in use — no polling.
 *
 * `pathname` is the page's route path (NewVersionNotice passes Next's).
 */
export function VersionNotice({
  pathname,
  autoUpdate = false,
}: {
  pathname: string;
  autoUpdate?: boolean;
}) {
  const [stale, setStale] = useState(false);
  /** Auto-update waits for this page (it is on and the page is out of date). */
  const [auto, setAuto] = useState(false);
  const [dirty, setDirty] = useState(false);
  const path = useRef(pathname);
  /** Re-judge the kept news for a new path (set by the effect below). */
  const rejudge = useRef<() => void>(() => {});
  /** A clean page may reload at this moment (set while auto-update waits). */
  const applyAt = useRef<(m: ApplyMoment) => void>(() => {});

  useEffect(() => {
    resumeScroll();
  }, []);

  useEffect(() => {
    const moved = path.current !== pathname;
    path.current = pathname;
    if (moved) applyAt.current("navigate");
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
    const stops: (() => void)[] = [];
    const waitClean = () => {
      unwait();
      unwait = whenClean(document, () => location.reload());
      setStale(true);
    };

    /**
     * Auto-update for everyone (lib/auto-update.ts): reload a clean page at the
     * first moment it may; meanwhile the pill shows whether it is clean.
     */
    const waitIdle = () => {
      const writes = trackWrites(window);
      stops.push(() => writes.stop(), registerUpdateChecks(document, writes));
      const clean = () => !pageIsDirty(document);
      applyAt.current = (m) => {
        if (mayApplyAt(m, path.current) && clean()) reloadHere();
      };
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const rest = () => {
        clearTimeout(quiet);
        quiet = setTimeout(() => applyAt.current("idle"), publicCfg("app.autoUpdateIdleMs"));
      };
      const look = () => setDirty(!clean());
      const hidden = () => {
        if (document.visibilityState === "hidden") applyAt.current("hidden");
        else rest();
      };
      for (const t of BUSY_EVENTS)
        window.addEventListener(t, rest, { capture: true, passive: true });
      document.addEventListener("visibilitychange", hidden);
      for (const t of ["input", "change", "focusout", "submit", "ended", "pause", "play"])
        document.addEventListener(t, look, true);
      stops.push(
        onDirtyNotify(look),
        () => clearTimeout(quiet),
        () => {
          for (const t of BUSY_EVENTS) window.removeEventListener(t, rest, { capture: true });
          document.removeEventListener("visibilitychange", hidden);
          for (const t of ["input", "change", "focusout", "submit", "ended", "pause", "play"])
            document.removeEventListener(t, look, true);
          applyAt.current = () => {};
        },
      );
      look();
      rest();
      setAuto(true);
      setStale(true);
    };

    /** This page is out of date: auto-update, the button, or (a debug device) a reload. */
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
      const first = reloadOnceFor(build);
      const decision = reloadDecision({
        debug,
        first: debug && first,
        dirty: pageIsDirty(document),
      });
      if (decision === "reload")
        return void setTimeout(() => {
          if (!pageIsDirty(document)) location.reload();
          else waitClean();
        }, 1500);
      if (decision === "wait") return waitClean();
      // Everyone else: once per build too, for the same reason.
      if (first && autoUpdateOn({ flag: autoUpdate, pref: autoUpdatePref() })) return waitIdle();
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
      for (const f of stops.splice(0)) f();
    };
  }, [autoUpdate]);

  if (!stale) return null;
  // Mounted outside the Intlayer client provider: the page's lang picks the words.
  const words = versionNoticeStrings(
    typeof document !== "undefined" ? document.documentElement.lang : undefined,
  );
  const state = updateState({ auto, dirty });
  const label =
    state === "auto-clean"
      ? words.autoClean
      : state === "auto-dirty"
        ? words.autoDirty
        : words.refresh;
  return (
    <button
      data-testid="new-version"
      data-state={state}
      onClick={() => window.location.reload()}
      className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))] z-[var(--lk-z-notice)] rounded-full bg-primary px-4 py-2 text-sm text-on-primary shadow-lg hover:bg-blue-700"
    >
      {label}
    </button>
  );
}

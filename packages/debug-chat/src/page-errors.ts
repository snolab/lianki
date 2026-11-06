/**
 * Page errors (docs/dev-debug-widget.md, "Page errors"): the owner's page
 * reports its own console errors to the agent, so the agent can watch them
 * and fix them without being told. The host installs the hooks only while
 * debug mode is on, and attaches a sender only on the owner's own pages (the
 * hub's `state` with no `friend-status` first); a friend's page drops its
 * queue and uninstalls. The hub drops a friend's page-error anyway.
 *
 * What is caught: window `error` and `unhandledrejection`, `console.error`,
 * same-origin `/api/*` responses ≥ 400 and their network failures,
 * `<audio>`/`<video>`/`<img>` load errors (capture phase), and whatever the
 * widget reports itself (`reportPageError`: the local STT socket closing).
 *
 * What is sent: {type:"page-error", kind, message, stack, path, status, at,
 * rev}. Everything is scrubbed first (`scrub`): emails, tokens, key=value
 * secrets, cookies and query strings are replaced, and any text the user
 * typed or said (open inputs, and the chat's own lines, passed as
 * `sensitive`) is cut out. Objects passed to console.error are never
 * serialized. Dedupe by kind + message + path for 5 minutes; at most 10 a
 * minute; message and stack capped.
 */

export type PageErrorKind =
  | "error"
  | "rejection"
  | "console"
  | "fetch"
  | "network"
  | "media"
  | "socket";

export type PageErrorWire = {
  type: "page-error";
  kind: PageErrorKind;
  message: string;
  stack?: string;
  path: string;
  status?: number;
  at: number;
  rev?: string;
};

/** What a hook hands the reporter, before scrubbing. */
export type RawPageError = {
  kind: PageErrorKind;
  message: string;
  stack?: string;
  /** Defaults to the page's own path. A URL is cut to its path. */
  path?: string;
  status?: number;
};

export const PAGE_ERROR_DEDUPE_MS = 5 * 60_000;
export const PAGE_ERROR_PER_MINUTE = 10;
export const PAGE_ERROR_MESSAGE_MAX = 500;
export const PAGE_ERROR_STACK_MAX = 1500;
const STACK_LINES = 12;
/** Errors kept while no owner socket is attached yet (page load, a reconnect). */
const QUEUE_MAX = 10;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+)?/g;
const SECRET_KV =
  /\b(token|access_token|refresh_token|id_token|secret|password|passwd|pwd|auth|authorization|cookie|set-cookie|session|sessionid|sid|api[_-]?key|private[_-]?key|sig|signature|otp)(["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi;
/** `a=b; c=d` — a cookie header. */
const COOKIES = /\b[\w.-]+=[^;\s]+(?:;\s*[\w.-]+=[^;\s]+)+/g;
/** A query string after a URL or path: `…/x?a=1&b=2`, `?text=…`. */
const QUERY = /([\w/.~%-])\?[^\s"'`)<>\]]+/g;
const FRAGMENT = /(https?:\/\/[^\s"'`)<>#]+)#[^\s"'`)<>]+/g;
/** A long opaque string with letters and digits: a token, a key, a signed id. */
const OPAQUE = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Strip what must never leave the page. `sensitive`: text the user typed or
 * said (input values, chat lines); each one of 3+ characters is cut out
 * wherever it appears.
 */
export function scrub(text: string, sensitive: readonly string[] = []): string {
  let s = text;
  for (const t of sensitive) {
    const v = t.trim();
    if (v.length >= 3) s = s.replace(new RegExp(escapeRe(v), "g"), "<typed>");
  }
  return s
    .replace(JWT, "<token>")
    .replace(BEARER, "$1 <token>")
    .replace(EMAIL, "<email>")
    .replace(COOKIES, "<cookie>")
    .replace(SECRET_KV, "$1$2<redacted>")
    .replace(FRAGMENT, "$1#…")
    .replace(QUERY, "$1?…")
    .replace(OPAQUE, "<token>");
}

/** A URL or path as the agent may see it: the path only, same-origin or not; schemes like blob: kept bare. */
export function pathOf(url: string, base = "https://x.invalid"): string {
  if (/^(data|blob|about|javascript):/i.test(url)) return `${url.split(":")[0].toLowerCase()}:`;
  try {
    const u = new URL(url, base);
    const p = u.pathname || "/";
    return u.origin === new URL(base).origin ? p : `${u.host}${p}`;
  } catch {
    return url.split(/[?#]/)[0].slice(0, 200) || "/";
  }
}

const cap = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A stack, scrubbed: at most STACK_LINES lines and PAGE_ERROR_STACK_MAX characters. */
export function trimStack(stack: string | undefined, sensitive: readonly string[] = []) {
  if (!stack) return undefined;
  const lines = scrub(stack, sensitive).split("\n").slice(0, STACK_LINES).join("\n");
  return cap(lines, PAGE_ERROR_STACK_MAX) || undefined;
}

/** One console.error argument as text: strings, numbers and Errors; never an object's contents. */
export function argText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v === null || v === undefined) return String(v);
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === "function") return "[function]";
  const tag = Object.prototype.toString.call(v).slice(8, -1);
  return `[${tag}]`;
}

export type ReporterOpts = {
  now?: () => number;
  /** The build (NEXT_PUBLIC_BUILD_ID). */
  rev?: string;
  /** The page's own path (location.pathname). */
  pagePath: () => string;
  /** Text the user typed or said, to cut out (inputs, chat lines). */
  sensitive?: () => readonly string[];
};

export type PageErrorReporter = {
  /** Scrub, dedupe, rate-limit, then send or queue. Returns what was kept, or null. */
  report(e: RawPageError): PageErrorWire | null;
  /** Start sending (the owner's live socket); the queue goes first. */
  attach(send: (m: PageErrorWire) => void): void;
  /** The socket closed: queue again. */
  detach(): void;
  /** Not the owner's page: drop the queue and keep nothing from now on. */
  disable(): void;
};

export function createPageErrorReporter(o: ReporterOpts): PageErrorReporter {
  const now = o.now ?? Date.now;
  const seen = new Map<string, number>();
  const sentAt: number[] = [];
  let queue: PageErrorWire[] = [];
  let sink: ((m: PageErrorWire) => void) | null = null;
  let off = false;
  const deliver = (m: PageErrorWire) => {
    if (sink) {
      try {
        sink(m);
        return;
      } catch {}
    }
    queue.push(m);
    if (queue.length > QUEUE_MAX) queue.shift();
  };
  return {
    report(e) {
      if (off) return null;
      const t = now();
      // Over the limit: nothing to do, not even the scrubbing.
      while (sentAt.length && t - sentAt[0] >= 60_000) sentAt.shift();
      if (sentAt.length >= PAGE_ERROR_PER_MINUTE) return null;
      const sensitive = o.sensitive?.() ?? [];
      const message = cap(scrub(e.message, sensitive).trim(), PAGE_ERROR_MESSAGE_MAX);
      if (!message) return null;
      const path = scrub(pathOf(e.path ?? o.pagePath()));
      const key = `${e.kind}\u0000${message}\u0000${path}`;
      for (const [k, at] of seen) if (t - at >= PAGE_ERROR_DEDUPE_MS) seen.delete(k);
      if (seen.has(key)) return null;
      seen.set(key, t);
      sentAt.push(t);
      const stack = trimStack(e.stack, sensitive);
      const m: PageErrorWire = {
        type: "page-error",
        kind: e.kind,
        message,
        ...(stack ? { stack } : {}),
        path,
        ...(e.status !== undefined ? { status: e.status } : {}),
        at: t,
        ...(o.rev ? { rev: o.rev } : {}),
      };
      deliver(m);
      return m;
    },
    attach(send) {
      if (off) return;
      sink = send;
      const q = queue;
      queue = [];
      for (const m of q) deliver(m);
    },
    detach() {
      sink = null;
    },
    disable() {
      off = true;
      sink = null;
      queue = [];
    },
  };
}

/** The installed reporter, for the widget's own reports (reportPageError). */
let current: ((e: RawPageError) => void) | null = null;

/** Report an error the hooks cannot see (the local STT socket closing). A no-op when none is installed. */
export function reportPageError(e: RawPageError) {
  try {
    current?.(e);
  } catch {}
}

type Win = Window & typeof globalThis;

/** What the user typed into the page right now: input and textarea values, editable text. */
export function typedText(doc: Document): string[] {
  const out: string[] = [];
  try {
    for (const el of Array.from(doc.querySelectorAll("input, textarea"))) {
      const v = (el as HTMLInputElement).value;
      if (typeof v === "string" && v.trim().length >= 3) out.push(v);
    }
    for (const el of Array.from(doc.querySelectorAll("[contenteditable=''],[contenteditable=true]"))) {
      const v = el.textContent ?? "";
      if (v.trim().length >= 3) out.push(v);
    }
  } catch {}
  return out;
}

/** A failed fetch this long after the page was hidden is the page going away, not the network. */
export const NETWORK_AFTER_HIDE_MS = 1000;

/**
 * Is a failed /api fetch a real network failure worth a report? Not when it
 * was aborted: an AbortError, or its signal aborted (WebKit throws a plain
 * TypeError "Load failed" for an aborted fetch, so the signal decides; the
 * /words audio prefetcher, lib/words/audio-cache, cancels its TTS fetches
 * this way). Not while the page is going away (pagehide, beforeunload,
 * hidden), nor within NETWORK_AFTER_HIDE_MS after it was hidden.
 */
export function isReportableNetworkFailure(d: {
  error: unknown;
  signalAborted: boolean;
  unloading: boolean;
  now: number;
  hiddenAt: number | null;
}): boolean {
  if ((d.error as { name?: string } | null)?.name === "AbortError") return false;
  if (d.signalAborted || d.unloading) return false;
  return d.hiddenAt === null || d.now - d.hiddenAt >= NETWORK_AFTER_HIDE_MS;
}

/**
 * Hook the page: error / unhandledrejection, console.error, fetch to
 * same-origin /api/*, media and image load errors. Returns the uninstall.
 * The reporter's own work never re-enters it.
 */
export function installPageErrorHooks(
  win: Win,
  reporter: PageErrorReporter,
  now: () => number = () => Date.now(),
): () => void {
  let busy = false;
  /** The page is going away (pagehide, beforeunload, hidden), and when it was hidden. */
  let unloading = false;
  let hiddenAt: number | null = null;
  const away = () => {
    unloading = true;
    hiddenAt = now();
  };
  const back = () => {
    unloading = false;
  };
  const onVisibility = () => {
    if (win.document?.visibilityState === "hidden") away();
    else back();
  };
  const report = (e: RawPageError) => {
    if (busy) return;
    busy = true;
    try {
      reporter.report(e);
    } catch {
    } finally {
      busy = false;
    }
  };
  current = report;
  const origin = win.location.origin;

  const onError = (ev: Event) => {
    const target = ev.target as (Element & { src?: string; currentSrc?: string }) | null;
    const tag = target && "tagName" in target ? String(target.tagName).toUpperCase() : "";
    if (tag === "AUDIO" || tag === "VIDEO" || tag === "IMG" || tag === "SOURCE") {
      const src = target?.currentSrc || target?.src || target?.getAttribute?.("src") || "";
      const code = (target as unknown as HTMLMediaElement).error?.code;
      report({
        kind: "media",
        message: `${tag.toLowerCase()} failed to load${code ? ` (MediaError ${code})` : ""}: ${pathOf(src, origin)}`,
        path: win.location.pathname,
      });
      return;
    }
    if (target && target !== (win as unknown as EventTarget) && tag) return; // other element loads (script, link): leave
    const e = ev as ErrorEvent;
    const err = e.error as Error | undefined;
    const where = e.filename ? ` (${pathOf(e.filename, origin)}:${e.lineno}:${e.colno})` : "";
    report({
      kind: "error",
      message: `${err instanceof Error ? `${err.name}: ${err.message}` : e.message || "error"}${where}`,
      stack: err instanceof Error ? err.stack : undefined,
    });
  };
  const onRejection = (ev: PromiseRejectionEvent) => {
    const r = ev.reason;
    report({
      kind: "rejection",
      message: `Unhandled rejection: ${argText(r)}`,
      stack: r instanceof Error ? r.stack : undefined,
    });
  };
  win.addEventListener("error", onError, true);
  win.addEventListener("unhandledrejection", onRejection);
  win.addEventListener("pagehide", away);
  win.addEventListener("beforeunload", away);
  win.addEventListener("pageshow", back);
  win.document?.addEventListener?.("visibilitychange", onVisibility);

  const origError = win.console.error;
  const wrappedError = function (this: Console, ...args: unknown[]) {
    const firstErr = args.find((a): a is Error => a instanceof Error);
    report({
      kind: "console",
      message: args.map(argText).join(" "),
      stack: firstErr?.stack,
    });
    return origError.apply(this, args);
  };
  win.console.error = wrappedError;

  const origFetch = win.fetch;
  const wrappedFetch = async function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let url: URL | null = null;
    let method = "GET";
    try {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      url = new URL(raw, win.location.href);
      method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    } catch {}
    const watched = !!url && url.origin === origin && url.pathname.startsWith("/api/");
    try {
      const res = await origFetch.call(win, input, init);
      if (watched && url && res.status >= 400)
        report({
          kind: "fetch",
          message: `${method} ${url.pathname} ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
          path: url.pathname,
          status: res.status,
        });
      return res;
    } catch (e) {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const real = isReportableNetworkFailure({
        error: e,
        signalAborted: !!signal?.aborted,
        unloading,
        now: now(),
        hiddenAt,
      });
      if (watched && url && real)
        report({
          kind: "network",
          message: `${method} ${url.pathname} failed: ${argText(e)}`,
          path: url.pathname,
        });
      throw e;
    }
  } as typeof fetch;
  win.fetch = wrappedFetch;

  return () => {
    win.removeEventListener("error", onError, true);
    win.removeEventListener("unhandledrejection", onRejection);
    win.removeEventListener("pagehide", away);
    win.removeEventListener("beforeunload", away);
    win.removeEventListener("pageshow", back);
    win.document?.removeEventListener?.("visibilitychange", onVisibility);
    if (win.console.error === wrappedError) win.console.error = origError;
    if (win.fetch === wrappedFetch) win.fetch = origFetch;
    if (current === report) current = null;
  };
}

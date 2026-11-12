/**
 * Smart refresh end to end (docs/shipping.md, "Smart refresh"; owner,
 * 2026-11-09 18:29 JST: "only invite me to refresh when something changed on
 * MY CURRENT page").
 *
 *   bun scripts/qa/qa-smart-refresh.ts
 *
 * Needs no app server: a small Bun server runs the real lianki-push VersionHub
 * (workers/push/src/index.ts) behind /api/version/ws, and serves a page that
 * mounts the real VersionNotice (qa-smart-refresh.page.tsx) on a build "A".
 * New builds are published to the hub with route fingerprints, as the main
 * Worker does after a deploy, and the page is checked for the button:
 *
 *   - only another route changed        → no button
 *   - soft navigation to that route     → button
 *   - the current route changed         → button
 *   - a server-only deploy              → no button
 *   - a forced deploy                   → button
 *
 * Chromium, silent. Exit code 1 on a failed check.
 */
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { VersionHub, type Env } from "../../workers/push/src/index";
import type { RouteFingerprints } from "../../lib/smart-refresh";
import { publishInit } from "../../lib/announce-build";
import { launchSilent, newSilentContext } from "./silent.mjs";

const ROOT = join(import.meta.dir, "../..");
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "qa-smart-refresh.page.tsx")],
  target: "browser",
  format: "iife",
  tsconfig: join(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!built.success) throw new AggregateError(built.logs, "page bundle failed");
const js = await built.outputs[0].text();
const html = `<!doctype html><html lang="en" data-build="A"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width"></head>
<body><div id="root"></div><script src="/app.js"></script></body></html>`;

// ── lianki-push's VersionHub, its sockets bridged to Bun's ───────────────────
type BunWs = { send(d: string): void; close(): void; data: { url: string } };
type Bridge = {
  send(d: string): void;
  close(): void;
  serializeAttachment(v: unknown): void;
  deserializeAttachment(): unknown;
};
const store = new Map<string, unknown>();
const live = new Set<Bridge>();
let wiring: BunWs | null = null;
(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
  0 = {};
  1: Bridge;
  constructor() {
    const ws = wiring!;
    let att: unknown = null;
    this[1] = {
      send: (d) => ws.send(d),
      close: () => ws.close(),
      serializeAttachment: (v) => void (att = v),
      deserializeAttachment: () => att,
    };
  }
};
const hub = new VersionHub(
  {
    acceptWebSocket: (ws) => void live.add(ws as unknown as Bridge),
    getWebSockets: () => [...live] as unknown as WebSocket[],
    storage: {
      get: async <T>(k: string) => store.get(k) as T | undefined,
      put: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => store.delete(k),
    },
  },
  {} as Env,
);
const bridges = new WeakMap<object, Bridge>();
/** A deploy of `fingerprints`, announced as the main Worker does (its static asset → the hub). */
const publish = async (fingerprints: RouteFingerprints) =>
  hub.fetch(
    new Request(
      "https://lianki-push/internal/publish",
      await publishInit(fingerprints.build, { fetch: async () => Response.json(fingerprints) }),
    ),
  );

const server = Bun.serve<{ url: string }, never>({
  port: 0,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/api/version/ws")
      return srv.upgrade(req, { data: { url: req.url } })
        ? undefined
        : new Response("", { status: 400 });
    if (url.pathname === "/app.js")
      return new Response(js, { headers: { "content-type": "text/javascript" } });
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
  websocket: {
    async open(ws) {
      wiring = ws as unknown as BunWs;
      const before = new Set(live);
      await hub.fetch(new Request(ws.data.url));
      for (const b of live) if (!before.has(b)) bridges.set(ws, b);
    },
    message() {},
    close(ws) {
      const b = bridges.get(ws);
      if (b) live.delete(b);
    },
  },
});
const BASE = `http://localhost:${server.port}`;

// ── builds: A is the page's; each later one changes something else ──────────
const ROUTES = { "/words": "w1", "/list": "l1", "/stats": "s1" };
const A: RouteFingerprints = { build: "A", shell: "shell1", routes: ROUTES };
const B: RouteFingerprints = { build: "B", shell: "shell1", routes: { ...ROUTES, "/list": "l2" } };
const C: RouteFingerprints = { ...B, build: "C", routes: { ...B.routes, "/words": "w2" } };
const D: RouteFingerprints = { ...C, build: "D" }; // server-only: no client chunk changed
const E: RouteFingerprints = { ...D, build: "E", force: true };

let failed = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const browser = await launchSilent(chromium);
const context = await newSilentContext(browser);
await context.addInitScript(() => localStorage.setItem("lk:version-notice", "1"));

/** Open `path` on build A and wait until its socket has heard `n` messages. */
const open = async (path: string, n = 1) => {
  const page = await context.newPage();
  await page.goto(`${BASE}${path}`);
  await page.bringToFront();
  await heard(page, n);
  return page;
};
const heard = (page: Page, n: number) =>
  page.waitForFunction((k) => (window as unknown as { __msgs: string[] }).__msgs.length >= k, n, {
    timeout: 10_000,
  });
const button = (page: Page) => page.getByTestId("new-version").isVisible();
/** The button shows within a moment of the news (React commits it on the next frame). */
const shows = (page: Page) =>
  page
    .getByTestId("new-version")
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
const settle = (page: Page) => page.evaluate(() => new Promise((r) => setTimeout(r, 300)));

try {
  await publish(A);
  const words = await open("/words");
  check(!(await button(words)), "build A, page on A: no button");

  await publish(B);
  await heard(words, 2);
  await settle(words);
  check(!(await button(words)), "B changed /list only: /words stays quiet");

  await words.evaluate(() => (window as unknown as { __nav: (p: string) => void }).__nav("/list"));
  check(await shows(words), "soft navigation to /list (changed in B): button");

  const words2 = await open("/words");
  await settle(words2);
  check(!(await button(words2)), "a fresh /words page on A, B serving: quiet");
  await publish(C);
  await heard(words2, 2);
  check(await shows(words2), "C changed /words: button on /words");

  const stats = await open("/stats");
  await publish(D);
  await heard(stats, 2);
  await settle(stats);
  check(!(await button(stats)), "D is server-only: /stats stays quiet");
  await publish(E);
  await heard(stats, 3);
  check(await shows(stats), "E is forced: button on /stats");

  // Readiness runs against the real component, with only the edge response faked.
  const probePage = async () => {
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem("lk:debug", "1"));
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    return { page, navigations: () => navigations };
  };
  const until = async (f: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!f() && Date.now() < deadline) await Bun.sleep(20);
    return f();
  };

  const ready = await probePage();
  let requests = 0;
  await ready.page.route("**/_lk/route-fp.json?*", (route) =>
    route.fulfill({ json: ++requests === 1 ? A : E }),
  );
  await ready.page.goto(`${BASE}/words`);
  await ready.page.bringToFront();
  check(await until(() => ready.navigations() === 2), "debug: old edge then target build reloads");
  check(requests === 2, "debug: target build ends readiness requests");
  await ready.page.close();

  const dirty = await probePage();
  let release: (() => Promise<void>) | undefined;
  await dirty.page.route("**/_lk/route-fp.json?*", (route) => {
    release = () => route.fulfill({ json: E });
  });
  await dirty.page.goto(`${BASE}/words`);
  await dirty.page.bringToFront();
  check(await until(() => !!release), "dirty: initial readiness request starts immediately");
  await dirty.page.evaluate(() => {
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
  });
  await release!();
  await settle(dirty.page);
  check(dirty.navigations() === 1, "ready edge does not reload while a field is focused");
  await dirty.page.evaluate(() => (document.activeElement as HTMLElement).blur());
  check(
    await until(() => dirty.navigations() === 2),
    "ready edge reloads when the page becomes clean",
  );
  await dirty.page.close();

  const unready = await probePage();
  let staleRequests = 0;
  await unready.page.route("**/_lk/route-fp.json?*", (route) => {
    staleRequests++;
    return route.fulfill({ json: A });
  });
  await unready.page.goto(`${BASE}/words`);
  await unready.page.bringToFront();
  check(await shows(unready.page), "unready edge falls back to the refresh button");
  check(unready.navigations() === 1, "readiness timeout never forces a reload");
  const attemptsAtTimeout = staleRequests;
  await settle(unready.page);
  check(staleRequests === attemptsAtTimeout, "readiness timeout stops further requests");
  await unready.page.close();

  // A queued message from a closed socket must not revive an unmounted effect.
  await publish(A);
  const late = await context.newPage();
  let lateRequests = 0;
  let lateNavigations = 0;
  late.on("framenavigated", (frame) => {
    if (frame === late.mainFrame()) lateNavigations++;
  });
  await late.addInitScript(() => localStorage.setItem("lk:debug", "1"));
  await late.route("**/_lk/route-fp.json?*", (route) => {
    lateRequests++;
    return route.fulfill({ json: E });
  });
  await late.goto(`${BASE}/words`);
  await late.bringToFront();
  await heard(late, 1);
  await late.evaluate(() => {
    const w = window as unknown as {
      __versionSockets: WebSocket[];
      __unmountNotice: () => void;
      __lateNews: () => void;
    };
    const socket = w.__versionSockets[0]!;
    const handler = socket.onmessage;
    w.__lateNews = () =>
      handler?.call(
        socket,
        new MessageEvent("message", { data: JSON.stringify({ build: "E", force: true }) }),
      );
    w.__unmountNotice();
  });
  await settle(late);
  await late.evaluate(() => (window as unknown as { __lateNews: () => void }).__lateNews());
  await settle(late);
  check(lateRequests === 0, "unmounted: queued old socket message starts no readiness request");
  check(lateNavigations === 1, "unmounted: late matching build cannot reload");
  await late.close();
  await publish(E);

  const autoPage = async () => {
    const page = await context.newPage();
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    await page.addInitScript(() => {
      localStorage.removeItem("lk:debug");
      localStorage.setItem("lk:auto-update", "1");
      const w = window as unknown as { __qaVisibility: string; __baseFetch: typeof fetch };
      w.__qaVisibility = "visible";
      w.__baseFetch = window.fetch;
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => w.__qaVisibility,
      });
    });
    return { page, navigations: () => navigations };
  };
  const hide = (page: Page) =>
    page.evaluate(() => {
      (window as unknown as { __qaVisibility: string }).__qaVisibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });

  // A write that STARTS during the readiness wait must survive the ready edge.
  const writing = await autoPage();
  let readyWrite: (() => Promise<void>) | undefined;
  let finishWrite: (() => Promise<void>) | undefined;
  await writing.page.route("**/_lk/route-fp.json?*", (route) => {
    readyWrite = () => route.fulfill({ json: E });
  });
  await writing.page.route("**/api/qa-pending-write", (route) => {
    finishWrite = () => route.fulfill({ json: { ok: true } });
  });
  await writing.page.goto(`${BASE}/words?auto=1`);
  await writing.page.bringToFront();
  check(
    await until(() => !!readyWrite),
    "auto-write: readiness is pending before the write starts",
  );
  await writing.page.evaluate(() => {
    const w = window as unknown as { __writeDone?: boolean };
    void fetch("/api/qa-pending-write", { method: "POST", body: "synthetic" }).then(() => {
      w.__writeDone = true;
    });
  });
  check(await until(() => !!finishWrite), "auto-write: real browser POST starts during the probe");
  await hide(writing.page);
  await readyWrite!();
  await writing.page.getByTestId("new-version").waitFor();
  await settle(writing.page);
  check(
    writing.navigations() === 1,
    "auto-write: ready while hidden does not interrupt the pending POST",
  );
  check(
    (await writing.page.getByTestId("new-version").getAttribute("data-state")) === "auto-dirty",
    "auto-write: pending pre-ready POST marks the page dirty",
  );
  await finishWrite!();
  await writing.page.waitForFunction(
    () => (window as unknown as { __writeDone?: boolean }).__writeDone === true,
  );
  await settle(writing.page);
  check(
    writing.navigations() === 1,
    "auto-write: becoming clean waits for an allowed apply moment",
  );
  await hide(writing.page);
  check(
    await until(() => writing.navigations() === 2),
    "auto-write: next clean hidden moment reloads",
  );
  await writing.page.close();

  const hidden = await autoPage();
  let readyHidden: (() => Promise<void>) | undefined;
  await hidden.page.route("**/_lk/route-fp.json?*", (route) => {
    readyHidden = () => route.fulfill({ json: E });
  });
  await hidden.page.goto(`${BASE}/words?auto=1`);
  await hidden.page.bringToFront();
  check(await until(() => !!readyHidden), "auto-hidden: readiness begins before hiding");
  await hide(hidden.page);
  check(hidden.navigations() === 1, "auto-hidden: hidden alone never reloads an unready build");
  await readyHidden!();
  check(
    await until(() => hidden.navigations() === 2),
    "auto-hidden: ready clean page already hidden reloads without another event",
  );
  await hidden.page.close();

  const timedOut = await autoPage();
  await timedOut.page.route("**/_lk/route-fp.json?*", (route) => route.fulfill({ json: A }));
  await timedOut.page.goto(`${BASE}/words?auto=1`);
  await timedOut.page.bringToFront();
  check(await shows(timedOut.page), "auto-timeout: unready edge shows manual refresh");
  check(
    await timedOut.page.evaluate(
      () => window.fetch === (window as unknown as { __baseFetch: typeof fetch }).__baseFetch,
    ),
    "auto-timeout: pending write tracker is removed",
  );
  await hide(timedOut.page);
  await settle(timedOut.page);
  check(timedOut.navigations() === 1, "auto-timeout: hidden after fallback never forces refresh");
  await timedOut.page.close();
} finally {
  await browser.close();
  server.stop(true);
}

if (failed) {
  console.error(`qa-smart-refresh: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("qa-smart-refresh: all checks passed");

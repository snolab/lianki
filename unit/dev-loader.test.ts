import { describe, expect, it } from "bun:test";
import { renderLoader } from "../scripts/dev-loader-render";

/**
 * scripts/dev-loader.user.js — the long-poll dev loader served by
 * scripts/dev-userscript-server.ts.
 *
 * Hand-written, no build step, so nothing typechecks it. These tests render it
 * the way the server does and then actually EXECUTE it against stubbed GM_*
 * APIs, because the properties that matter (the eval scope, the GM_info shadow,
 * rev bookkeeping) only exist at runtime.
 */
const ORIGIN = "https://dev.example.com";
const APP = "https://lianki.com";

const render = (over: Partial<Parameters<typeof renderLoader>[0]> = {}) =>
  renderLoader({ origin: ORIGIN, appOrigin: APP, version: "2.23.20", rev: "abc123", ...over });

type Req = {
  method?: string;
  url: string;
  data?: string;
  onload?: Function;
  onerror?: Function;
  ontimeout?: Function;
};

/**
 * Drive the loader with stubs. Direct `eval` inside the loader resolves against
 * this function's scope, so the stubs land exactly where the real GM grants
 * would — which is itself one of the things under test.
 */
function runLoader(opts: {
  source?: string;
  topFrame?: boolean;
  stored?: Record<string, string>;
  /** Answer for a path. "pending" parks the request, which is what the real
   *  long poll does — answering /wait instantly would spin the pump loop. */
  answer: (path: string) => { status: number; body: string } | "network" | "pending";
  readyState?: string;
}) {
  const store: Record<string, string> = { ...opts.stored };
  const requests: Req[] = [];
  const posts: { url: string; data: string }[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const listeners: Record<string, Function[]> = {};

  const GM_xmlhttpRequest = (req: Req) => {
    requests.push(req);
    const path = req.url.slice(ORIGIN.length);
    if ((req.method ?? "GET") === "POST") {
      posts.push({ url: req.url, data: req.data ?? "" });
      return;
    }
    const res = opts.answer(path);
    if (res === "pending") return; // parked, exactly like a real long poll
    // Async like the real thing, so the loader's await actually suspends.
    queueMicrotask(() => {
      if (res === "network") req.onerror?.();
      else req.onload?.({ status: res.status, responseText: res.body });
    });
  };

  const win = {
    self: {} as object,
    top: {} as object,
    addEventListener: (ev: string, fn: Function) => (listeners[ev] ??= []).push(fn),
  };
  if (opts.topFrame !== false) win.top = win.self;

  const fn = new Function(
    "window",
    "document",
    "location",
    "console",
    "setInterval",
    "setTimeout",
    "trustedTypes",
    "GM_info",
    "GM_getValue",
    "GM_setValue",
    "GM_xmlhttpRequest",
    opts.source ?? render(),
  );

  fn(
    win,
    { readyState: opts.readyState ?? "complete", addEventListener: () => {} },
    { href: "https://site.test/page", hostname: "site.test" },
    {
      log: (...a: unknown[]) => logs.push(a.join(" ")),
      warn: (...a: unknown[]) => warns.push(a.join(" ")),
      error: Object.assign((...a: unknown[]) => logs.push(a.join(" ")), { bind: () => () => {} }),
    },
    () => 0,
    (cb: Function, ms: number) => (ms >= 1000 ? 0 : (queueMicrotask(() => cb()), 0)),
    { createPolicy: () => ({ createScript: (s: string) => s }) },
    { script: { version: "0.0.0-loader", downloadURL: `${ORIGIN}/loader.user.js` } },
    (k: string, d = "") => store[k] ?? d,
    (k: string, v: string) => (store[k] = v),
    GM_xmlhttpRequest,
  );

  return {
    store,
    requests,
    posts,
    logs,
    warns,
    fire: (ev: string, arg: unknown) => listeners[ev]?.forEach((f) => f(arg)),
  };
}

describe("rendered header", () => {
  it("fills every placeholder", () => {
    expect(render()).not.toMatch(/__[A-Z_]+__/);
  });

  it("points @downloadURL at the dev server so the manager can update it", () => {
    expect(render()).toContain(`// @downloadURL ${ORIGIN}/loader.user.js`);
  });

  it("grants connect for both the dev server and the app", () => {
    const connect = [...render().matchAll(/^\/\/ @connect\s+(\S+)$/gm)].map((m) => m[1]);
    expect(connect).toContain("dev.example.com");
    expect(connect).toContain("lianki.com");
  });

  it("adds the trycloudflare apex, which is what a manager matches against", () => {
    const connect = [
      ...render({ origin: "https://foo-bar.trycloudflare.com" }).matchAll(
        /^\/\/ @connect\s+(\S+)$/gm,
      ),
    ].map((m) => m[1]);
    expect(connect).toContain("trycloudflare.com");
  });

  it("keeps the dotted version numerically equal to the build", () => {
    // The bundle's isNewerVersion() parseInt()s each dotted segment, so a
    // "-dev.x" suffix must not raise or lower the comparison — otherwise every
    // page load prompts to update.
    const v = (render().match(/@version\s+(\S+)/) ?? [])[1]!;
    const seg = (s: string) =>
      s
        .split(".")
        .map((n) => parseInt(n) || 0)
        .slice(0, 3);
    expect(seg(v)).toEqual(seg("2.23.20"));
    expect(v).toContain("-dev.");
  });
});

describe("loader runtime", () => {
  // A real bundle string — the loader eval()s it, so what it can see IS the
  // property under test.
  /** First /wait pushes rev1; the next parks. Mirrors the server's behavior. */
  const serve = (bundleBody: string) => {
    let waits = 0;
    return (p: string): { status: number; body: string } | "pending" =>
      p.startsWith("/wait")
        ? waits++ === 0
          ? { status: 200, body: "rev1" }
          : "pending"
        : { status: 200, body: bundleBody };
  };

  const probe = (slot: string) =>
    `globalThis.${slot} = { gm: typeof GM_getValue, dl: GM_info.script.downloadURL, v: GM_info.script.version };`;

  it("does nothing in a subframe", async () => {
    const r = runLoader({ topFrame: false, answer: () => ({ status: 200, body: "x" }) });
    await Bun.sleep(5);
    expect(r.requests).toHaveLength(0);
  });

  it("long-polls /wait, then fetches and evals the bundle", async () => {
    const r = runLoader({
      answer: serve(probe("__t1")),
    });
    await Bun.sleep(10);
    expect(r.requests[0]!.url).toContain("/wait?id=");
    expect(r.requests.some((q) => q.url.includes("/bundle.js?id="))).toBe(true);
    expect((globalThis as never as Record<string, { gm: string }>).__t1?.gm).toBe("function");
  });

  it("evaluates the bundle where the GM grants are reachable", async () => {
    // Direct eval inherits the loader's scope. new Function()/(0,eval) would
    // evaluate at global scope, and the bundle would die on its first GM call.
    runLoader({
      answer: serve(probe("__t2")),
    });
    await Bun.sleep(10);
    expect((globalThis as never as Record<string, { gm: string }>).__t2!.gm).toBe("function");
  });

  it("shadows GM_info so the bundle talks to the app, not the dev server", async () => {
    runLoader({
      answer: serve(probe("__t3")),
    });
    await Bun.sleep(10);
    const info = (globalThis as never as Record<string, { dl: string; v: string }>).__t3!;
    expect(info.dl).toBe(`${APP}/lianki.user.js`); // NOT the tunnel
    expect(info.v).toBe("2.23.20-dev.abc123"); // not the loader's own 0.0.0
  });

  it("caches the bundle by rev instead of refetching identical code", async () => {
    const r = runLoader({
      stored: { lianki_devbundle_rev: "rev1", lianki_devbundle_code: probe("__t4") },
      answer: serve("/* unused: served from cache */"),
    });
    await Bun.sleep(10);
    expect(r.requests.some((q) => q.url.includes("/bundle.js"))).toBe(false);
    expect((globalThis as never as Record<string, unknown>).__t4).toBeDefined();
  });

  it("stores a client id outside the app's lk: namespace", async () => {
    const r = runLoader({ answer: serve("/* no-op bundle */") });
    await Bun.sleep(5);
    expect(Object.keys(r.store).some((k) => k.startsWith("lk:"))).toBe(false);
    expect(r.store.lianki_devclient_id).toMatch(/^[a-z0-9]+$/);
  });

  it("reports an eval failure to the server", async () => {
    const r = runLoader({
      answer: serve('throw new Error("boom");'),
    });
    await Bun.sleep(10);
    expect(r.posts.some((p) => p.url.includes("/error?id="))).toBe(true);
    expect(r.posts[0]!.data).toContain("boom");
  });

  it("does not mark a rev current when its eval threw", async () => {
    // Advancing rev before the eval wedged the tab: the next long poll matched,
    // parked, and the page never retried.
    const r = runLoader({
      answer: serve('throw new Error("boom");'),
    });
    await Bun.sleep(10);
    expect(r.requests.filter((q) => q.url.includes("/wait")).at(-1)!.url).toContain("rev=");
    expect(r.requests.filter((q) => q.url.includes("/wait")).at(-1)!.url).not.toContain("rev=rev1");
  });

  it("stops polling a page whose CSP forbids eval", async () => {
    const r = runLoader({
      answer: serve(`throw new EvalError("call to eval() blocked: missing 'unsafe-eval'");`),
    });
    await Bun.sleep(10);
    const before = r.requests.length;
    await Bun.sleep(10);
    expect(r.requests.length).toBe(before); // stopped for good, not backing off
    expect(r.posts[0]!.data).toContain("eval-blocked");
  });

  it("does not forward the page's own errors", async () => {
    const r = runLoader({ answer: serve("/* no-op bundle */") });
    await Bun.sleep(5);
    r.fire("error", { filename: "https://site.test/their.js", message: "their bug" });
    r.fire("error", { message: "ResizeObserver loop completed" });
    expect(r.posts).toHaveLength(0);
    r.fire("error", { message: "[Lianki] sync failed", lineno: 1, colno: 2 });
    expect(r.posts.some((p) => p.data.includes("[Lianki] sync failed"))).toBe(true);
  });
});

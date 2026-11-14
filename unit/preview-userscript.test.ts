import { describe, expect, test } from "bun:test";
import http from "node:http";
import { readFileSync } from "node:fs";
import {
  BUNDLE_PATH,
  GUARD_JS,
  LOADER_GEN,
  LOADER_PATH,
  PreviewUserscript,
  REV_PATH,
  parseHeader,
  previewScriptRoute,
  renderPreviewLoader,
  revOf,
} from "../scripts/dev/preview-userscript";

/** scripts/dev/preview-userscript.ts: the preview dev userscript (docs/dev-whole-page.md). */
const ORIGIN = "https://preview.lianki.com";
const GRANTS = parseHeader(readFileSync("src/lianki.user.ts", "utf8")).grants;
const render = () => renderPreviewLoader({ origin: ORIGIN, version: "2.24.34", grants: GRANTS });

describe("routes", () => {
  test("the three public paths, GET and HEAD only", () => {
    expect(previewScriptRoute("GET", LOADER_PATH)).toBe("loader");
    expect(LOADER_PATH).toBe("/dev/loader.user.js");
    expect(previewScriptRoute("HEAD", BUNDLE_PATH)).toBe("bundle");
    expect(previewScriptRoute("GET", REV_PATH)).toBe("rev");
    expect(previewScriptRoute("POST", LOADER_PATH)).toBeNull();
  });

  test("nothing else, so the app's /dev pages stay behind the gate", () => {
    for (const p of [
      "/dev",
      "/dev/tokens",
      "/dev/loader",
      "/dev/loader.user.js/",
      "/en/dev/loader.user.js",
      "/dev/userscript",
    ])
      expect(previewScriptRoute("GET", p)).toBeNull();
  });
});

describe("rev", () => {
  test("a content hash: same code, same rev; any change, a new one", () => {
    expect(revOf("a")).toBe(revOf("a"));
    expect(revOf("a")).not.toBe(revOf("b"));
    expect(revOf("a")).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("header", () => {
  test("reads @version and @grant from the release source", () => {
    const h = parseHeader(readFileSync("src/lianki.user.ts", "utf8"));
    expect(h.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(h.grants).toContain("GM_xmlhttpRequest");
  });

  test("the loader installs beside the release script, and updates itself", () => {
    const src = render();
    expect(src).toContain("// @name        Lianki (preview dev)\n");
    expect(src).toContain(`// @namespace   ${ORIGIN}/dev\n`);
    expect(src).not.toMatch(/@namespace\s+Violentmonkey Scripts/);
    expect(src).toContain(`// @downloadURL ${ORIGIN}/dev/loader.user.js\n`);
    expect(src).toContain(`// @updateURL   ${ORIGIN}/dev/loader.user.js\n`);
    expect(src).toContain(`// @version     2.24.34.${LOADER_GEN}\n`);
    expect(src).toContain("// @connect     preview.lianki.com\n");
    expect(src).toContain("// @noframes\n");
    for (const g of GRANTS) expect(src).toContain(`// @grant       ${g}\n`);
  });
});

/** GUARD_JS exactly as the loader carries it. */
const guard = new Function(`${GUARD_JS}; return { liankiFab, guardDecision };`)() as {
  liankiFab: (el: unknown) => boolean;
  guardDecision: (o: unknown) => string;
};
const btn = (t: string) => ({ tagName: "BUTTON", textContent: t });
const pill = (ours = false) => ({
  tagName: "DIV",
  dataset: ours ? { liankiPreview: "1" } : {},
  children: [btn("⏪"), { tagName: "DIV" }, btn("🔖"), { tagName: "DIV" }, btn("⏩"), btn("Li")],
});
const base = {
  top: true,
  host: "example.com",
  appHosts: ["lianki.com", "www.lianki.com"],
  otherLoader: false,
  fabs: [],
};

describe("double-run guard", () => {
  test("recognizes the Lianki pill and nothing else", () => {
    expect(guard.liankiFab(pill())).toBe(true);
    expect(guard.liankiFab({ tagName: "DIV", children: [btn("🔖")] })).toBe(false);
    expect(guard.liankiFab({ tagName: "SPAN", children: pill().children })).toBe(false);
    expect(guard.liankiFab(null)).toBe(false);
  });

  test("runs only when no release pill, no other loader, top frame, not the app's site", () => {
    expect(guard.guardDecision(base)).toBe("run");
    expect(guard.guardDecision({ ...base, fabs: [{ ours: true }] })).toBe("run");
    expect(guard.guardDecision({ ...base, fabs: [{ ours: false }] })).toBe("release");
    expect(guard.guardDecision({ ...base, fabs: [{ ours: true }, { ours: false }] })).toBe(
      "release",
    );
    expect(guard.guardDecision({ ...base, otherLoader: true })).toBe("other-loader");
    expect(guard.guardDecision({ ...base, top: false })).toBe("frame");
    expect(guard.guardDecision({ ...base, host: "lianki.com" })).toBe("app-host");
    expect(guard.guardDecision({ ...base, host: "preview.lianki.com" })).toBe("run");
  });
});

/** Run the rendered loader against stubs; the bundle is a tiny script that mounts a pill. */
async function runLoader(opts: { releasePill?: boolean }) {
  const store: Record<string, string> = {};
  const urls: string[] = [];
  const logs: string[] = [];
  const body = { children: [] as unknown[] };
  if (opts.releasePill) body.children.push(pill());
  const root = { dataset: {} as Record<string, string> };
  const BUNDLE =
    "document.body.children.push(" +
    JSON.stringify(pill()) +
    "); globalThis.__seen = GM_info.script.downloadURL + ' ' + GM_info.script.version;";
  const g = globalThis as Record<string, unknown>;
  delete g.__seen;
  const GM_xmlhttpRequest = (r: { url: string; onload: Function }) => {
    urls.push(r.url);
    if (r.url.includes("?wait=")) return; // parked long poll
    queueMicrotask(() =>
      r.url.startsWith(`${ORIGIN}${REV_PATH}`)
        ? r.onload({ status: 200, responseText: '{"rev":"r1","version":"9.9.9"}' })
        : r.onload({ status: 200, responseText: BUNDLE, responseHeaders: "x-lianki-rev: r1\r\n" }),
    );
  };
  const win = { self: {}, top: {} };
  win.top = win.self;
  const fn = new Function(
    "window",
    "document",
    "location",
    "console",
    "setTimeout",
    "MutationObserver",
    "GM_info",
    "GM_getValue",
    "GM_setValue",
    "GM_xmlhttpRequest",
    render(),
  );
  fn(
    win,
    { readyState: "complete", documentElement: root, body },
    { hostname: "example.com", href: "https://example.com/" },
    { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    (cb: () => void) => queueMicrotask(cb),
    undefined,
    { script: { version: "loader" } },
    (k: string, d = "") => store[k] ?? d,
    (k: string, v: string) => (store[k] = v),
    GM_xmlhttpRequest,
  );
  for (let i = 0; i < 20; i++) await Bun.sleep(1);
  return { store, urls, logs, body, root, seen: g.__seen };
}

describe("the loader, executed", () => {
  test("loads the bundle with the preview as its origin, tags its pill, then long-polls", async () => {
    const r = await runLoader({});
    expect(r.seen).toBe(`${ORIGIN}/lianki.user.js 9.9.9`);
    expect(r.store.lianki_preview_rev).toBe("r1");
    expect((r.body.children[0] as { dataset: Record<string, string> }).dataset.liankiPreview).toBe(
      "1",
    );
    expect(r.urls.at(-1)).toBe(`${ORIGIN}${REV_PATH}?wait=r1`);
    expect(r.root.dataset.liankiPreviewLoader).toBeTruthy();
  });

  test("steps aside when the release script's pill is on the page", async () => {
    const r = await runLoader({ releasePill: true });
    expect(r.seen).toBeUndefined();
    expect(r.urls).toEqual([]);
    expect(r.logs.join("\n")).toContain("not run here: release");
  });
});

describe("server", () => {
  async function serveWith(code: string) {
    const us = new PreviewUserscript({
      root: process.cwd(),
      origin: ORIGIN,
      log: () => {},
      build: async () => code,
    });
    await us.rebuild();
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", ORIGIN);
      const route = previewScriptRoute(req.method, url.pathname);
      if (route) void us.serve(route, url, req, res);
      else res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    return { us, srv, base };
  }

  test("serves loader, bundle and rev, never cached; a wait parks until the next build", async () => {
    let code = "one";
    const s = await serveWith("");
    (s.us as unknown as { o: { build: () => Promise<string> } }).o.build = async () => code;
    await s.us.rebuild();
    try {
      // Bun.fetch: another suite may leave globalThis.fetch patched in the full run.
      const loader = await Bun.fetch(`${s.base}${LOADER_PATH}`);
      expect(loader.headers.get("cache-control")).toBe("no-store");
      expect(loader.headers.get("content-type")).toContain("javascript");
      expect(await loader.text()).toContain("Lianki (preview dev)");
      const bundle = await Bun.fetch(`${s.base}${BUNDLE_PATH}`);
      expect(bundle.headers.get("x-lianki-rev")).toBe(revOf("one"));
      expect(await bundle.text()).toBe("one");
      const rev = (await (await Bun.fetch(`${s.base}${REV_PATH}`)).json()) as { rev: string };
      expect(rev.rev).toBe(revOf("one"));
      const parked = Bun.fetch(`${s.base}${REV_PATH}?wait=${rev.rev}`).then((r) => r.json());
      await Bun.sleep(30);
      code = "two";
      await s.us.rebuild();
      expect(((await parked) as { rev: string }).rev).toBe(revOf("two"));
    } finally {
      s.srv.close();
    }
  });

  test("a failed build keeps the last good one", async () => {
    const s = await serveWith("good");
    (s.us as unknown as { o: { build: () => Promise<string> } }).o.build = async () => {
      throw new Error("syntax");
    };
    await s.us.rebuild();
    try {
      expect(s.us.rev).toBe(revOf("good"));
      expect(s.us.error).toContain("syntax");
    } finally {
      s.srv.close();
    }
  });
});

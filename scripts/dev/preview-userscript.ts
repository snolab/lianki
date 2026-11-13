/**
 * The preview dev userscript (docs/dev-whole-page.md, "Preview dev userscript").
 *
 * `whole-page.ts serve --public-host <host>` bundles the served checkout's
 * src/lianki.user.ts in-process (Bun.build) and answers three public paths on
 * the tunnel listener, before the gate and before next dev:
 *
 *   GET /dev/loader.user.js            the loader to install, once
 *   GET /dev/userscript.js             the current bundle (x-lianki-rev)
 *   GET /dev/userscript.rev[?wait=R]   {rev, version}; with wait=<current rev>
 *                                      it parks until the next build (long poll)
 *
 * A new thing, not the dev.lianki.com loader (scripts/dev-userscript-server.ts):
 * no extra server, no tunnel of its own, no error sink, no client table. The
 * bundle's API origin is the preview (its GM_info.script.downloadURL is
 * shadowed to https://<host>/lianki.user.js), so every call it makes goes to
 * the preview and its gate.
 *
 * Pure parts (route, rev, header, loader text, the double-run guard) are
 * exported for unit/preview-userscript.test.ts.
 */
import { createHash } from "node:crypto";
import { readFileSync, watch } from "node:fs";
import type http from "node:http";
import { resolve } from "node:path";

export const LOADER_PATH = "/dev/loader.user.js";
export const BUNDLE_PATH = "/dev/userscript.js";
export const REV_PATH = "/dev/userscript.rev";
/**
 * Bumped when the loader's own text changes, so a manager's update check
 * (it compares @version) picks the new loader up even when the release
 * script's @version did not move.
 */
export const LOADER_GEN = 1;
/** How long a `?wait=` long poll is held; under the loader's 35 s request timeout and Cloudflare's 100 s. */
export const HOLD_MS = 25_000;
/** Parked long polls at most; past it a poll gets 503 and the loader backs off. */
export const MAX_WAITERS = 64;
/** Grants the loader itself needs, whatever the release header says. */
const LOADER_GRANTS = ["GM_xmlhttpRequest", "GM_getValue", "GM_setValue", "GM_info"];
/** The release script's own sites: the preview build never runs there. */
export const APP_HOSTS = ["lianki.com", "www.lianki.com"];

export type PreviewRoute = "loader" | "bundle" | "rev";

/** Which public path this is, or null (then the gate decides as for anything else). GET/HEAD only. */
export function previewScriptRoute(
  method: string | undefined,
  pathname: string,
): PreviewRoute | null {
  const m = (method ?? "GET").toUpperCase();
  if (m !== "GET" && m !== "HEAD") return null;
  if (pathname === LOADER_PATH) return "loader";
  if (pathname === BUNDLE_PATH) return "bundle";
  if (pathname === REV_PATH) return "rev";
  return null;
}

/** A content hash of the bundle: the same code is the same rev, across restarts too. */
export function revOf(code: string): string {
  return createHash("sha256").update(code).digest("hex").slice(0, 12);
}

/** @version and the @grant lines of a userscript header. */
export function parseHeader(src: string): { version: string; grants: string[] } {
  const header = src.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/)?.[1] ?? "";
  const version = header.match(/^\/\/\s*@version\s+(\S+)/m)?.[1] ?? "0.0.0";
  const grants = [...header.matchAll(/^\/\/\s*@grant\s+(\S+)/gm)].map((m) => m[1]);
  return { version, grants };
}

/**
 * The double-run guard, as the browser runs it (pasted into the loader and
 * evaluated by the unit tests from this same text).
 *
 * The release script cannot be seen across userscript sandboxes (its `window`
 * flags stay in its own), but its pill can: a direct child of <body> holding
 * the ⏪ 🔖 ⏩ buttons. The preview bundle mounts the same pill, so the loader
 * tags the ones its own bundle made (data-lianki-preview="1"); an untagged
 * pill is the release script's.
 */
export const GUARD_JS = `
function liankiFab(el) {
  if (!el || el.tagName !== "DIV") return false;
  var t = [];
  var kids = el.children || [];
  for (var i = 0; i < kids.length; i++) if (kids[i].tagName === "BUTTON") t.push(String(kids[i].textContent || "").trim());
  return t.indexOf("\\u23EA") !== -1 && t.indexOf("\\uD83D\\uDD16") !== -1 && t.indexOf("\\u23E9") !== -1;
}
function guardDecision(o) {
  if (!o.top) return "frame";
  if (o.appHosts.indexOf(o.host) !== -1) return "app-host";
  if (o.otherLoader) return "other-loader";
  for (var i = 0; i < o.fabs.length; i++) if (!o.fabs[i].ours) return "release";
  return "run";
}
`;

/** The loader's text: header filled in for this preview host. */
export function renderPreviewLoader(o: {
  /** https://<publicHost> */
  origin: string;
  /** The bundle's @version (src/lianki.user.ts). */
  version: string;
  /** The release header's @grant lines. */
  grants: string[];
}): string {
  const host = new URL(o.origin).hostname;
  const grants = [...new Set([...o.grants, ...LOADER_GRANTS])].filter((g) => g !== "none");
  const pad = (k: string) => `// @${k}`.padEnd(16);
  const header = [
    "// ==UserScript==",
    `${pad("name")}Lianki (preview dev)`,
    `${pad("namespace")}${o.origin}/dev`,
    `${pad("match")}*://*/*`,
    ...grants.map((g) => `${pad("grant")}${g}`),
    `${pad("version")}${o.version}.${LOADER_GEN}`,
    `${pad("author")}lianki.com`,
    `${pad("description")}Lianki from the preview build (${host}): install once; each new preview build is picked up on its own.`,
    `${pad("run-at")}document-start`,
    `${pad("inject-into")}content`,
    `${pad("sandbox")}DOM`,
    `${pad("noframes")}`.trimEnd(),
    `${pad("connect")}${host}`,
    `${pad("downloadURL")}${o.origin}${LOADER_PATH}`,
    `${pad("updateURL")}${o.origin}${LOADER_PATH}`,
    "// ==/UserScript==",
  ].join("\n");
  return `${header}

// Served by scripts/dev/whole-page.ts (scripts/dev/preview-userscript.ts);
// docs/dev-whole-page.md, "Preview dev userscript".
(function () {
  if (window.self !== window.top) return;
  var ORIGIN = ${JSON.stringify(o.origin)};
  var APP_HOSTS = ${JSON.stringify(APP_HOSTS)};
  var BUNDLE = ORIGIN + ${JSON.stringify(BUNDLE_PATH)};
  var REV = ORIGIN + ${JSON.stringify(REV_PATH)};
  var GRACE_MS = 300;
  var PHI = 1.618;
${GUARD_JS}
  var tag = "[lianki preview]";
  var id = Math.random().toString(36).slice(2, 8);
  var root = document.documentElement;
  var loaderInfo = typeof GM_info !== "undefined" ? GM_info : undefined;
  var rev = null;
  var stopped = false;
  var ttPolicy = null;

  var get = function (url, timeout) {
    return new Promise(function (ok, fail) {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        timeout: timeout || 35000,
        onload: function (r) {
          if (r.status >= 200 && r.status < 300) ok(r);
          else fail(new Error("HTTP " + r.status));
        },
        onerror: function () { fail(new Error("network")); },
        ontimeout: function () { fail(new Error("timeout")); },
      });
    });
  };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  var pills = function () {
    var out = [];
    var kids = (document.body && document.body.children) || [];
    for (var i = 0; i < kids.length; i++) if (liankiFab(kids[i])) out.push(kids[i]);
    return out;
  };
  var decide = function () {
    var mark = root.dataset.liankiPreviewLoader;
    return guardDecision({
      top: window.self === window.top,
      host: location.hostname,
      appHosts: APP_HOSTS,
      otherLoader: !!mark && mark !== id,
      fabs: pills().map(function (el) { return { ours: el.dataset.liankiPreview === "1" }; }),
    });
  };

  function run(code, info) {
    // GM_info as the bundle should see it: the preview as its origin (it
    // derives every API call from downloadURL) and its own @version.
    // eslint-disable-next-line no-unused-vars -- read by the eval'd bundle
    var GM_info = Object.assign({}, loaderInfo, {
      script: Object.assign({}, loaderInfo && loaderInfo.script, {
        version: info.version,
        downloadURL: ORIGIN + "/lianki.user.js",
        updateURL: ORIGIN + "/lianki.meta.js",
      }),
    });
    // Direct eval: the bundle needs this scope's GM_* (and the GM_info above).
    try {
      eval(code);
    } catch (err) {
      if (!/Trusted Type/i.test(String(err && err.message))) throw err;
      ttPolicy = ttPolicy || trustedTypes.createPolicy("lianki-preview", { createScript: function (s) { return s; } });
      eval(ttPolicy.createScript(code));
    }
    var mine = pills();
    for (var i = 0; i < mine.length; i++) mine[i].dataset.liankiPreview = "1";
  }

  async function load(info) {
    var code = info.rev === GM_getValue("lianki_preview_rev", "") ? GM_getValue("lianki_preview_code", "") : "";
    var cached = !!code;
    var at = info.rev;
    if (!code) {
      var r = await get(BUNDLE + "?rev=" + encodeURIComponent(info.rev));
      var h = /(^|\\n)x-lianki-rev:\\s*(\\S+)/i.exec(r.responseHeaders || "");
      at = h ? h[2] : info.rev;
      code = r.responseText;
      GM_setValue("lianki_preview_code", code);
      GM_setValue("lianki_preview_rev", at);
    }
    run(code, info);
    rev = at;
    console.log(tag + " rev " + at + (cached ? " (cached)" : " from " + ORIGIN));
  }

  // The release script arriving after us (a manager can order scripts either
  // way): step aside, so the page never runs two of everything.
  function watchRelease() {
    if (typeof MutationObserver === "undefined" || !document.body) return;
    var mo = new MutationObserver(function () {
      if (stopped || decide() !== "release") return;
      stopped = true;
      mo.disconnect();
      try { if (globalThis.unload_Lianki) globalThis.unload_Lianki(); } catch (e) {}
      console.log(tag + " the release Lianki script runs here too: preview build stopped on this page");
    });
    mo.observe(document.body, { childList: true });
  }

  async function pump() {
    var backoff = 1000;
    while (!stopped) {
      try {
        var r = await get(REV + "?wait=" + encodeURIComponent(rev || ""), 35000);
        var info = JSON.parse(r.responseText);
        if (!stopped && info.rev && info.rev !== rev) await load(info);
        backoff = 1000;
      } catch (err) {
        console.warn(tag + " " + (err && err.message) + " @ " + ORIGIN + "; retrying in " + (backoff / 1000).toFixed(1) + "s");
        await sleep(backoff);
        backoff = Math.min(backoff * PHI, 60000);
      }
    }
  }

  async function start() {
    if (root.dataset.liankiPreviewLoader) {
      console.log(tag + " another preview loader is on this page: skipped");
      return;
    }
    root.dataset.liankiPreviewLoader = id;
    if (document.readyState === "loading")
      await new Promise(function (r) { document.addEventListener("DOMContentLoaded", r, { once: true }); });
    // The release script runs at document-end: give it the moment to mount its pill.
    await sleep(GRACE_MS);
    var d = decide();
    if (d !== "run") {
      console.log(tag + " not run here: " + d);
      return;
    }
    try {
      var info = JSON.parse((await get(REV, 15000)).responseText);
      if (decide() !== "run") return;
      await load(info);
    } catch (err) {
      if (/unsafe-eval|Trusted Type/i.test(String(err && err.message))) {
        console.warn(tag + " this page forbids eval: not run here");
        return;
      }
      console.warn(tag + " first load failed: " + (err && err.message));
    }
    watchRelease();
    pump();
  }

  start();
})();
`;
}

/**
 * The bundle of the served checkout, rebuilt when it changes: on request
 * (`rebuild()`, after a publish) and when src/ changes on disk. Builds are
 * serialized; a failed build keeps the last good one.
 */
export class PreviewUserscript {
  code = "";
  rev = "";
  version = "0.0.0";
  grants: string[] = [];
  error: string | null = null;
  private waiters = new Set<() => void>();
  private building: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private o: {
      root: string;
      origin: string;
      log: (m: string) => void;
      build?: (entry: string) => Promise<string>;
    },
  ) {}

  get entry(): string {
    return resolve(this.o.root, "src/lianki.user.ts");
  }

  /** Rebuild now, or once more after the build in flight. */
  rebuild(): Promise<void> {
    if (this.building) {
      this.again = true;
      return this.building;
    }
    this.building = (async () => {
      try {
        do {
          this.again = false;
          await this.buildOnce();
        } while (this.again);
      } finally {
        this.building = null;
      }
    })();
    return this.building;
  }

  /** Rebuild 200 ms after the last change under src/ (hand edits; merges come through rebuild()). */
  watch(): void {
    watch(resolve(this.o.root, "src"), { recursive: true }, (_e, file) => {
      if (file && !/\.(tsx?|js|css|json)$/.test(String(file))) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.rebuild(), 200);
    });
  }

  private async buildOnce(): Promise<void> {
    const t0 = performance.now();
    try {
      const code = await (this.o.build ?? bunBuild)(this.entry);
      const h = parseHeader(readFileSync(this.entry, "utf8"));
      const next = revOf(code);
      const changed = next !== this.rev;
      this.code = code;
      this.version = h.version;
      this.grants = h.grants;
      this.rev = next;
      this.error = null;
      const ms = Math.round(performance.now() - t0);
      this.o.log(
        changed
          ? `preview userscript → rev ${next} (v${h.version}, ${(code.length / 1024) | 0} KB, ${ms} ms)`
          : `preview userscript unchanged (${ms} ms)`,
      );
      if (changed) this.wake();
    } catch (e) {
      this.error = String((e as Error)?.message ?? e);
      this.o.log(
        `preview userscript build FAILED, keeping rev ${this.rev || "(none)"}: ${this.error}`,
      );
    }
  }

  private wake() {
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  /** Answer one of the three paths (previewScriptRoute) on a node http response. */
  async serve(
    route: PreviewRoute,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const send = (
      status: number,
      body: string,
      type: string,
      extra: Record<string, string> = {},
    ) => {
      res.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "cdn-cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...extra,
      });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const js = "text/javascript; charset=utf-8";
    if (!this.rev)
      return send(503, "preview userscript: no build yet\n", "text/plain; charset=utf-8");
    if (route === "loader")
      return send(
        200,
        renderPreviewLoader({ origin: this.o.origin, version: this.version, grants: this.grants }),
        js,
      );
    if (route === "bundle") return send(200, this.code, js, { "x-lianki-rev": this.rev });
    const wait = url.searchParams.get("wait");
    if (wait !== null && wait === this.rev) {
      if (this.waiters.size >= MAX_WAITERS)
        return send(503, "busy\n", "text/plain; charset=utf-8", { "retry-after": "5" });
      await new Promise<void>((done) => {
        const finish = () => {
          clearTimeout(t);
          this.waiters.delete(finish);
          done();
        };
        const t = setTimeout(finish, HOLD_MS);
        this.waiters.add(finish);
        res.on("close", finish);
      });
      if (res.destroyed) return;
    }
    return send(200, JSON.stringify({ rev: this.rev, version: this.version }), "application/json");
  }
}

async function bunBuild(entry: string): Promise<string> {
  const out = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "iife",
    sourcemap: "none",
  });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  return await out.outputs[0].text();
}

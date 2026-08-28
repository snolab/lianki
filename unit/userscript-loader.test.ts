import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "bun:test";

/**
 * public/loader.user.js — the install-once dev loader.
 *
 * It is hand-written rather than built from src/, because it has no
 * dependencies and a second build target would complicate the pre-commit hook.
 * That means nothing typechecks it, so these tests actually execute it against
 * stubbed GM_* APIs instead of only reading it as text.
 */
const SOURCE = readFileSync(join(process.cwd(), "public/loader.user.js"), "utf-8");
const PROD = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");

const header = SOURCE.slice(0, SOURCE.indexOf("// ==/UserScript=="));
const directive = (name: string) =>
  [...header.matchAll(new RegExp(`^//\\s*@${name}\\s+(.*)$`, "gm"))].map((m) => m[1].trim());

type Response = { status: number; responseText: string };

/**
 * Run the loader with stubs. Direct `eval` inside the loader resolves against
 * this function's scope, so the stubs land exactly where the real GM grants
 * would — which is the property being tested.
 */
function runLoader(opts: {
  response?: Response;
  networkError?: boolean;
  stored?: Record<string, string>;
}) {
  const store: Record<string, string> = { ...opts.stored };
  const errors: string[] = [];
  const infos: string[] = [];
  const menu: string[] = [];
  let requestedUrl = "";
  const globals: Record<string, unknown> = {};

  const fn = new Function(
    "window",
    "location",
    "prompt",
    "console",
    "globalThis_",
    "GM_info",
    "GM_getValue",
    "GM_setValue",
    "GM_deleteValue",
    "GM_registerMenuCommand",
    "GM_xmlhttpRequest",
    SOURCE,
  );

  fn(
    {} as unknown, // fresh window each run, so the double-run guard starts clear
    { reload: () => {} },
    () => null,
    {
      error: (...a: unknown[]) => errors.push(a.join(" ")),
      info: (...a: unknown[]) => infos.push(a.join(" ")),
      warn: () => {},
      log: () => {},
    },
    globals,
    { script: { version: "1.0.0", name: "Lianki Dev Loader" } },
    (k: string, d: string) => store[k] ?? d,
    (k: string, v: string) => {
      store[k] = v;
    },
    (k: string) => {
      delete store[k];
    },
    (label: string) => menu.push(label),
    (req: { url: string; onload: (r: Response) => void; onerror: () => void }) => {
      requestedUrl = req.url;
      if (opts.networkError) req.onerror();
      else if (opts.response) req.onload(opts.response);
    },
  );

  return { requestedUrl, errors, infos, menu, globals, store };
}

const fakeBuild = (version: string) => `// ==UserScript==
// @name        Lianki
// @version     ${version}
// ==/UserScript==
globalThis_.loadedVersion = GM_info.script.version;
globalThis_.sawGmGetValue = typeof GM_getValue === "function";
`;

describe("loader.user.js metadata", () => {
  it("does not collide with the production script", () => {
    // Same @name AND @namespace would let a manager treat this as an update to
    // the installed Lianki rather than a separate script.
    expect(directive("name")[0]).not.toBe("Lianki");
    expect(directive("namespace")[0]).not.toBe("Violentmonkey Scripts");
  });

  it("grants every GM API the loaded build relies on", () => {
    // The bundle runs inside this loader's grants, not its own header's.
    const granted = directive("grant");
    for (const api of [
      "GM_xmlhttpRequest",
      "GM_setValue",
      "GM_getValue",
      "GM_deleteValue",
      "GM_info",
    ]) {
      expect(granted).toContain(api);
    }
  });

  it("declares connect entries for both the local and tunnel sources", () => {
    const connect = directive("connect");
    expect(connect).toContain("localhost");
    expect(connect).toContain("trycloudflare.com");
  });

  it("matches everywhere and runs at document-end, like the real script", () => {
    expect(directive("match")).toEqual(["*://*/*"]);
    expect(directive("run-at")[0]).toBe(directive("run-at")[0] && "document-end");
    expect(PROD).toContain("// @run-at      document-end");
  });
});

describe("loader.user.js behaviour", () => {
  it("fetches the dev build from localhost:3002 by default", () => {
    const { requestedUrl } = runLoader({
      response: { status: 200, responseText: fakeBuild("9.9.9") },
    });
    expect(requestedUrl).toBe("http://localhost:3002/lianki.user.js");
  });

  it("honours a stored origin, for the tunnel case", () => {
    const { requestedUrl } = runLoader({
      stored: { "lkdev:origin": "https://demo.trycloudflare.com" },
      response: { status: 200, responseText: fakeBuild("9.9.9") },
    });
    expect(requestedUrl).toBe("https://demo.trycloudflare.com/lianki.user.js");
  });

  it("evaluates the build with the GM APIs in scope", () => {
    // The reason direct eval is used rather than new Function(): the bundle
    // calls GM_getValue/GM_setValue and would crash if evaluated globally.
    const { globals } = runLoader({ response: { status: 200, responseText: fakeBuild("9.9.9") } });
    expect(globals.sawGmGetValue).toBe(true);
  });

  it("reports the dev build's version, not the loader's", () => {
    // Otherwise the bundle's update check compares against the loader's 1.0.0,
    // decides it is stale, and prompts to update on every page.
    const { globals, infos } = runLoader({
      response: { status: 200, responseText: fakeBuild("2.99.0") },
    });
    expect(globals.loadedVersion).toBe("2.99.0");
    expect(infos.join(" ")).toContain("2.99.0");
  });

  it("registers a menu command for switching origin", () => {
    const { menu } = runLoader({ response: { status: 200, responseText: fakeBuild("1.0.0") } });
    expect(menu.length).toBe(1);
  });

  it("explains how to start the dev server when it is unreachable", () => {
    const { errors, globals } = runLoader({ networkError: true });
    expect(errors.join(" ")).toContain("dev:userscript");
    expect(globals.loadedVersion).toBeUndefined();
  });

  it("refuses a non-200 response without evaluating it", () => {
    const { errors, globals } = runLoader({ response: { status: 404, responseText: "nope" } });
    expect(errors.join(" ")).toContain("404");
    expect(globals.loadedVersion).toBeUndefined();
  });

  it("refuses a response that is not a userscript", () => {
    // A tunnel interstitial or error page returns HTTP 200 with HTML; eval'ing
    // that would throw a syntax error with no useful explanation.
    const { errors, globals } = runLoader({
      response: { status: 200, responseText: "<!doctype html><title>Tunnel</title>" },
    });
    expect(errors.join(" ")).toContain("did not return a userscript");
    expect(globals.loadedVersion).toBeUndefined();
  });

  it("surfaces an exception from the build instead of failing silently", () => {
    const { errors } = runLoader({
      response: {
        status: 200,
        responseText: `// ==UserScript==\n// @version 1.2.3\n// ==/UserScript==\nthrow new Error("boom");`,
      },
    });
    expect(errors.join(" ")).toContain("threw while evaluating");
  });
});

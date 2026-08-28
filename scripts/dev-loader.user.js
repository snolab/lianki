// ==UserScript==
// @name        [dev] Lianki @dev
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_info
// @version     __VERSION__
// @author      lianki.com
// @description Lianki dev loader — install once; the build is pushed from your dev server over a long poll.
// @run-at      document-start
// __CONNECT__
// @downloadURL __ORIGIN__/loader.user.js
// @updateURL   __ORIGIN__/loader.user.js
// ==/UserScript==

// SERVED, NOT INSTALLED FROM DISK. This is a template: the placeholders in the
// header and the two consts below are filled in per request by
// `scripts/dev-userscript-server.ts`, so installing this file raw does nothing
// useful. (Keep placeholder tokens out of prose here — substitution is a plain
// string replace and would rewrite them mid-sentence.)
//
// The @name/@namespace pair deliberately matches the loader already installed
// in the fleet, so serving this replaces that install rather than sitting
// alongside it — two loaders on one page means two of every handler. It still
// differs from the production script's pair ("Lianki"), which is what keeps a
// manager from treating it as an update to the real userscript.
//
// Design notes and the reasoning behind each rule below:
// docs/dev-userscript-loader.md

(function () {
  // The bundle no-ops in subframes anyway (its entry checks window.self ===
  // window.top), so without this every iframe still downloads and evals the
  // whole build.
  if (window.self !== window.top) return;

  const ORIGIN = "__ORIGIN__"; // dev server (tunnel) — bundles, long poll, error sink
  const APP_ORIGIN = "__APP_ORIGIN__"; // what the BUNDLE talks to for the API
  const VERSION = "__VERSION__";
  const PHI = 1.618;
  let rev = null;
  let backoff = 1000;
  let ttPolicy = null;
  let blocked = false;

  // Captured before load() shadows GM_info for the evaluated bundle.
  const loaderInfo = typeof GM_info !== "undefined" ? GM_info : undefined;

  // Stable per-browser id so the dev server can report who is attached.
  //
  // Deliberately NOT under the lk: prefix: with keys like lk:dev-id, ScriptCat
  // handed back Mongo ObjectIds belonging to real Lianki notes (lk:c:<id>), so
  // every page load registered as a brand-new client. Own namespace, no overlap.
  let CID = GM_getValue("lianki_devclient_id", "");
  if (!CID) GM_setValue("lianki_devclient_id", (CID = Math.random().toString(36).slice(2, 8)));

  // Surface failures on the server instead of leaving them in a console nobody
  // is reading — the whole point when the browser is a phone.
  let reporting = false;
  let reportsThisMinute = 0;
  setInterval(() => (reportsThisMinute = 0), 60000);

  const report = (what, detail) => {
    // Re-entrancy guard: report() is reachable from the console.error hook
    // below, and anything logging an error while reporting would loop forever.
    // Rate cap keeps a repeating per-frame failure from flooding the server.
    if (reporting || reportsThisMinute >= 30) return;
    reporting = true;
    reportsThisMinute++;
    try {
      GM_xmlhttpRequest({
        method: "POST",
        url: ORIGIN + "/error?id=" + CID,
        data: JSON.stringify({
          what,
          detail: String(detail).slice(0, 4000),
          page: location.href,
        }),
      });
    } catch (e) {
    } finally {
      reporting = false;
    }
  };

  // Forward the script's OWN console.error to the dev server.
  //
  // window.onerror only ever sees *uncaught* throws. The failures that actually
  // get reported by hand — "Login required (got: <html>…)", failed syncs — are
  // caught inside the userscript and logged, so they never reach the server and
  // the dev log looks clean while the script is visibly broken. Filtered to our
  // own prefixes: these pages also run uBlock, Grammarly and the site itself,
  // and forwarding everything would be a firehose.
  const origError = console.error.bind(console);
  console.error = (...args) => {
    try {
      const msg = args.map((a) => (a && a.stack) || String(a)).join(" ");
      if (/\[Lianki\]|\[lianki dev/.test(msg)) report("console.error", msg);
    } catch (e) {}
    origError(...args);
  };
  window.addEventListener("unhandledrejection", (e) =>
    report("unhandledrejection", (e.reason && e.reason.stack) || e.reason),
  );

  // Benign browser noise that is not anyone's bug. ResizeObserver in particular
  // fires constantly on YouTube and carries no filename, so the filename guard
  // cannot catch it.
  const BENIGN = /ResizeObserver loop|Script error\.?$|NotAllowedError: play\(\)/i;
  window.addEventListener("error", (e) => {
    if (e.filename && e.filename !== location.href) return; // page's own scripts
    // No filename means we cannot attribute it. Forward only if it names us —
    // otherwise every framework hiccup on the page lands in the dev log.
    if (!e.filename && !/\[Lianki\]|\[lianki dev/.test(String(e.message))) return;
    if (BENIGN.test(String(e.message))) return;
    report("runtime", e.message + " @ " + e.lineno + ":" + e.colno);
  });

  const get = (path) =>
    new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: ORIGIN + path,
        timeout: 35000, // > the server's 30s long-poll hold
        onload: (r) =>
          r.status >= 200 && r.status < 300
            ? resolve(r.responseText)
            : reject(new Error("HTTP " + r.status)),
        onerror: () => reject(new Error("network")),
        ontimeout: () => reject(new Error("timeout")),
      });
    });

  async function load(next) {
    // Serve an unchanged bundle out of GM storage. Every navigation starts a
    // fresh loader with no in-memory rev, so without this each page load pulls
    // the whole build again just to run identical code.
    let code =
      next === GM_getValue("lianki_devbundle_rev", "")
        ? GM_getValue("lianki_devbundle_code", "")
        : "";
    const cached = !!code;
    if (!code) {
      code = await get("/bundle.js?id=" + CID + "&rev=" + next);
      GM_setValue("lianki_devbundle_code", code);
      GM_setValue("lianki_devbundle_rev", next);
    }

    // The bundle is written for @run-at document-end — main() appendChilds to
    // document.body. The loader deliberately starts earlier, so hold the eval
    // until the DOM it expects actually exists.
    if (document.readyState === "loading")
      await new Promise((r) => document.addEventListener("DOMContentLoaded", r, { once: true }));

    // Shadow GM_info for the eval below. Two things depend on it:
    //   version      — the bundle compares it against the server's
    //                  x-lianki-version and prompts to update when stale. Left
    //                  as the loader's own, it would prompt on every page.
    //   downloadURL  — the bundle derives its API origin from this. Left
    //                  pointing at the dev server, every API call would hit the
    //                  tunnel instead of the app.
    // eslint-disable-next-line no-unused-vars -- read by the eval'd bundle
    const GM_info = {
      ...loaderInfo,
      script: {
        ...(loaderInfo && loaderInfo.script),
        version: VERSION,
        downloadURL: APP_ORIGIN + "/lianki.user.js",
        updateURL: APP_ORIGIN + "/lianki.meta.js",
      },
    };

    try {
      // Direct eval on purpose: it inherits this function's scope chain, which
      // is where the manager binds GM_* (and the GM_info shadow above).
      // new Function() or indirect eval — (0,eval) — evaluate at realm global
      // scope instead, where those bindings may not be reachable, and the
      // bundle would die on its first GM_getValue.
      //
      // Plain string first. Under ScriptCat the userscript shares the page's
      // realm, so a document sending require-trusted-types-for 'script'
      // (YouTube does) refuses string-to-code conversion and eval throws
      // EvalError. Only then retry through a TrustedScript — doing it up front
      // would break every other site, because where Trusted Types are NOT
      // enforced eval of a non-string returns the object unevaluated instead of
      // running it.
      try {
        eval(code);
      } catch (err) {
        if (!/Trusted Type/i.test(String(err && err.message))) throw err;
        // The retry is allowed only where the page sets no trusted-types
        // allowlist directive, so any policy name is accepted. Where one IS
        // set (translate.google.com), createPolicy throws — and letting that
        // reach the outer catch meant backing off and re-reporting the same
        // wall on every cycle, forever. Observed in the wild; treat a failed
        // retry as terminal for this page, like a missing 'unsafe-eval'.
        try {
          ttPolicy =
            ttPolicy || trustedTypes.createPolicy("lianki-dev", { createScript: (s) => s });
          eval(ttPolicy.createScript(code));
        } catch (ttErr) {
          blocked = true;
          report(
            "tt-blocked",
            "Trusted Types retry failed: " + (ttErr && ttErr.message) + " | first: " + err.message,
          );
          console.warn(
            "[lianki dev " +
              CID +
              "] this page's Trusted Types policy forbids eval — loader disabled here",
          );
          return;
        }
        console.log("[lianki dev " + CID + "] evaluated via TrustedScript policy");
      }
    } catch (err) {
      // A page whose CSP omits 'unsafe-eval' (translate.google.com) can never
      // run this loader — retrying is pure noise, so stop for this page instead
      // of backing off forever and reporting the same wall on every attempt.
      if (/unsafe-eval/.test(String(err && err.message))) {
        blocked = true;
        report("eval-blocked", "CSP has no 'unsafe-eval'; dev loader cannot run here");
        console.warn(
          "[lianki dev " + CID + "] this page's CSP forbids eval — loader disabled here",
        );
        return;
      }
      report("eval", err && err.stack ? err.stack : err);
      throw err;
    }
    // Advanced only on success. Setting it before the eval meant a failed eval
    // still marked the rev as current, so the next long poll matched, parked,
    // and the page never retried — one bad eval wedged that tab until reload.
    rev = next;
    console.log(
      "[lianki dev " + CID + "] loaded rev " + next + (cached ? " (cached)" : " from " + ORIGIN),
    );
  }

  async function pump() {
    while (!blocked) {
      try {
        // Long poll, not an interval: the server holds the request open until
        // the bundle actually changes, so a rebuild lands immediately and an
        // idle session costs one parked connection instead of a poll storm.
        const next = await get("/wait?id=" + CID + "&rev=" + (rev ?? ""));
        if (next !== rev) await load(next);
        backoff = 1000;
      } catch (err) {
        // Dev server down or tunnel recycled — golden-ratio backoff, capped.
        // Name the origin: with more than one dev loader ever installed,
        // "network" alone cannot tell you WHICH tunnel died, and a stale
        // install from an old tunnel retries forever looking exactly like a
        // live one failing.
        console.warn(
          "[lianki dev " +
            CID +
            "] " +
            err.message +
            " @ " +
            ORIGIN +
            "; retrying in " +
            (backoff / 1000).toFixed(1) +
            "s",
        );
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * PHI, 60000);
      }
    }
  }

  console.log("[lianki dev " + CID + "] loader online on " + location.hostname + " → " + ORIGIN);
  pump();
})();

/// <reference types="bun" />
/**
 * CSP-proof live-reload server for the userscript.
 *
 * Why this exists alongside vite-plugin-monkey: that plugin develops by injecting
 * `<script src="http://<dev-host>/…">` into the page, which the page's own CSP
 * gets to veto. YouTube — the main thing this script is built for — sends
 * `script-src` with an explicit host allowlist (no wildcard) plus 'strict-dynamic',
 * so a tunnel-hosted module is blocked outright. Verified against a live watch
 * page, not assumed.
 *
 * So this mode never touches the page. A tiny installed loader pulls the bundle
 * over GM_xmlhttpRequest — the extension's own network stack, which page CSP has
 * no say over — and evaluates it inside the userscript sandbox. That also means
 * the code under test sees the *real* GM_* APIs rather than shims mounted onto
 * window, so dev behaves like production.
 *
 * Reloading is free because the script already supports it: src/lianki.user.ts
 * ends `main()` with an AbortController-backed unload fn and its entry does
 * `globalThis.unload_Lianki?.()` before starting. Re-evaluating the bundle tears
 * the previous instance down cleanly.
 */
import { watch } from "fs";
import { formatMetaBlock, parseUserscriptMeta, withoutAutoUpdate } from "./userscript-meta";

const ENTRY = "src/lianki.user.ts";
/** Rebuild when anything here changes — the bundle inlines @lianki/core too. */
const WATCH_DIRS = ["src", "packages/core/src"];
const DEBOUNCE_MS = 120;
/** Cap a long-poll below Cloudflare's ~100 s idle limit and any proxy timeout. */
const LONGPOLL_MS = 25_000;

let bundle = "";
let rev = "0";
let waiters: (() => void)[] = [];

// ── Connection visibility ────────────────────────────────────────────────────
// Without this the server is silent and "did my browser attach?" is unanswerable
// except by guessing. Each installed loader mints a stable id (persisted in GM
// storage) and sends it on every call, so a parked long-poll is a live browser.

type Client = { id: string; ip: string; ua: string; rev: string; since: number; lastSeen: number };
const clients = new Map<string, Client>();

const shortUA = (ua: string) =>
  ua.match(/(Firefox|Edg|OPR|Chrome|Safari)\/[\d.]+/)?.[0].replace(/\.\d+$/, "") ?? "unknown";

const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (msg: string) => console.log(`[${stamp()}] ${msg}`);

/**
 * Liveness is derived from recency, not from a flag set when a poll parks: a
 * browser that closes mid-long-poll never sends anything again, so a stored
 * "waiting" bit would report it as attached forever. Two long-poll windows of
 * slack covers a normal re-poll plus one missed round trip.
 */
const isLive = (c: Client) => Date.now() - c.lastSeen < LONGPOLL_MS * 2;
const liveCount = () => [...clients.values()].filter(isLive).length;

function touch(req: Request, url: URL): Client | undefined {
  const id = url.searchParams.get("id");
  if (!id) return undefined;
  const existing = clients.get(id);
  if (existing) {
    const wasLive = isLive(existing);
    existing.lastSeen = Date.now();
    if (!wasLive) log(`⇄ client ${id} RECONNECTED · ${liveCount()} live`);
    return existing;
  }
  const client: Client = {
    id,
    ip: req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "local",
    ua: shortUA(req.headers.get("user-agent") ?? ""),
    rev: "",
    since: Date.now(),
    lastSeen: Date.now(),
  };
  clients.set(id, client);
  log(`✓ client ${id} ATTACHED — ${client.ua} @ ${client.ip} · ${liveCount()} live`);
  return client;
}

async function rebuild(): Promise<void> {
  const out = await Bun.build({
    entrypoints: [ENTRY],
    format: "iife",
    target: "browser",
    // Matches the release build (userbuild): readable output, no minification,
    // so stack traces in the console point at real identifiers.
    minify: false,
  });
  if (!out.success) {
    console.error("[lianki dev] build failed:\n" + out.logs.join("\n"));
    return; // keep serving the last good bundle
  }
  const next = await out.outputs[0].text();
  const nextRev = Bun.hash(next).toString(36);
  if (nextRev === rev) {
    // Comment-only edits bundle to identical bytes; say so rather than leaving
    // a "why didn't my change show up?" silence.
    log(`· rebuilt, output unchanged (rev ${rev}) — no push`);
    return;
  }
  bundle = next;
  rev = nextRev;
  const pending = waiters;
  waiters = [];
  for (const release of pending) release();
  log(
    `⟳ rebuilt → rev ${rev} (${(bundle.length / 1024) | 0} KB) · pushed to ${pending.length} waiting client(s)`,
  );
}

/**
 * The installed shim. Fetches + evals; never inserts a script into the page.
 *
 * Two-pass: the body is built first, then hashed into the @version. The shim
 * cannot hot-reload itself the way the bundle does — it is what does the
 * reloading — so without a version that moves when the body moves, every change
 * to it costs a manual reinstall. Hashing makes the manager notice.
 */
function loaderScript(origin: string): string {
  const body = loaderBody(origin);
  const meta = withoutAutoUpdate(parseUserscriptMeta(ENTRY));
  const header = formatMetaBlock({
    ...loaderMeta(origin, meta),
    version: `${meta.version}-dev.${Bun.hash(body).toString(36).slice(0, 6)}`,
  });
  return `${header}\n${body}`;
}

function loaderMeta(origin: string, meta: ReturnType<typeof parseUserscriptMeta>) {
  return {
    ...meta,
    // Tunnel host in the name so a stale install from a previous (dead) tunnel
    // is obvious in the manager's list instead of being an identical-looking twin.
    name: `[dev] ${meta.name} @${new URL(origin).hostname.split(".")[0]}`,
    version: `${meta.version}-dev`,
    // GM_xmlhttpRequest is origin-gated by @connect, so the dev host must be
    // listed or every fetch prompts the user.
    connect: [...((meta.connect as string[]) ?? []), new URL(origin).hostname],
    // @grant is inherited from the real header; the loader needs nothing extra
    // beyond GM_xmlhttpRequest, which the script already requires.
    //
    // document-start so the fetch overlaps page parse instead of queuing behind
    // it — but the *eval* is gated on DOMContentLoaded below. The bundle is
    // authored for document-end and appendChilds to document.body during main(),
    // so evaluating it at document-start throws on a null body. That turns into
    // a race the page decides: zhihu's small <head> means body exists by the
    // time the fetch lands, YouTube's huge one means it does not.
    "run-at": "document-start",
    // Point auto-update at the DEV server. withoutAutoUpdate() stripped the
    // production URLs so Tampermonkey could not swap in the released script —
    // but with a stable hostname, aiming them here instead means loader changes
    // install themselves rather than costing a manual reinstall each time.
    downloadURL: `${origin}/loader.user.js`,
    updateURL: `${origin}/loader.user.js`,
  };
}

/**
 * The installed shim's body.
 *
 * Deliberately NOT "use strict": with direct eval the evaluated bundle inherits
 * the caller's strictness, and the released script is evaluated sloppy-mode by
 * the manager. Matching that keeps dev honest.
 */
function loaderBody(origin: string): string {
  return `(function () {
  // The bundle no-ops in subframes anyway (its entry checks window.self ===
  // window.top), so without this every iframe still downloads and evals 121 KB.
  if (window.self !== window.top) return;

  const ORIGIN = ${JSON.stringify(origin)};
  const PHI = 1.618;
  let rev = null;
  let backoff = 1000;
  let ttPolicy = null;
  let blocked = false;

  // Stable per-browser id so the dev server can report who is attached.
  //
  // Deliberately NOT under the lk: prefix: with keys like lk:dev-id, ScriptCat
  // handed back Mongo ObjectIds belonging to real Lianki notes (lk:c:<id>), so
  // every page load registered as a brand-new client. Own namespace, no overlap.
  let CID = GM_getValue("lianki_devclient_id", "");
  if (!CID) GM_setValue("lianki_devclient_id", (CID = Math.random().toString(36).slice(2, 8)));

  // Surface failures on the server instead of leaving them in a console nobody
  // is reading. Not having this is why the document-start bug took a bug report
  // rather than showing up in the log the moment it happened.
  let reporting = false;
  let reportsThisMinute = 0;
  setInterval(() => (reportsThisMinute = 0), 60000);

  const report = (what, detail) => {
    // Re-entrancy guard: report() is called from a console.error hook below, and
    // anything logging an error while reporting would otherwise loop forever.
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
  // caught inside the userscript and logged, so they never reached the server and
  // the dev log looked clean while the script was visibly broken. Filtered to our
  // own prefixes: these pages also run uBlock, Grammarly and YouTube itself, and
  // forwarding everything would be a firehose.
  const origError = console.error.bind(console);
  console.error = (...args) => {
    try {
      const msg = args.map((a) => (a && a.stack) || String(a)).join(" ");
      if (/\\[Lianki\\]|\\[lianki dev/.test(msg)) report("console.error", msg);
    } catch (e) {}
    origError(...args);
  };
  window.addEventListener("unhandledrejection", (e) =>
    report("unhandledrejection", (e.reason && e.reason.stack) || e.reason),
  );

  const get = (path) =>
    new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: ORIGIN + path,
        timeout: ${LONGPOLL_MS + 10_000},
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error("HTTP " + r.status))),
        onerror: () => reject(new Error("network")),
        ontimeout: () => reject(new Error("timeout")),
      });
    });

  async function load(next) {
    // Serve an unchanged bundle out of GM storage. Every navigation starts a
    // fresh loader with no in-memory rev, so without this each page load pulled
    // the full 121 KB again just to run identical code.
    let code = next === GM_getValue("lianki_devbundle_rev", "") ? GM_getValue("lianki_devbundle_code", "") : "";
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

    try {
      // Direct eval on purpose: it inherits this function's scope chain, which
      // is where the manager binds GM_*. new Function() or indirect eval —
      // (0,eval) — evaluate at realm global scope instead, where those bindings
      // may not be reachable, and the bundle would die on its first GM_getValue.
      //
      // Plain string first. Under ScriptCat the userscript shares the page's
      // realm, so a document sending require-trusted-types-for 'script' (YouTube
      // does) refuses string-to-code conversion and eval throws EvalError. Only
      // then retry through a TrustedScript — doing it up front would break every
      // other site, because where Trusted Types are NOT enforced eval of a
      // non-string returns the object unevaluated instead of running it.
      try {
        eval(code);
      } catch (err) {
        if (!/Trusted Type/i.test(String(err && err.message))) throw err;
        // Allowed because the page sets no trusted-types allowlist directive, so
        // any policy name is accepted. If a site ever restricts names this
        // throws and the outer catch reports it rather than failing silently.
        ttPolicy =
          ttPolicy || trustedTypes.createPolicy("lianki-dev", { createScript: (s) => s });
        eval(ttPolicy.createScript(code));
        console.log("[lianki dev " + CID + "] evaluated via TrustedScript policy");
      }
    } catch (err) {
      // A page whose CSP omits 'unsafe-eval' (translate.google.com) can never run
      // this loader — retrying is pure noise, so stop for this page instead of
      // backing off forever and reporting the same wall on every attempt.
      if (/unsafe-eval/.test(String(err && err.message))) {
        blocked = true;
        report("eval-blocked", "CSP has no 'unsafe-eval'; dev loader cannot run here");
        console.warn("[lianki dev " + CID + "] this page's CSP forbids eval — loader disabled here");
        return;
      }
      report("eval", err && err.stack ? err.stack : err);
      throw err;
    }
    // Advanced only on success. Setting it before the eval meant a failed eval
    // still marked the rev as current, so the next long-poll matched, parked,
    // and the page never retried — one bad eval wedged that tab until reload.
    rev = next;
    console.log(
      "[lianki dev " + CID + "] loaded rev " + next + (cached ? " (from cache)" : " from " + ORIGIN),
    );
  }

  console.log("[lianki dev " + CID + "] loader online on " + location.hostname);
  // Async throws from inside the script land here rather than vanishing.
  // Benign browser noise that is not anyone's bug. ResizeObserver in particular
  // fires constantly on YouTube and carries no filename, so the filename guard
  // below cannot catch it.
  const BENIGN = /ResizeObserver loop|Script error\\.?$|NotAllowedError: play\\(\\)/i;
  window.addEventListener("error", (e) => {
    if (e.filename && e.filename !== location.href) return; // page's own errors
    // No filename means we cannot attribute it. Forward only if it names us —
    // otherwise every framework hiccup on the page lands in the dev log.
    if (!e.filename && !/\\[Lianki\\]|\\[lianki dev/.test(String(e.message))) return;
    if (BENIGN.test(String(e.message))) return;
    report("runtime", e.message + " @ " + e.lineno + ":" + e.colno);
  });

  async function pump() {
    while (!blocked) {
      try {
        // Long-poll, not an interval: the server holds the request open until
        // the bundle actually changes, so a rebuild lands immediately and an
        // idle session costs one parked connection instead of a poll storm.
        const next = await get("/wait?id=" + CID + "&rev=" + (rev ?? ""));
        if (next !== rev) await load(next);
        backoff = 1000;
      } catch (err) {
        // Dev server down or tunnel recycled — golden-ratio backoff, capped.
        // Name the origin: with more than one dev loader ever installed, "network"
        // alone cannot tell you WHICH tunnel died, and a stale install from an
        // old tunnel retries forever looking exactly like a live one failing.
        console.warn(
          "[lianki dev " + CID + "] " + err.message + " @ " + ORIGIN +
            "; retrying in " + (backoff / 1000).toFixed(1) + "s",
        );
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * PHI, 60000);
      }
    }
  }

  pump();
})();
`;
}

// no-store on everything: a proxied Cloudflare hostname puts CF's cache in front
// of this server, and .js is cacheable by default — so the loader and the bundle
// were being served from cache (observed cf-cache-status: HIT, age 4255) and a
// hot reload could silently hand back yesterday's code.
const CORS = { "access-control-allow-origin": "*", "cache-control": "no-store, max-age=0" };
const js = { "content-type": "text/javascript; charset=utf-8", ...CORS };

export async function startLoaderServer(port: number, origin: string) {
  await rebuild();

  let timer: ReturnType<typeof setTimeout> | undefined;
  for (const dir of WATCH_DIRS) {
    watch(dir, { recursive: true }, (_e, file) => {
      if (file && !/\.(ts|js|mjs)$/.test(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void rebuild(), DEBOUNCE_MS);
    });
  }

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 0, // long-polls must not be cut short
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname, searchParams } = url;
      const client = touch(req, url);

      if (pathname === "/loader.user.js") {
        const ip = req.headers.get("cf-connecting-ip") ?? "local";
        log(
          `↓ loader.user.js downloaded by ${ip} (${shortUA(req.headers.get("user-agent") ?? "")})`,
        );
        return new Response(loaderScript(origin), { headers: js });
      }

      if (pathname === "/bundle.js") {
        log(
          `↑ bundle.js → client ${client?.id ?? "anon"} (rev ${rev}, ${(bundle.length / 1024) | 0} KB)`,
        );
        if (client) client.rev = rev;
        return new Response(bundle, { headers: js });
      }

      if (pathname === "/rev") return new Response(rev, { headers: CORS });

      if (pathname === "/error" && req.method === "POST") {
        const raw = await req.text().catch(() => "");
        let e: { what?: string; detail?: string; page?: string } = {};
        try {
          e = JSON.parse(raw);
        } catch {
          e = { detail: raw };
        }
        log(`✗ client ${client?.id ?? "anon"} ${e.what ?? "error"} on ${e.page ?? "?"}`);
        for (const line of String(e.detail ?? "")
          .split("\n")
          .slice(0, 12))
          console.log(`      ${line}`);
        return new Response("ok", { headers: CORS });
      }

      if (pathname === "/status")
        return Response.json(
          {
            rev,
            bundleBytes: bundle.length,
            origin,
            clients: [...clients.values()].map((c) => ({
              ...c,
              live: isLive(c),
              attachedFor: `${Math.round((Date.now() - c.since) / 1000)}s`,
            })),
          },
          { headers: CORS },
        );

      // Long-poll: return at once if the caller is behind, else park until the
      // next rebuild (or fall through on timeout so the connection recycles).
      if (pathname === "/wait") {
        if (searchParams.get("rev") !== rev) return new Response(rev, { headers: CORS });
        await new Promise<void>((resolve) => {
          const release = () => {
            clearTimeout(t);
            resolve();
          };
          const t = setTimeout(() => {
            waiters = waiters.filter((w) => w !== release);
            resolve();
          }, LONGPOLL_MS);
          waiters.push(release);
        });
        return new Response(rev, { headers: CORS });
      }

      const rows =
        [...clients.values()]
          .map(
            (c) =>
              `<li><code>${c.id}</code> — ${c.ua} @ ${c.ip} — ${isLive(c) ? "<b>live</b>" : "idle"}, rev <code>${c.rev || "—"}</code></li>`,
          )
          .join("") || "<li><i>nothing attached yet</i></li>";
      return new Response(
        `<!doctype html><meta charset=utf-8><title>Lianki dev</title>
         <h1>Lianki userscript — live dev</h1>
         <p><a href="${origin}/loader.user.js">Install the dev loader</a> — current rev <code>${rev}</code></p>
         <h2>Attached browsers</h2><ul>${rows}</ul>
         <p><a href="/status">/status</a> (JSON)</p>`,
        { headers: { "content-type": "text/html; charset=utf-8", ...CORS } },
      );
    },
  });
  return server;
}

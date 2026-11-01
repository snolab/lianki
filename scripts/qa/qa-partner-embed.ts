#!/usr/bin/env bun
/**
 * The Learning Partner on a hostile page, in a real (muted, silenced) Chromium
 * (docs/dev-debug-widget.md, "On every site"). Builds the partner's script,
 * serves two fixture pages and a fake hub, mounts the partner the way the
 * userscript does, and checks:
 *
 * 1. Isolation in: the page's `* { all: unset !important }`, a 40px html
 *    font-size, an odd font-family (also squatting "-apple-system" and
 *    "Segoe UI" with @font-face) change nothing inside the chat: system-ui, px.
 * 2. Isolation out: the document has no new stylesheet, <style> or adopted
 *    sheet, and the page's own text keeps its own font.
 * 3. Keys: typed in the chat, the page's aggressive keydown listener
 *    (preventDefault on everything) sees none of them and the text arrives;
 *    typed on the page, the page still gets every key.
 * 4. The socket: the ticket only in Sec-WebSocket-Protocol, never in the URL;
 *    history and a typed line go both ways.
 * 5. CSP: on a page whose connect-src blocks the hub, the note shows instead,
 *    and the page is not broken (its own script still runs).
 *
 *   bun scripts/qa/qa-partner-embed.ts [--shots <dir>]
 *
 * Silent: no audio, no mic (the embedded chat has none), muted browser.
 */
import { chromium } from "playwright";
import { buildPartner } from "../build-partner-embed";
import { launchSilent, newSilentContext } from "./silent.mjs";

const shotsAt = Bun.argv.indexOf("--shots");
const SHOTS = shotsAt > -1 ? Bun.argv[shotsAt + 1] : "";

const HOSTILE_CSS = `
@font-face { font-family: "-apple-system"; src: local("Courier New"); }
@font-face { font-family: "Segoe UI"; src: local("Courier New"); }
* { all: unset !important; }
html { font-size: 40px !important; }
* { font-family: "Comic Sans MS", Papyrus, fantasy !important; color: oklch(0.6 0.25 330) !important; line-height: 3 !important; }
html > div { display: none !important; transform: scale(3) !important; }
p { display: block !important; }
`;

const page = (csp: string) => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>hostile</title><style>${HOSTILE_CSS}</style></head><body>
<p id="own">The page's own text.</p>
<input id="pageInput" aria-label="page input">
<script>
  window.__pageKeys = [];
  window.__pageWindowCapture = [];
  // Aggressive: every keydown on the document is "a shortcut", and swallowed.
  document.addEventListener("keydown", (e) => { window.__pageKeys.push(e.key); e.preventDefault(); });
  window.addEventListener("keypress", (e) => window.__pageKeys.push("press:" + e.key));
  window.addEventListener("keydown", (e) => window.__pageWindowCapture.push(e.key), true);
  window.__pageAlive = true;
  window.__pageMessages = [];
  window.addEventListener("message", (e) => window.__pageMessages.push(e.data), true);
  // Squat every tag we might use: whoever upgrades one grabs its internals,
  // whose shadowRoot is the closed root (P1 from the PR #403 review).
  window.__stolen = [];
  for (const tag of ["lianki-partner", "lianki-host", "lk-partner", "lianki-chat"]) {
    customElements.define(tag, class extends HTMLElement {
      constructor() { super(); window.__stolen.push(this.attachInternals()); }
    });
  }
</script>
${csp ? `<p id="csp">${csp}</p>` : ""}
</body></html>`;

const fail: string[] = [];
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) fail.push(what);
};

const built = await buildPartner();
// The userscript's frame shell and the frame's guest protocol, as plain scripts for the fixtures.
const QA_DIR = new URL(".", import.meta.url).pathname;
const bundle = (entry: string) =>
  Bun.build({
    entrypoints: [`${QA_DIR}${entry}`],
    target: "browser",
    format: "iife",
    minify: true,
  }).then((o) => o.outputs[0].text());
const shellJs = await bundle("partner-frame-fixture-shell.ts");
const guestJs = await bundle("partner-frame-fixture-guest.ts");
const hubSeen: { url: string; protocol: string | null; messages: string[] }[] = [];

type HubConn = { url: string; protocol: string | null; messages: string[] };
const server = Bun.serve<HubConn, never>({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/api/version/debug") {
      const protocol = req.headers.get("sec-websocket-protocol");
      const entry = { url: req.url, protocol, messages: [] as string[] };
      hubSeen.push(entry);
      if (!protocol?.startsWith("lianki-partner,"))
        return new Response("forbidden", { status: 403 });
      const ok = srv.upgrade(req, {
        headers: { "Sec-WebSocket-Protocol": "lianki-partner" },
        data: entry,
      });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/hostile")
      return new Response(page(""), { headers: { "content-type": "text/html; charset=utf-8" } });
    // The frame: a stand-in for the app origin's /embed/partner with the real guest protocol.
    if (url.pathname === "/embed/partner")
      return new Response(
        `<!doctype html><meta charset=utf-8><body style="margin:0;background:oklch(0.97 0.01 82)"><textarea id=t aria-label=chat></textarea><script>${guestJs}</script>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    if (url.pathname === "/shell.js")
      return new Response(shellJs, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/frame-allowed")
      return new Response(page(""), { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/frame-blocked")
      return new Response(page("frame-src 'self'"), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self' ws://localhost:* http://localhost:*",
        },
      });
    if (url.pathname === "/hostile-csp")
      return new Response(page("connect-src 'self'"), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          // Our QA harness itself runs as inline script / eval in the page;
          // the policy that matters here is connect-src and style-src.
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'",
        },
      });
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "me", sender: { id: "h1", name: "Owner" } }));
      ws.send(JSON.stringify({ type: "state", pending: null, sessions: [], listeners: 1 }));
      ws.send(
        JSON.stringify({
          type: "history",
          messages: [
            { id: "h1", from: "agent", label: "agent", text: "Hello from the hub", at: Date.now() },
          ],
        }),
      );
    },
    message(ws, m) {
      ws.data.messages.push(String(m));
    },
  },
});
// The page on 127.0.0.1, the "app" on localhost: another origin, as lianki.com is to github.com.
const PAGE = `http://127.0.0.1:${server.port}`;
const APP = `http://localhost:${server.port}`;

const browser = await launchSilent(chromium);
try {
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await newSilentContext(browser, {
      viewport: { width: 390, height: 780 },
      colorScheme: scheme,
    });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${PAGE}/hostile`);
    const before = await p.evaluate(() => ({
      sheets: document.styleSheets.length,
      styles: document.querySelectorAll("style").length,
      adopted: document.adoptedStyleSheets.length,
      ownFont: getComputedStyle(document.getElementById("own")!).fontFamily,
    }));
    await p.evaluate(
      ({ code, app }) => {
        const f = (0, eval)(code);
        const b = f(null);
        (window as unknown as { __m: unknown }).__m = b.api.mountPartner({
          doc: document,
          css: b.css,
          appOrigin: app,
          ticket: async () => "TICKET-abc.def",
          WebSocket,
          hide() {},
        });
      },
      { code: built.code, app: APP },
    );
    // The chat renders, with the hub's history.
    await p.waitForFunction(
      () => {
        const m = (window as unknown as { __m: { root: ShadowRoot } }).__m;
        return m.root.textContent?.includes("Hello from the hub");
      },
      undefined,
      { timeout: 10_000 },
    );
    const inside = await p.evaluate(() => {
      const m = (window as unknown as { __m: { root: ShadowRoot } }).__m;
      const host = m.root.host as HTMLElement;
      const input = m.root.querySelector('[data-testid="debug-chat-input"]') as HTMLElement;
      const container = m.root.querySelector(".lk-partner-root") as HTMLElement;
      const cs = getComputedStyle(input);
      const box = input.getBoundingClientRect();
      return {
        closed: host.shadowRoot === null,
        hostDisplay: getComputedStyle(host).display,
        hostTransform: getComputedStyle(host).transform,
        rootFont: getComputedStyle(container).fontFamily,
        rootSize: getComputedStyle(container).fontSize,
        inputFont: cs.fontFamily,
        inputSize: cs.fontSize,
        inputVisible: box.width > 40 && box.height > 10 && box.bottom <= innerHeight,
        inputBox: `${Math.round(box.width)}x${Math.round(box.height)} @${Math.round(box.left)},${Math.round(box.top)}; root ${Math.round((m.root.querySelector("[data-debug-chat]") as HTMLElement)?.getBoundingClientRect().width ?? -1)}w open=${(m.root.querySelector("[data-debug-chat]") as HTMLElement)?.dataset.open ?? "?"}`,
        sheets: document.styleSheets.length,
        styles: document.querySelectorAll("style").length,
        adopted: document.adoptedStyleSheets.length,
        ownFont: getComputedStyle(document.getElementById("own")!).fontFamily,
        hostAttrs: [...host.attributes].map((a) => a.name),
        hostTag: host.localName,
        stolenRoots: (window as unknown as { __stolen: ElementInternals[] }).__stolen.filter(
          (i) => i.shadowRoot,
        ).length,
        stolen: (window as unknown as { __stolen: ElementInternals[] }).__stolen.length,
      };
    });
    const tag = `[${scheme}]`;
    check(inside.closed, `${tag} the shadow root is closed (host.shadowRoot is null)`);
    check(
      inside.hostTag === "div" && inside.stolen === 0 && inside.stolenRoots === 0,
      `${tag} the host is a plain div: the page's predefined custom tags never upgrade it, no ElementInternals reach the root`,
    );
    // Control: the squat is a real attack on a custom-tag host (what the old code used).
    const control = await p.evaluate(() => {
      const el = document.createElement("lianki-partner");
      el.attachShadow({ mode: "closed" }).append("secret");
      const s = (window as unknown as { __stolen: ElementInternals[] }).__stolen;
      return s.at(-1)?.shadowRoot?.textContent ?? null;
    });
    check(control === "secret", `${tag} control: a custom-tag host WOULD leak its closed root`);
    check(
      inside.hostDisplay === "block" && inside.hostTransform === "none",
      `${tag} the page's rules on the host lose to its inline !important`,
    );
    check(
      inside.rootFont.startsWith("system-ui"),
      `${tag} the chat's font is system-ui first (${inside.rootFont.slice(0, 40)}…)`,
    );
    check(inside.inputFont.startsWith("system-ui"), `${tag} the input's font too, not the page's`);
    check(
      inside.rootSize === "14px",
      `${tag} 14px at the root despite html { font-size: 40px } (${inside.rootSize})`,
    );
    check(
      inside.inputSize === "16px",
      `${tag} the input is 16px, not 40px-scaled (${inside.inputSize})`,
    );
    check(inside.inputVisible, `${tag} the input is on screen (${inside.inputBox})`);
    check(
      inside.sheets === before.sheets &&
        inside.styles === before.styles &&
        inside.adopted === before.adopted,
      `${tag} nothing leaks out: no new stylesheet in the document`,
    );
    check(
      inside.ownFont === before.ownFont && /Comic/.test(inside.ownFont),
      `${tag} the page keeps its own font`,
    );
    check(
      inside.hostAttrs.join(",") === "style",
      `${tag} the host carries no attributes but its style (no secrets in the DOM)`,
    );

    // Keys typed in the chat stay in the chat.
    await p.evaluate(() => {
      const m = (window as unknown as { __m: { root: ShadowRoot } }).__m;
      (m.root.querySelector('[data-testid="debug-chat-input"]') as HTMLElement).focus();
    });
    await p.keyboard.type("hi hub");
    const keys = await p.evaluate(() => {
      const m = (window as unknown as { __m: { root: ShadowRoot } }).__m;
      const w = window as unknown as { __pageKeys: string[] };
      return {
        page: [...w.__pageKeys],
        value: (m.root.querySelector('[data-testid="debug-chat-input"]') as HTMLTextAreaElement)
          .value,
      };
    });
    check(
      keys.page.length === 0,
      `${tag} the page's keydown/keypress listeners saw none of the chat's keys (${keys.page.length})`,
    );
    check(
      keys.value === "hi hub",
      `${tag} the text arrived in the chat despite the page's preventDefault ("${keys.value}")`,
    );
    // The line goes to the hub (sent 3 s after typing stops).
    const conn = hubSeen.at(-1);
    await p.waitForTimeout(3600);
    const chat = conn?.messages.map((s) => JSON.parse(s)).find((m) => m.type === "chat");
    check(chat?.text === "hi hub", `${tag} the typed line reached the hub`);
    check(
      conn?.protocol === "lianki-partner, TICKET-abc.def" && !conn.url.includes("TICKET"),
      `${tag} the ticket rode in Sec-WebSocket-Protocol, not the URL`,
    );
    check(
      (conn?.messages ?? []).every((s) => ["chat", "page"].includes(JSON.parse(s).type)),
      `${tag} the partner sent only chat lines`,
    );

    // Keys typed on the page are still the page's.
    await p.click("#pageInput");
    await p.keyboard.type("xy");
    const after = await p.evaluate(
      () => (window as unknown as { __pageKeys: string[] }).__pageKeys,
    );
    check(
      after.filter((k) => k === "x" || k === "y").length === 2,
      `${tag} the page still gets its own keys`,
    );
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/partner-hostile-${scheme}.png` });
    check(errors.length === 0, `${tag} no page errors (${errors.join("; ")})`);

    // A strict connect-src: the note instead, the page unbroken.
    const c = await ctx.newPage();
    await c.goto(`${PAGE}/hostile-csp`);
    const hubBefore = hubSeen.length;
    await c.evaluate(
      ({ code, app }) => {
        const b = (0, eval)(code)(null);
        (window as unknown as { __m: unknown }).__m = b.api.mountPartner({
          doc: document,
          css: b.css,
          appOrigin: app,
          ticket: async () => "TICKET-csp.x",
          WebSocket,
          hide() {},
        });
      },
      { code: built.code, app: APP },
    );
    await c.waitForFunction(
      () =>
        !!(window as unknown as { __m: { root: ShadowRoot } }).__m.root.querySelector(
          '[data-testid="partner-note"]',
        ),
      undefined,
      { timeout: 10_000 },
    );
    const note = await c.evaluate(() => ({
      text: (window as unknown as { __m: { root: ShadowRoot } }).__m.root.querySelector(
        '[data-testid="partner-note"]',
      )?.textContent,
      alive: (window as unknown as { __pageAlive: boolean }).__pageAlive,
    }));
    check(
      /security policy/.test(note.text ?? ""),
      `${tag} CSP connect-src: the note says why ("${note.text?.slice(0, 60)}…")`,
    );
    check(hubSeen.length === hubBefore, `${tag} CSP connect-src: no socket reached the hub`);
    check(note.alive === true, `${tag} CSP: the page's own script still ran`);
    if (SHOTS) await c.screenshot({ path: `${SHOTS}/partner-csp-${scheme}.png` });

    // The lianki.com frame: typing in it is private from the page.
    const f = await ctx.newPage();
    await f.goto(`${PAGE}/frame-allowed`);
    await f.addScriptTag({ url: `${PAGE}/shell.js` });
    const runShell = (app: string) =>
      (window as unknown as { __lkShell: (o: string) => Promise<string> }).__lkShell(app);
    const how = await f.evaluate(runShell, APP);
    check(how === "ready", `${tag} frame allowed: the handshake says ready (${how})`);
    const frame = f.frames().find((x) => x.url().startsWith(`${APP}/embed/partner`));
    check(!!frame, `${tag} frame allowed: the app-origin frame is there`);
    if (frame) {
      await frame.waitForFunction(() => document.body.dataset.ticket === "TK-frame", undefined, {
        timeout: 5000,
      });
      check(true, `${tag} frame allowed: the frame got its ticket over the port`);
      await frame.click("#t");
      await f.keyboard.type("secret words");
      const seen = await f.evaluate(() => {
        const w = window as unknown as {
          __pageKeys: string[];
          __pageWindowCapture: string[];
          __pageMessages: unknown[];
        };
        return {
          keys: [...w.__pageKeys, ...w.__pageWindowCapture],
          msgs: JSON.stringify(w.__pageMessages),
        };
      });
      const typed = await frame.evaluate(
        () => (document.getElementById("t") as HTMLTextAreaElement).value,
      );
      check(
        typed === "secret words",
        `${tag} frame allowed: the text arrives in the frame ("${typed}")`,
      );
      check(
        seen.keys.length === 0,
        `${tag} frame allowed: the page's capture and bubble key listeners saw none of it (${seen.keys.length})`,
      );
      check(
        !seen.msgs.includes("TK-frame") && !seen.msgs.includes("secret"),
        `${tag} frame allowed: no ticket or text in any message the page can hear`,
      );
    }
    if (SHOTS) await f.screenshot({ path: `${SHOTS}/partner-frame-${scheme}.png` });

    const b = await ctx.newPage();
    await b.goto(`${PAGE}/frame-blocked`);
    await b.addScriptTag({ url: `${PAGE}/shell.js` });
    const t0 = Date.now();
    const blocked = await b.evaluate(runShell, APP);
    check(
      blocked === "blocked",
      `${tag} frame-src blocks it: the handshake says blocked (${blocked}, ${Date.now() - t0} ms)`,
    );
    // Then read-only: replies show, no input, a link to reply on lianki.com.
    await b.evaluate(
      ({ code, app }) => {
        const bb = (0, eval)(code)(null);
        (window as unknown as { __m: unknown }).__m = bb.api.mountPartner({
          doc: document,
          css: bb.css,
          appOrigin: app,
          ticket: async () => "TICKET-ro.x",
          WebSocket,
          hide() {},
          readOnly: true,
        });
      },
      { code: built.code, app: APP },
    );
    await b.waitForFunction(
      () =>
        !!(window as unknown as { __m: { root: ShadowRoot } }).__m.root.querySelector(
          '[data-testid="debug-chat-notice-link"]',
        ),
      undefined,
      { timeout: 10_000 },
    );
    const ro = await b.evaluate(() => {
      const r = (window as unknown as { __m: { root: ShadowRoot } }).__m.root;
      return {
        input: !!r.querySelector('[data-testid="debug-chat-input"]'),
        notice: r.querySelector('[data-testid="debug-chat-notice"]')?.textContent ?? "",
        reply: r.textContent?.includes("Hello from the hub") ?? false,
      };
    });
    check(
      !ro.input && /private typing/.test(ro.notice),
      `${tag} read-only: no input, the note says why ("${ro.notice.slice(0, 50)}…")`,
    );
    check(ro.reply, `${tag} read-only: the replies still show`);
    if (SHOTS) await b.screenshot({ path: `${SHOTS}/partner-readonly-${scheme}.png` });
    await ctx.close();
  }
} finally {
  await browser.close();
  server.stop(true);
}

if (fail.length) {
  console.error(`\n${fail.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall partner checks passed");

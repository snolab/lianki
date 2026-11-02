#!/usr/bin/env bun
/**
 * The REAL /embed/partner route in a frame on another site's page, in a
 * silent Chromium (docs/dev-debug-widget.md, "The frame"). Run by qa:all
 * against its wrangler dev server (QA_BASE), or by hand against any app:
 *
 *   QA_BASE=http://localhost:3000 bun scripts/qa/qa-partner-frame-route.ts
 *
 * The host page is served from 127.0.0.1 (another origin than QA_BASE's
 * localhost) with the userscript's real frame shell. Checks:
 * 1. the handshake says ready, and the frame asks the shell for a ticket;
 * 2. text typed in the frame's chat input arrives there, and the host page's
 *    key listeners (capture and bubble) see none of it;
 * 3. no owner boot runs in the frame, even with debug mode on in its
 *    storage: no cookie socket (DebugEval's carries `frame=` / `tab=`), only
 *    the partner's ticket socket.
 */
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = (process.env.QA_BASE || "http://localhost:3000").replace(/\/$/, "");
const QA_DIR = new URL(".", import.meta.url).pathname;
const shellJs = await Bun.build({
  entrypoints: [`${QA_DIR}partner-frame-fixture-shell.ts`],
  target: "browser",
  format: "iife",
  minify: true,
}).then((o) => o.outputs[0].text());

const HOST = `<!doctype html><meta charset=utf-8><title>host</title><body>
<p>Someone else's site.</p><input id=pageInput aria-label=page>
<script>
  window.__keys = [];
  document.addEventListener("keydown", (e) => { window.__keys.push(e.key); }, true);
  window.addEventListener("keydown", (e) => { window.__keys.push(e.key); }, true);
  document.addEventListener("keydown", (e) => { window.__keys.push(e.key); e.preventDefault(); });
</script><script src="/shell.js"></script></body>`;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/shell.js")
      return new Response(shellJs, { headers: { "content-type": "text/javascript" } });
    return new Response(HOST, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
const PAGE = `http://127.0.0.1:${server.port}/`;

const fail: string[] = [];
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) fail.push(what);
};

const browser = await launchSilent(chromium);
try {
  const ctx = await newSilentContext(browser, { viewport: { width: 390, height: 780 } });
  const p = await ctx.newPage();
  const sockets: string[] = [];
  p.on("websocket", (ws) => sockets.push(ws.url()));
  const run = () =>
    p.evaluate(
      (app) => (window as unknown as { __lkShell: (o: string) => Promise<string> }).__lkShell(app),
      BASE,
    );
  await p.goto(PAGE);
  const first = await run();
  check(first === "ready", `handshake with the real /embed/partner says ready (${first})`);
  const frameOf = () => p.frames().find((f) => f.url().startsWith(`${BASE}/embed/partner`));
  // Debug mode on in the frame's own (partitioned) storage: an owner boot would now connect.
  await frameOf()?.evaluate(() => {
    localStorage.setItem("lk:debug", "1");
    localStorage.setItem("lk:agent", "1");
  });
  sockets.length = 0;
  await p.reload();
  const how = await run();
  check(how === "ready", `again with debug mode on in the frame: ready (${how})`);
  const frame = frameOf();
  check(!!frame, "the real frame is on the page");
  if (frame) {
    await p.waitForFunction(
      () => ((window as unknown as { __tickets?: number }).__tickets ?? 0) > 0,
      undefined,
      {
        timeout: 10_000,
      },
    );
    check(true, "the frame asked the shell for a ticket, over the port");
    const input = frame.locator('[data-testid="debug-chat-input"]');
    await input.waitFor({ timeout: 10_000 });
    await input.click();
    await p.keyboard.type("hello frame");
    const value = await input.inputValue();
    check(value === "hello frame", `the text arrives in the frame's chat input ("${value}")`);
    const keys = await p.evaluate(() => (window as unknown as { __keys: string[] }).__keys.length);
    check(keys === 0, `the host page's key listeners saw none of it (${keys})`);
    const owner = await frame.evaluate(() => ({
      evalBadge: !!document.querySelector('[data-testid="debug-eval"], [data-debug-eval]'),
      pair: !!document.querySelector('[role="dialog"]'),
      marked: document.documentElement.dataset.partnerFrame === "",
    }));
    check(
      owner.marked && !owner.evalBadge && !owner.pair,
      "no DebugEval UI, no pairing dialog in the frame",
    );
  }
  await p.waitForTimeout(1500);
  const cookieSockets = sockets.filter((u) => /[?&](frame|tab)=/.test(u));
  check(
    cookieSockets.length === 0,
    `no cookie socket from the frame (${cookieSockets.join(", ") || "none"})`,
  );
  check(
    sockets.some((u) => u.startsWith(`${BASE.replace(/^http/, "ws")}/api/version/debug?label=`)),
    `only the partner's ticket socket (${sockets.length})`,
  );
  await ctx.close();
} finally {
  await browser.close();
  server.stop(true);
}
if (fail.length) {
  console.error(`\n${fail.length} check(s) failed`);
  process.exit(1);
}
console.log("\nreal frame route: all checks passed");

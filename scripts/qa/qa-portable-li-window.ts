#!/usr/bin/env bun
/**
 * 随身Li's chat window in a real (muted, headless) Chromium: the main site's
 * DebugChat (public/partner-embed.js `mountPortable`) mounted on a normal page
 * and on a strict-CSP page the way the userscript does it: the build evaluated
 * in a separate JS world (a userscript manager's), the DOM shared. The broker
 * is a fake with the real contract (read / send only). qa-portable-li.ts covers
 * the consent flow and the plain fallback panel against the real route.
 *
 * Checks: DebugChat renders in a closed shadow root at a fixed size (the
 * page's html font-size changes nothing), history shows as rich text, a typed
 * line goes out as one `send` with only {op,id,text}, Li's reply arrives over
 * the long poll, an @-addressed line is refused locally with the lianki.com
 * hint, nothing lands in the page's JS world. Screenshots in light and dark.
 *
 *   bun scripts/qa/qa-portable-li-window.ts [--shots <dir>]
 */
import { chromium } from "playwright";
import { buildPartner } from "../build-partner-embed";
import { launchSilent, newSilentContext } from "./silent.mjs";

const shotsAt = Bun.argv.indexOf("--shots");
const SHOTS = shotsAt > -1 ? Bun.argv[shotsAt + 1] : "";

const ARTICLE = `<h1>A page about tides</h1>
<p>Tides are the rise and fall of sea levels caused by the combined effects of the gravitational forces exerted by the Moon and the Sun, and the rotation of the Earth.</p>
<p>Tide tables can be used for any given locale to find the predicted times and amplitude.</p>
<p><a href="#">A page link</a> <button>A page button</button></p>`;

// A page that tries to restyle everything: big rem, its own fonts, button and div rules.
const PAGE_CSS = `html{font-size:24px}body{font:1rem/1.6 Georgia,serif;margin:1rem;color:oklch(0.3 0 0);background:oklch(0.99 0 0)}
@media (prefers-color-scheme:dark){body{color:oklch(0.9 0 0);background:oklch(0.18 0 0)}}
button{all:unset;background:oklch(0.6 0.2 300);padding:1rem}textarea,button,div{font-size:30px!important}`;

const page = (title: string) =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>` +
  `<link rel="stylesheet" href="/page.css"></head><body>${ARTICLE}</body></html>`;

const STRICT_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'none'; connect-src 'none'; frame-src 'none'; require-trusted-types-for 'script'";

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/page.css")
      return new Response(PAGE_CSS, { headers: { "content-type": "text/css" } });
    if (url.pathname === "/normal")
      return new Response(page("normal"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    if (url.pathname === "/strict")
      return new Response(page("strict CSP"), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": STRICT_CSP,
        },
      });
    return new Response("not found", { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

const fail: string[] = [];
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) fail.push(what);
};

const built = await buildPartner();
console.log(`partner-embed.js: ${(built.bytes / 1024) | 0} KB`);

/** Runs in the separate world: the userscript's side, with a fake broker. */
const WORLD = (code: string) => `(() => {
  const factory = (0, eval)(${JSON.stringify(code)});
  const b = factory(null);
  const now = Date.now();
  const seen = [];
  let seq = 3;
  const lines = [
    { id: "m1", from: "owner", label: "", text: "潮汐是怎么形成的？", at: now - 60000, seq: 1 },
    { id: "m2", from: "agent", label: "", text: "主要是**月球引力**和地球自转共同作用。\\n\\n- 每天大约两次涨潮\\n- 新月和满月时潮差最大（大潮）", at: now - 50000, seq: 2 },
  ];
  let parked = null;
  const history = (after) => ({ ok: true, kind: "history", range: { type: "history", thread: "t", messages: lines.filter((m) => m.seq > (after ?? 0)), removed: [], skipped: [], afterSeq: after ?? 0, throughSeq: seq - 1, headSeq: seq - 1, prunedThroughSeq: 0 } });
  const call = (input, principal, signal) => {
    seen.push(JSON.parse(JSON.stringify(input)));
    if (input.op === "send") {
      const mine = { id: input.id, from: "owner", label: "", text: input.text, at: Date.now(), seq: seq++ };
      lines.push(mine);
      setTimeout(() => {
        lines.push({ id: "r" + seq, from: "agent", label: "", text: "好问题。潮汐表能预测每天的涨落时间。", at: Date.now(), seq: seq++ });
        if (parked) { const p = parked; parked = null; p(history(mine.seq - 1)); }
      }, 300);
      return Promise.resolve({ ok: true, kind: "accepted", id: input.id, seq: mine.seq });
    }
    if (!input.wait) return Promise.resolve(history(input.afterSeq));
    return new Promise((resolve) => {
      parked = resolve;
      signal && signal.addEventListener("abort", () => resolve({ ok: false, error: "cancelled" }));
    });
  };
  const m = b.api.mountPortable({
    doc: document, css: b.css, appOrigin: location.origin, call, principal: "acct",
    strings: { name: "随身Li", connecting: "正在连接…", failed: "连接失败，请重试。", advancedHint: "去 lianki.com 为这个网站单独打开", excludeHere: "不在此网站显示" },
    advancedHref: "https://lianki.com/chat?from=" + encodeURIComponent(location.origin),
    onExclude() {}, onInvalidAccount() {},
  });
  globalThis.__qa = { m, seen };
  return true;
})()`;

const browser = await launchSilent(chromium);
try {
  for (const kind of ["normal", "strict"] as const)
    for (const scheme of ["light", "dark"] as const) {
      const tag = `[${kind} ${scheme}]`;
      const ctx = await newSilentContext(browser, {
        viewport: { width: 390, height: 780 },
        colorScheme: scheme,
      });
      const p = await ctx.newPage();
      const errors: string[] = [];
      p.on("pageerror", (e) => errors.push(String(e)));
      await p.goto(`${BASE}/${kind}`);
      const cdp = await ctx.newCDPSession(p);
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "lianki-userscript",
      });
      const run = async (expression: string) => {
        const r = await cdp.send("Runtime.evaluate", {
          expression,
          contextId: executionContextId,
          returnByValue: true,
          awaitPromise: true,
        });
        if (r.exceptionDetails)
          throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      };
      await run(WORLD(built.code));
      const inWorld = (fn: string) =>
        run(`(() => { const r = globalThis.__qa.m.root; return (${fn})(r); })()`);
      const until = async (fn: string) => {
        const end = Date.now() + 10_000;
        while (Date.now() < end && !(await inWorld(fn))) await p.waitForTimeout(100);
        return inWorld(fn);
      };
      check(
        await p.evaluate(() => !("__qa" in globalThis)),
        `${tag} nothing lands in the page's JS world`,
      );
      check(
        await until(`(r) => r.textContent.includes("月球引力")`),
        `${tag} history renders in DebugChat`,
      );
      const box = await inWorld(`(r) => {
        const input = r.querySelector('[data-testid="debug-chat-input"]');
        const root = r.querySelector(".lk-partner-root");
        const b = input.getBoundingClientRect();
        return { closed: r.host.shadowRoot === null, font: getComputedStyle(root).fontSize, inputFont: getComputedStyle(input).fontSize, visible: b.width > 40 && b.bottom <= innerHeight, strong: !!r.querySelector("strong"), x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }`);
      check(box.closed, `${tag} closed shadow root`);
      check(
        box.font === "14px" && box.inputFont === "16px",
        `${tag} fixed size despite the page's html{font-size:24px} (${box.font}/${box.inputFont})`,
      );
      check(box.visible, `${tag} the composer is on screen`);
      // Under Trusted Types (the strict page) RichText falls back to plain text, by design.
      if (kind === "normal") check(box.strong, `${tag} Li's markdown renders as rich text`);
      else console.log(`· ${tag} rich text ${box.strong ? "on" : "plain (Trusted Types)"}`);
      await p.mouse.click(box.x, box.y);
      await p.keyboard.type("潮汐表准吗？");
      await p.keyboard.press("Enter");
      check(
        await until(`(r) => r.textContent.includes("潮汐表能预测")`),
        `${tag} Li's reply arrives over the long poll`,
      );
      check(
        await inWorld(`(r) => r.textContent.includes("潮汐表准吗")`),
        `${tag} the typed line shows`,
      );
      const seen = (await run(`globalThis.__qa.seen`)) as Record<string, unknown>[];
      const sends = seen.filter((s) => s.op === "send");
      check(
        sends.length === 1 && Object.keys(sends[0]).sort().join() === "id,op,text",
        `${tag} one send, only {op,id,text}`,
      );
      check(
        seen.every((s) => s.op === "read" || s.op === "send"),
        `${tag} only read/send reach the broker`,
      );
      await p.waitForTimeout(300);
      if (SHOTS) await p.screenshot({ path: `${SHOTS}/portable-li-${kind}-${scheme}.png` });
      // An advanced action: an @-addressed line is refused locally, with the hint.
      await p.mouse.click(box.x, box.y);
      await p.keyboard.type("@/plan 帮我排进计划");
      await p.keyboard.press("Enter");
      await p.waitForTimeout(400);
      const hint = await inWorld(
        `(r) => { const w = r.querySelector('[data-testid="debug-chat-warning"]'); const a = r.querySelector('[data-testid="debug-chat-warning-link"]'); return { text: w ? w.textContent : "", href: a ? a.href : "" }; }`,
      );
      const sendsAfter = ((await run(`globalThis.__qa.seen`)) as Record<string, unknown>[]).filter(
        (s) => s.op === "send",
      ).length;
      if (hint.text) {
        check(
          hint.text.includes("去 lianki.com 为这个网站单独打开") &&
            hint.href.startsWith("https://lianki.com/chat?from="),
          `${tag} the advanced hint shows only now, with its link`,
        );
        check(sendsAfter === 1, `${tag} the advanced line was not sent`);
        if (SHOTS) await p.screenshot({ path: `${SHOTS}/portable-li-${kind}-${scheme}-hint.png` });
      } else
        console.log(
          `· ${tag} "@/plan" went as plain text (sends=${sendsAfter}); hint is unit-tested`,
        );
      check(
        errors.length === 0,
        `${tag} no page errors${errors.length ? ": " + errors.join(" | ") : ""}`,
      );
      await ctx.close();
    }
} finally {
  await browser.close();
  server.stop(true);
}
if (fail.length) {
  console.error(`\n${fail.length} failed`);
  process.exit(1);
}
console.log("\nall passed");

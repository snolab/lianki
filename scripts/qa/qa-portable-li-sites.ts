#!/usr/bin/env bun
/**
 * 随身Li on real sites (github.com, www.zhihu.com: CSP frame-src refuses the
 * lianki.com frame; example.com: a normal site), the way ScriptCat runs it:
 * the built public/lianki.user.js evaluated in the page's own JS world
 * (sandboxMode "raw"), with GM stubs and a synthetic chat-only broker (no
 * real account, no lianki.com request: lianki.com is routed away, so the
 * frame is refused everywhere here and the bundled DebugChat draws).
 *
 * The real consent prompt is clicked, then a line typed and Li's synthetic
 * reply read. Checks the window is DebugChat (`data-lk-portable` = "bundled
 * frame:blocked"), no plain panel exists, and screenshots light and dark.
 *
 *   bun scripts/qa/qa-portable-li-sites.ts --shots <dir> [--sites github,zhihu,example]
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const arg = (k: string) => {
  const i = Bun.argv.indexOf(k);
  return i > -1 ? Bun.argv[i + 1] : undefined;
};
const SHOTS = arg("--shots") ?? "";
const SITES: Record<string, string> = {
  github: "https://github.com/",
  zhihu: "https://www.zhihu.com/",
  example: "https://example.com/",
};
const pick = (arg("--sites") ?? "github,zhihu,example").split(",");
/**
 * --live-frame: let the frame reach the real lianki.com. Before the new
 * /embed/partner is deployed, that is the old embed: the handshake gate must
 * reject it ("incompatible") and the bundled window draw.
 */
const LIVE_FRAME = Bun.argv.includes("--live-frame");
const CODE = readFileSync("public/lianki.user.js", "utf8");

/** GM stubs + a synthetic broker: hello/read/send with the real contract's shapes. */
const PRELUDE = `
var __qa = (globalThis.__qa = { seen: [], roots: [] });
// QA only: keep the closed roots so the test can find buttons by their text.
(() => { const a = Element.prototype.attachShadow; Element.prototype.attachShadow = function (o) { const r = a.call(this, o); __qa.roots.push(r); return r; }; })();
__qa.rect = (sel, text) => {
  for (const r of __qa.roots) for (const el of r.querySelectorAll(sel))
    if (el.isConnected && el.getClientRects().length && (text == null || el.textContent === text)) {
      const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
  return null;
};
var GM_values = new Map([
  ["lianki_pillchat_on", JSON.stringify({ on: true, at: Date.now() })],
  ["lianki_lichat_ui_language_v1", "zh"],
]);
var GM_getValue = (k, d) => (GM_values.has(k) ? GM_values.get(k) : d);
var GM_setValue = (k, v) => void GM_values.set(k, v);
var GM_deleteValue = (k) => void GM_values.delete(k);
var GM_listValues = () => [...GM_values.keys()];
var GM_addValueChangeListener = () => 0;
var GM_removeValueChangeListener = () => {};
var GM_registerMenuCommand = () => 0;
var GM_info = { script: { version: "qa", downloadURL: "https://lianki.com/lianki.user.js" }, sandboxMode: "raw" };
var unsafeWindow = window;
(() => {
  const now = Date.now();
  let seq = 3, parked = null;
  const lines = [
    { id: "m1", from: "owner", label: "", text: "这个页面讲的是什么？", at: now - 60000, seq: 1 },
    { id: "m2", from: "agent", label: "", text: "我看不到页面内容，除非你**分享**给我。\\n\\n- 你可以直接把问题打出来\\n- 我会用中文回答", at: now - 50000, seq: 2 },
  ];
  const history = (after) => ({ ok: true, kind: "history", range: { type: "history", thread: "t", messages: lines.filter((m) => m.seq > (after || 0)), removed: [], skipped: [], afterSeq: after || 0, throughSeq: seq - 1, headSeq: seq - 1, prunedThroughSeq: 0 } });
  globalThis.GM_xmlhttpRequest = (d) => {
    let done = false;
    const reply = (status, body) => setTimeout(() => { if (!done) { done = true; d.onload({ status, responseText: JSON.stringify(body) }); } }, 20);
    if (d.url.endsWith("/api/chat/page-broker")) {
      const input = JSON.parse(d.data);
      __qa.seen.push({ op: input.op, keys: Object.keys(input).sort().join(","), auth: Object.keys(d.headers || {}).some((h) => /authorization/i.test(h)) });
      if (input.op === "hello") reply(200, { ok: true, kind: "hello", principal: "qa_account" });
      else if (input.op === "send") {
        const mine = { id: input.id, from: "owner", label: "", text: input.text, at: Date.now(), seq: seq++ };
        lines.push(mine);
        reply(200, { ok: true, kind: "accepted", id: input.id, seq: mine.seq });
        setTimeout(() => {
          lines.push({ id: "r" + seq, from: "agent", label: "", text: "好问题。先说说你想从这页学到什么？", at: Date.now(), seq: seq++ });
          if (parked) { const p = parked; parked = null; p(); }
        }, 300);
      } else if (!input.wait) reply(200, history(input.afterSeq));
      else parked = () => reply(200, history(input.afterSeq));
    } else {
      __qa.seen.push({ other: d.url.replace(/\\?.*/, "") });
      setTimeout(() => { if (!done) { done = true; d.onerror && d.onerror(); } }, 10);
    }
    return { abort() { done = true; } };
  };
})();
`;

const fail: string[] = [];
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) fail.push(what);
};

const browser = await launchSilent(chromium);
try {
  for (const site of pick)
    for (const scheme of ["light", "dark"] as const) {
      const tag = `[${site} ${scheme}]`;
      const ctx = await newSilentContext(browser, {
        viewport: { width: 390, height: 780 },
        colorScheme: scheme,
        locale: "zh-CN",
      });
      // No request reaches lianki.com from this QA: the frame is refused here.
      if (!LIVE_FRAME) await ctx.route(/^https:\/\/(www\.)?lianki\.com\//, (r) => r.abort());
      const p = await ctx.newPage();
      const errors: string[] = [];
      p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
      await p.goto(SITES[site], { waitUntil: "domcontentloaded", timeout: 45_000 });
      await p.waitForTimeout(1500);
      // ScriptCat raw: the script in the page's own world.
      const cdp = await ctx.newCDPSession(p);
      const r = await cdp.send("Runtime.evaluate", { expression: `${PRELUDE}\n${CODE}\n;true` });
      if (r.exceptionDetails) {
        check(
          false,
          `${tag} userscript ran: ${r.exceptionDetails.exception?.description?.slice(0, 200)}`,
        );
        await ctx.close();
        continue;
      }
      // The real consent prompt, clicked as a person would.
      const consent = async () =>
        p.evaluate(() => {
          const host = document.querySelector("lianki-portable-consent");
          return !!host;
        });
      const until = async (fn: () => Promise<boolean>, ms = 15_000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          if (await fn()) return true;
          await p.waitForTimeout(150);
        }
        return false;
      };
      check(await until(consent), `${tag} consent prompt shows`);
      const allow = await p.evaluate(() => (globalThis as any).__qa.rect("button", "同意所有网站"));
      check(allow, `${tag} the allow button is there`);
      if (allow) await p.mouse.click(allow.x, allow.y);
      const drawn = () =>
        p.evaluate(() => document.documentElement.getAttribute("data-lk-portable") ?? "");
      check(
        await until(async () => (await drawn()).startsWith("bundled")),
        `${tag} the bundled DebugChat draws (${await drawn()})`,
      );
      check(
        /^bundled frame:(blocked|incompatible|timeout|no-ticket)$/.test(await drawn()),
        `${tag} after the frame was refused or failed the handshake (${await drawn()})`,
      );
      check(
        await p.evaluate(() => !document.querySelector("lianki-portable-chat")),
        `${tag} no plain panel`,
      );
      // Type and send through the composer: focus it by clicking near the bottom of the window.
      await p.waitForTimeout(800);
      const input = await until(
        async () =>
          !!(await p.evaluate(() =>
            (globalThis as any).__qa.rect('[data-testid="debug-chat-input"]'),
          )),
      );
      check(input, `${tag} the DebugChat composer is there`);
      const at = await p.evaluate(() =>
        (globalThis as any).__qa.rect('[data-testid="debug-chat-input"]'),
      );
      if (at) await p.mouse.click(at.x, at.y);
      await p.keyboard.type("帮我总结一下");
      await p.keyboard.press("Enter");
      await until(
        async () =>
          !!(await p.evaluate(() =>
            (globalThis as any).__qa.roots.some((r: ShadowRoot) =>
              r.textContent?.includes("先说说你想"),
            ),
          )),
      );
      const seen = (await p.evaluate(() => (globalThis as any).__qa.seen)) as any[];
      const sends = seen.filter((s) => s.op === "send");
      check(
        sends.length === 1 && sends[0].keys === "id,op,text",
        `${tag} one send with only {op,id,text}`,
      );
      check(
        seen.filter((s) => s.op).every((s) => !s.auth),
        `${tag} no Authorization on the broker`,
      );
      check(
        seen.filter((s) => s.op).every((s) => ["hello", "read", "send"].includes(s.op)),
        `${tag} only hello/read/send reach the broker`,
      );
      const size = await p.evaluate(() => {
        const r = (globalThis as any).__qa.rect('[data-testid="debug-chat-input"]');
        return { input: r, vw: innerWidth, vh: innerHeight };
      });
      check(size.input && size.input.x > 40, `${tag} the window is full size, not a clipped box`);
      if (SHOTS)
        await p.screenshot({
          path: `${SHOTS}/portable-li-${site}-${scheme}${LIVE_FRAME ? "-liveframe" : ""}.png`,
        });
      console.log(`· ${tag} page errors: ${errors.length}`);
      await ctx.close();
    }
} finally {
  await browser.close();
}
if (fail.length) {
  console.error(`\n${fail.length} failed`);
  process.exit(1);
}
console.log("\nall passed");

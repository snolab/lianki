#!/usr/bin/env bun
/**
 * One-shot, read-only look at the Li chat's log on the owner's open pages, for
 * the moment its scroll looks wrong (owner, 2026-11-07 18:10 JST: "滚动不在正确的
 * 位置，它的下面半个窗口是空的"). Runs once through eval.ts with --no-pair (never
 * prompts his devices; with no saved grant it fails): no loop, nothing changed.
 *
 *   bun scripts/dev/chat-scroll-diag.ts [--target <text>]   run it, print each page's JSON
 *   bun scripts/dev/chat-scroll-diag.ts --print             print the snippet only
 *
 * Per page: the viewport and visualViewport, the log box and its scroll
 * (gap = px left below the view), its inline padding and max-height, the
 * full-screen state, the newest lines' text boxes and the blank under the
 * newest, the up-arrow and its count, the scroll-down button, the bar's box,
 * the compact view and the open asks.
 */
import { spawnSync } from "node:child_process";

const SNIPPET = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), left: Math.round(b.left), w: Math.round(b.width) }; };
  const q = (id) => document.querySelector('[data-testid="' + id + '"]');
  const col = q("debug-chat-column");
  const lines = col ? [...col.querySelectorAll("[data-testid=debug-chat-line]")] : [];
  const textBottom = (node) => { let b = -Infinity; const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { if (!n.textContent.trim()) continue; const g = document.createRange(); g.selectNodeContents(n); for (const x of g.getClientRects()) if (x.height) b = Math.max(b, x.bottom); } return b; };
  const last = lines.at(-1);
  const box = col && col.getBoundingClientRect();
  const vv = globalThis.visualViewport;
  return {
    path: location.pathname,
    standalone: matchMedia("(display-mode: standalone)").matches,
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
    inner: [innerWidth, innerHeight],
    vv: vv ? { h: Math.round(vv.height), top: Math.round(vv.offsetTop), scale: vv.scale } : null,
    chat: r(document.querySelector("[data-debug-chat]")),
    log: col ? { hidden: col.hidden, box: r(col), scrollTop: Math.round(col.scrollTop), scrollHeight: col.scrollHeight, clientHeight: col.clientHeight, gap: Math.round(col.scrollHeight - col.scrollTop - col.clientHeight), maxHeight: getComputedStyle(col).maxHeight, padBottom: getComputedStyle(col).paddingBottom, olPadBottom: col.firstElementChild ? getComputedStyle(col.firstElementChild).paddingBottom : null, full: col.dataset.full ?? null, expanded: col.dataset.expanded ?? null } : null,
    newest: last ? { from: last.dataset.from, msg: last.dataset.msg, box: r(last), blankUnder: box ? Math.round(box.bottom - textBottom(last)) : null } : null,
    lines: lines.length,
    lastRuns: col ? [...col.querySelectorAll("[data-testid=debug-chat-run]")].slice(-3).map((x) => ({ from: x.dataset.from, box: r(x), room: x.dataset.jumpRoom ?? null })) : [],
    askJump: q("debug-chat-ask-jump") ? { box: r(q("debug-chat-ask-jump")), count: q("debug-chat-ask-jump").dataset.count } : null,
    scrollDown: r(q("debug-chat-bottom")),
    bar: r(document.querySelector("[data-debug-chat-row]")),
    compact: !!q("debug-chat-compact"),
    openAsks: document.querySelectorAll("[data-ask]").length,
    widget: document.querySelector("[data-debug-widget]")?.getAttribute("data-debug-widget") ?? null,
  };
})()`;

const args = process.argv.slice(2);
if (args.includes("--print")) {
  console.log(SNIPPET);
  process.exit(0);
}
const t = args.indexOf("--target");
const target = t === -1 ? [] : ["--target", args[t + 1] ?? ""];
const res = spawnSync("bun", ["scripts/dev/eval.ts", ...target, "--no-pair", SNIPPET], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);

#!/usr/bin/env bun
/**
 * Browser checks: a newly said line lands at the bottom of the open log, its
 * text visible, with no blank space under it, with or without the up-arrow
 * to an unanswered question above (owner, 2026-11-07 18:10 JST, iPhone PWA:
 * "我能看到字，不过滚动不在正确的位置，它的下面半个窗口是空的": the arrow
 * kept a whole empty row under the newest line).
 *
 * On the local /harness with the hot widget, WebKit and Chromium, 414×848 and
 * 320×568, light and dark, at rest and while typing:
 *
 *   - each new line: the log at its end, the line's text inside the log's
 *     box and readable, at most a few px of the log under it
 *   - an ask pushed off above: the arrow shows, the log keeps its height
 *     (no row added), the newest line still at the bottom
 *   - the arrow covers no line's text and no ask pill (text rects measured)
 *   - one short line after the ask (the arrow is taller than a line), long
 *     ones, the owner's own line, and the count (a wider button)
 *
 * getUserMedia is refused; the browsers are silent (scripts/qa/silent.mjs).
 *
 *   bun scripts/dev/debug-chat-newline-qa.mjs [--shots <dir>]
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium, webkit } from "playwright";
import { launchSilent, newSilentContext } from "../qa/silent.mjs";

const argv = process.argv.slice(2);
const shotsAt = argv.indexOf("--shots");
const shots = shotsAt === -1 ? null : argv[shotsAt + 1];
if (shots) mkdirSync(shots, { recursive: true });

const port = await new Promise((resolve, reject) => {
  const s = createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const ORIGIN = `http://localhost:${port}`;
const server = spawn(
  "bun",
  ["scripts/dev/debug-widget-server.ts", "--port", String(port), "--no-tunnel"],
  { stdio: ["ignore", "pipe", "inherit"] },
);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("widget server did not start in 60 s")), 60_000);
  server.stdout.on("data", (b) => {
    if (String(b).includes("listening")) {
      clearTimeout(t);
      resolve();
    }
  });
  server.on("exit", (c) => reject(new Error(`widget server exited (${c})`)));
});

const failures = [];
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(what);
};

/** Px of log the newest line's text may leave under it (the log's py-1.5 and the leading). */
const BLANK_MAX = 12;
const COL = '[data-testid="debug-chat-column"]';
const JUMP = '[data-testid="debug-chat-ask-jump"]';
const askOf = (askId) => ({
  askId,
  questions: [
    {
      id: "q1",
      question: `Question ${askId}?`,
      options: [
        { id: "yes", label: "Merge it now", recommended: true },
        { id: "no", label: "Wait" },
      ],
    },
  ],
});

/** In the page: where the newest line's text is, and what the arrow covers. */
function measure([col, jump]) {
  const el = document.querySelector(col);
  if (!el || el.hidden) return { hidden: true };
  const box = el.getBoundingClientRect();
  const lines = [...el.querySelectorAll("[data-testid=debug-chat-line]")];
  const last = lines.at(-1);
  const textRects = (node) => {
    const out = [];
    const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent.trim()) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const q of r.getClientRects()) if (q.width > 0 && q.height > 0) out.push(q);
    }
    return out;
  };
  const lastRects = textRects(last);
  const lastBottom = Math.max(...lastRects.map((r) => r.bottom));
  let o = 1;
  for (let n = last; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
  const j = document.querySelector(jump)?.getBoundingClientRect() ?? null;
  const hit = (a, b) =>
    a.left < b.right - 0.5 &&
    b.left < a.right - 0.5 &&
    a.top < b.bottom - 0.5 &&
    b.top < a.bottom - 0.5;
  const inView = (r) => r.bottom > box.top + 1 && r.top < box.bottom - 1;
  const covered = [];
  if (j) {
    for (const line of lines)
      for (const r of textRects(line))
        if (inView(r) && hit(r, j)) covered.push(`text of ${line.dataset.msg}`);
    for (const b of el.querySelectorAll("[data-option]")) {
      const r = b.getBoundingClientRect();
      if (inView(r) && hit(r, j)) covered.push(`pill ${b.dataset.option}`);
    }
  }
  return {
    hidden: false,
    logH: Math.round(box.height),
    blank: Math.round(box.bottom - lastBottom),
    gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    opacity: Math.round(o * 100) / 100,
    jump: !!j,
    count: j ? Number(document.querySelector(jump).dataset.count) : 0,
    covered: [...new Set(covered)],
    from: last.dataset.from,
  };
}

async function run(engine, name, scheme, viewport) {
  const browser = await launchSilent(engine);
  const ctx = await newSilentContext(browser, {
    viewport,
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: name === "chromium",
    colorScheme: scheme,
  });
  await ctx.addInitScript((src) => {
    localStorage.setItem("lk:debug-widget-src", src);
    if (navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("refused in QA", "NotAllowedError");
      };
  }, `${ORIGIN}/debug-chat.js`);
  const page = await ctx.newPage();
  const tag = `${name} ${scheme} ${viewport.width}:`;
  const settle = () => page.waitForTimeout(350);
  const m = () => page.evaluate(measure, [COL, JUMP]);
  const push = (text, from = "agent") =>
    page.evaluate(([t, f]) => globalThis.__push(t, f), [text, from]);
  const ask = (id) => page.evaluate((a) => globalThis.__ask(a), askOf(id));
  const long = (i) => `#${i}# ${"一行比较长的回复，读出来要好几秒钟。".repeat(3)}`;
  const shot = (what) =>
    shots
      ? page.screenshot({ path: `${shots}/${name}-${scheme}-${viewport.width}-${what}.png` })
      : null;
  /** The newest line at the bottom, readable, and the arrow over nothing. */
  const atBottom = async (what) => {
    const s = await m();
    check(!s.hidden, `${tag} ${what}: the log shows`);
    if (s.hidden) return s;
    check(
      s.gap <= 2 && s.blank <= BLANK_MAX && s.blank >= 0,
      `${tag} ${what}: the newest line sits at the log's bottom`,
      JSON.stringify(s),
    );
    check(s.opacity >= 0.5, `${tag} ${what}: the newest line is readable`, JSON.stringify(s));
    check(s.covered.length === 0, `${tag} ${what}: the arrow covers nothing`, s.covered.join(", "));
    return s;
  };
  try {
    await page.goto(`${ORIGIN}/harness?open&nofrontier&notree`);
    await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 60_000 });
    await settle();

    await push(long(0));
    await settle();
    const rest = await atBottom("a new line at rest");
    await push("好的，收到。");
    await settle();
    await atBottom("a short new line at rest");
    await push("我这边看到最后一句了。", "owner");
    await settle();
    const own = await atBottom("the owner's own line");
    check(own.from === "owner", `${tag} the owner's line is the newest`, own.from);

    await ask("a1");
    for (let i = 1; i < 6; i++) await push(long(i));
    await settle();
    let s = await atBottom("an ask above, then new lines");
    check(s.jump && s.count === 1, `${tag} the arrow shows`, JSON.stringify(s));
    check(
      s.logH === rest.logH,
      `${tag} the resting log keeps its height (no row added)`,
      `${rest.logH} → ${s.logH}`,
    );
    await shot("arrow");

    await push("好。");
    await settle();
    await atBottom("an ask above, then one short line");
    await shot("short");

    await push("我的回答。", "owner");
    await settle();
    await atBottom("an ask above, then the owner's line");

    await ask("a2");
    await push(long(10));
    await ask("a3");
    for (let i = 11; i < 16; i++) await push(long(i));
    await settle();
    s = await atBottom("three asks above (the count)");
    check(s.count === 3, `${tag} the count is 3`, JSON.stringify(s));
    await shot("count");

    // The newest line an ask itself: its pills clear of the arrow.
    await ask("a4");
    await settle();
    s = await m();
    check(
      s.covered.length === 0,
      `${tag} the newest ask's pills: not covered`,
      s.covered.join(", "),
    );

    // Typing: the log is taller, the same rules.
    await push(long(20));
    await page.locator('[data-testid="debug-chat-input"]').focus();
    await settle();
    await push(long(21));
    await settle();
    await atBottom("typing, a new line");
    await shot("typing");
    await page.locator('[data-testid="debug-chat-input"]').blur();
    await page.waitForTimeout(500);
    await push(long(22));
    await settle();
    await atBottom("after the blur, a new line");
  } finally {
    await browser.close();
  }
}

try {
  for (const [engine, name] of [
    [webkit, "webkit"],
    [chromium, "chromium"],
  ])
    for (const viewport of [
      { width: 414, height: 848 },
      { width: 320, height: 568 },
    ])
      for (const scheme of ["light", "dark"]) await run(engine, name, scheme, viewport);
} catch (e) {
  failures.push(String(e));
  console.error(e);
} finally {
  server.kill();
}
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall ok");
process.exit(failures.length ? 1 : 0);

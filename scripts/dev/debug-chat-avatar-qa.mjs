#!/usr/bin/env bun
/**
 * Every run's avatar stays on its run's first line, the newest one included
 * (owner, 2026-11-09 13:42 JST, desktop /dev/users: the last message's avatar
 * sat away from its text). The cause: while the up-arrow to an open ask shows
 * (ask-above.ts jumpRoom), the newest run took `align-items: flex-end`, which
 * sent the avatar to a long run's LAST line. On the local /harness page with
 * the ETA bar, at desktop (1440×900, the panel and the docked sidebar) and
 * iPhone (390×844, the panel and full screen), light and dark, with the newest
 * run from Li and from the owner, short and long, with and without the arrow:
 *
 *   - the newest run's avatar top is its text's top, within 2 px
 *   - with the arrow's room, a short run still ends at its row's bottom
 *   - the avatar does not overlap the ETA bar
 *
 *   bun scripts/dev/debug-chat-avatar-qa.mjs [--shots <dir>]
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "../qa/silent.mjs";

const argv = process.argv.slice(2);
const shotsAt = argv.indexOf("--shots");
const SHOTS = shotsAt === -1 ? null : argv[shotsAt + 1];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const MIN = 60_000;

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

const FULL = '[data-testid="debug-chat-fullscreen"]';
const JUMP = '[data-testid="debug-chat-ask-jump"]';
const LONG = "a line long enough to wrap over several rows of the log, and on ".repeat(4);

/** The newest run: its avatar, its text column, the ETA bar. */
const measure = (page) =>
  page.evaluate(() => {
    const runs = document.querySelectorAll('[data-testid="debug-chat-run"]');
    const li = runs[runs.length - 1];
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    return {
      from: li.dataset.from,
      room: !!li.dataset.jumpRoom,
      li: box(li),
      avatar: box(li.children[0]),
      text: box(li.children[1]),
      bar: box(document.querySelector('[data-testid="debug-chat-eta-slot"]')),
    };
  });

async function run(vpName, vp, mode, scheme) {
  const browser = await launchSilent(chromium);
  const ctx = await newSilentContext(browser, {
    viewport: vp,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    hasTouch: vpName === "phone",
  });
  await ctx.addInitScript((src) => {
    localStorage.setItem("lk:debug-widget-src", src);
    if (navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("refused in QA", "NotAllowedError");
      };
  }, `${ORIGIN}/debug-chat.js`);
  const page = await ctx.newPage();
  const tag = `${vpName} ${mode} ${scheme}:`;
  try {
    await page.goto(`${ORIGIN}/harness?open&nofrontier&eta${mode === "panel" ? "" : "&full"}`);
    await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 60_000 });
    const now = await page.evaluate(() => Date.now());
    await page.evaluate(
      (t) => globalThis.__etaSet(t),
      [
        { id: "/a", title: "Native swipe", start: now - 10 * MIN, at: now + 15 * MIN },
        { id: "/b", title: "PDF import", start: now - 5 * MIN, at: now + 5 * MIN },
      ],
    );
    if (mode !== "panel") {
      await page.click(FULL, { timeout: 10_000 });
      await page.waitForTimeout(400);
    }
    const cases = [
      ["Li, short", "agent", "Short line from Li."],
      ["owner, long", "owner", LONG],
      ["Li, long", "agent", LONG],
      ["owner, short", "owner", "Mine, short."],
    ];
    for (const arrow of [false, true]) {
      if (arrow) {
        // An open ask, then enough lines to push it off above: the up-arrow shows.
        await page.evaluate(() =>
          globalThis.__ask({
            askId: "q1",
            questions: [
              {
                id: "q",
                question: "Ship it?",
                options: [
                  { id: "y", label: "Yes", recommended: true },
                  { id: "n", label: "No" },
                ],
              },
            ],
          }),
        );
        for (let i = 0; i < 30; i++)
          await page.evaluate(
            (i) =>
              globalThis.__push(
                `#${i} ${"a line of the chat that takes some room ".repeat(2)}`,
                i % 2 ? "agent" : "owner",
              ),
            i,
          );
        await page.waitForTimeout(500);
        check((await page.locator(JUMP).count()) === 1, `${tag} the up-arrow shows`);
      }
      for (const [name, from, text] of cases) {
        // A line from the other side first, so this one starts its own run.
        await page.evaluate(
          ([f, t]) => {
            globalThis.__push("—", f === "agent" ? "owner" : "agent");
            globalThis.__push(t, f);
          },
          [from, text],
        );
        await page.waitForTimeout(450);
        const m = await measure(page);
        const what = `${tag} ${arrow ? "arrow, " : ""}newest run ${name}`;
        check(m.from === from, `${what}: is the newest run`, m.from);
        check(m.room === arrow, `${what}: ${arrow ? "keeps" : "no"} room for the arrow`);
        const dy = Math.abs(m.avatar.top - m.text.top);
        check(dy <= 2, `${what}: avatar on its first line`, `${dy.toFixed(1)} px apart`);
        if (arrow)
          check(
            Math.abs(m.text.bottom - m.li.bottom) <= 2,
            `${what}: the run ends at its row's bottom`,
            `${(m.li.bottom - m.text.bottom).toFixed(1)} px blank under it`,
          );
        if (m.bar)
          check(
            m.avatar.bottom <= m.bar.top + 0.5 || m.avatar.top >= m.bar.bottom - 0.5,
            `${what}: avatar clear of the ETA bar`,
            `avatar ${m.avatar.top}–${m.avatar.bottom}, bar ${m.bar.top}–${m.bar.bottom}`,
          );
        if (SHOTS && /long/.test(name))
          await page.screenshot({
            path: join(SHOTS, `${vpName}-${mode}-${scheme}-${arrow ? "arrow-" : ""}${from}.png`),
          });
      }
    }
  } catch (e) {
    check(false, `${tag} ran`, String(e?.message ?? e).split("\n")[0]);
  } finally {
    await browser.close();
  }
}

try {
  for (const [vpName, vp, full] of [
    ["desktop", { width: 1440, height: 900 }, "sidebar"],
    ["phone", { width: 390, height: 844 }, "full"],
  ])
    for (const mode of ["panel", full])
      for (const scheme of ["light", "dark"]) await run(vpName, vp, mode, scheme);
} finally {
  server.kill();
}
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall ok");
process.exit(failures.length ? 1 : 0);

#!/usr/bin/env bun
/**
 * Browser checks for the full-screen Gantt (packages/debug-chat/src/GanttFull.tsx,
 * gantt-view.ts) on the local /harness page (`?eta`), with a fake clock, 10
 * open timed tasks (running, overdue, queued, one long) and 22 done (history), at
 * 1440×900, 1512×770 and 390×844 (iPhone), light and dark:
 *
 *   - a tap on the ETA bar opens it; the panel fills the viewport
 *   - the red Now line is in view on open, about a quarter from the left
 *   - no horizontal page scroll (the timeline scrolls inside its own box)
 *   - after a vertical scroll the axis header is still at the top
 *   - after scrolling sideways both ways, every row's name is inside the view
 *   - scrolling far left grows the axis (the view's time stays put); the DOM stays bounded
 *   - ctrl+wheel (a trackpad pinch) zooms about the pointer; the ticks re-label
 *   - the Now button brings Now back; Escape closes
 *
 * The logarithmic axis (the default; owner, 2026-11-09 15:27 JST) first:
 *
 *   - it opens on the log axis; Now in view, a third from the left
 *   - minute and day tasks on one screen: the 9H estimate in view, a 10-minute
 *     task still a readable width
 *   - the tick labels never overlap (their boxes), on open, panned and zoomed
 *   - after scrolling sideways both ways, every row's name is inside the view
 *   - ctrl+wheel / a pinch zooms about the pointer, the page itself never
 *   - the Linear toggle switches to the linear axis (the checks above), and
 *     the choice is remembered when the Gantt opens again
 *
 *   bun scripts/dev/debug-chat-gantt-qa.mjs [--shots <dir>] [--before]
 *
 * `--before` only takes the screenshots of the old inline list (the tree panel)
 * for a before/after comparison; it checks nothing.
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
const BEFORE = argv.includes("--before");
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-09T05:30:00Z");

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
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

/** Twelve tasks: running, overdue, one long, queued (four), done history (two). */
const TASKS = [
  {
    id: "/box/eta",
    title: "Box ETA: the bar on the owner's box, all day",
    start: T0 - 3 * HOUR,
    at: T0 + 9 * HOUR,
    pct: 30,
  },
  {
    id: "/chat/fill",
    title: "Fill line: the line's own background",
    start: T0 - 50 * MIN,
    at: T0 - 10 * MIN,
    pct: 90,
  },
  {
    id: "/chat/avatar",
    title: "Avatar fix: 最新一行的头像留在第一行",
    start: T0 - 2 * HOUR,
    at: T0 - HOUR,
    pct: 80,
  },
  { id: "/words/swipe", title: "Native swipe", start: T0 - 20 * MIN, at: T0 + 25 * MIN, pct: 40 },
  {
    id: "/read/pdf",
    title: "PDF import: pages to read/ texts, with the OCR fallback",
    start: T0 - 10 * MIN,
    at: T0 + 40 * MIN,
    pct: 20,
  },
  { id: "/dev/users", title: "Files column", start: T0 - 30 * MIN, at: T0 + 15 * MIN, pct: 60 },
  ...[0, 1, 2, 3].map((i) => ({
    id: `/queue/q${i}`,
    title: `Queued ${i + 1}: waiting for an agent slot`,
    start: T0,
    at: T0 + (i + 1) * 30 * MIN,
    queued: true,
    created: T0 - (10 - i) * MIN,
    queuedMs: (i + 1) * 30 * MIN,
  })),
  {
    id: "/done/recent",
    title: "Gift codes: done a moment ago",
    start: T0 - 90 * MIN,
    at: T0 - 20 * MIN,
    done: true,
    doneAt: T0 - 15 * MIN,
  },
  {
    id: "/done/old",
    title: "Permissions step c",
    start: T0 - 7 * HOUR,
    at: T0 - 5 * HOUR,
    done: true,
    doneAt: T0 - 5 * HOUR,
  },
  // History: twenty done tasks over the past days (rows enough to scroll vertically).
  ...Array.from({ length: 20 }, (_, i) => ({
    id: `/done/h${i}`,
    title: `History ${i + 1}: finished ${i + 6} hours ago`,
    start: T0 - (i + 8) * HOUR,
    at: T0 - (i + 6) * HOUR,
    done: true,
    doneAt: T0 - (i + 6) * HOUR,
  })),
];

const VIEWS = [
  { name: "1440x900", width: 1440, height: 900, touch: false },
  { name: "1512x770", width: 1512, height: 770, touch: false },
  { name: "iphone", width: 390, height: 844, touch: true },
];

const browser = await launchSilent(chromium);
try {
  for (const v of VIEWS)
    for (const scheme of ["light", "dark"]) {
      const tag = `${v.name} ${scheme}`;
      const ctx = await newSilentContext(browser, {
        viewport: { width: v.width, height: v.height },
        deviceScaleFactor: 2,
        colorScheme: scheme,
        hasTouch: v.touch,
        isMobile: v.touch,
      });
      await ctx.addInitScript((src) => {
        localStorage.setItem("lk:debug-widget-src", src);
        if (navigator.mediaDevices)
          navigator.mediaDevices.getUserMedia = async () => {
            throw new DOMException("refused in QA", "NotAllowedError");
          };
      }, `${ORIGIN}/debug-chat.js`);
      const page = await ctx.newPage();
      await page.clock.install({ time: T0 });
      await page.goto(`${ORIGIN}/harness?open&nofrontier&eta`);
      await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
      await page.evaluate((t) => globalThis.__etaSet(t), TASKS);
      await page.clock.runFor(300);
      const bar = page.locator('[data-testid="debug-chat-eta-bar"]');
      await bar.click();
      await page.clock.runFor(400);
      await page.waitForTimeout(500);
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      const shot = async (what) => {
        if (SHOTS)
          await page.screenshot({ path: join(SHOTS, `gantt-${what}-${v.name}-${scheme}.png`) });
      };
      if (BEFORE) {
        await shot("before");
        await ctx.close();
        continue;
      }
      const dlg = page.locator('[data-testid="debug-chat-gantt"]');
      check(await dlg.isVisible(), `${tag}: the bar opens the full-screen Gantt`);
      const box = await dlg.boundingBox();
      check(
        !!box &&
          Math.abs(box.x) < 1 &&
          Math.abs(box.y) < 1 &&
          Math.abs(box.width - v.width) < 1 &&
          Math.abs(box.height - v.height) < 1,
        `${tag}: the panel fills the viewport (${JSON.stringify(box)})`,
      );
      const rows = page.locator('[data-testid="debug-chat-gantt-row"]');
      check((await rows.count()) === TASKS.length, `${tag}: ${await rows.count()} rows`);
      const states = await rows.evaluateAll((els) => els.map((e) => e.dataset.state));
      check(
        states.includes("queued") && states.includes("reached") && states.includes("done"),
        `${tag}: running, overdue, queued and done rows (${states.join(",")})`,
      );
      const late = await page
        .locator('[data-testid="debug-chat-gantt-time"][data-late]')
        .allInnerTexts();
      check(
        late.length >= 2 && late.every((t) => t.startsWith("-")),
        `${tag}: overdue times negative (${late.join(" ")})`,
      );
      const geo = () =>
        page.evaluate(() => {
          const sc = document.querySelector('[data-testid="debug-chat-gantt-scroll"]');
          const r = sc.getBoundingClientRect();
          const now = document.querySelector('[data-testid="debug-chat-gantt-now"]');
          const axis = document.querySelector('[data-testid="debug-chat-gantt-axis"]');
          const names = [...document.querySelectorAll('[data-testid="debug-chat-gantt-name"]')].map(
            (n) => n.getBoundingClientRect(),
          );
          return {
            sc: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
            scrollLeft: sc.scrollLeft,
            scrollTop: sc.scrollTop,
            scrollWidth: sc.scrollWidth,
            scrollHeight: sc.scrollHeight,
            clientHeight: sc.clientHeight,
            nowX: now.getBoundingClientRect().left,
            axisTop: axis.getBoundingClientRect().top,
            names: names.map((n) => ({ l: n.left, r: n.right })),
            pageW: document.documentElement.scrollWidth,
            nodes: sc.querySelectorAll("*").length,
            ticks: [...document.querySelectorAll('[data-testid="debug-chat-gantt-tick"]')].map(
              (t) => t.textContent,
            ),
            // Every axis label in view, left to right, with its box.
            labels: [
              ...document.querySelectorAll(
                '[data-testid="debug-chat-gantt-axis"] [data-testid^="debug-chat-gantt-"]',
              ),
            ]
              .map((t) => {
                const b = t.getBoundingClientRect();
                return { text: t.textContent, l: b.left, r: b.right };
              })
              .filter((b) => b.r > r.left && b.l < r.right)
              .sort((a, b) => a.l - b.l),
            scale: document.querySelector('[data-testid="debug-chat-gantt-content"]')?.dataset
              .scale,
          };
        });
      /** No two axis labels overlap (their rendered boxes). */
      const apart = (gg) => {
        for (let i = 1; i < gg.labels.length; i++)
          if (gg.labels[i].l < gg.labels[i - 1].r) return false;
        return true;
      };
      const scroller = page.locator('[data-testid="debug-chat-gantt-scroll"]');
      const namesIn = (gg) =>
        gg.names.every((n) => n.l >= gg.sc.left - 1 && n.r <= gg.sc.right + 1);
      const barOf = (id) =>
        page.evaluate((i) => {
          const b = document
            .querySelector(
              `[data-testid="debug-chat-gantt-row"][data-id="${i}"] [data-testid="debug-chat-gantt-bar"]`,
            )
            .getBoundingClientRect();
          return { l: b.left, r: b.right, w: b.width };
        }, id);

      // The logarithmic axis, the default.
      {
        let g = await geo();
        check(g.scale === "log", `${tag}: opens on the log axis (${g.scale})`);
        const third = g.sc.left + (g.sc.right - g.sc.left) / 3;
        check(
          g.nowX >= g.sc.left && g.nowX <= g.sc.right && Math.abs(g.nowX - third) < 4,
          `${tag} log: Now in view, a third from the left (${Math.round(g.nowX)} vs ${Math.round(third)})`,
        );
        check(g.pageW <= v.width, `${tag} log: no horizontal page scroll (${g.pageW})`);
        check(namesIn(g), `${tag} log: every name in view on open`);
        check(
          apart(g) && g.labels.length >= 5,
          `${tag} log: ${g.labels.length} tick labels, none overlapping (${g.labels.map((l) => l.text).join(" ")})`,
        );
        const long = await barOf("/box/eta");
        const short = await barOf("/dev/users");
        check(
          long.r <= g.sc.right + 1 && long.l >= g.sc.left - 1,
          `${tag} log: the 12-hour task fits the screen (${Math.round(long.l)}–${Math.round(long.r)})`,
        );
        check(
          short.w >= 30,
          `${tag} log: a 45-minute task stays readable (${Math.round(short.w)} px)`,
        );
        await shot("log-open");
        for (const dx of [-600, 1500, -900]) {
          await scroller.evaluate((el, d) => (el.scrollLeft += d), dx);
          await page.waitForTimeout(120);
          g = await geo();
          check(namesIn(g), `${tag} log: after scrolling ${dx} px every name is in view`);
          check(apart(g), `${tag} log: after scrolling ${dx} px no tick labels overlap`);
        }
        await page.locator('[data-testid="debug-chat-gantt-now-btn"]').click();
        await page.waitForTimeout(150);
        g = await geo();
        check(
          Math.abs(g.nowX - third) < 4,
          `${tag} log: the Now button brings Now back (${Math.round(g.nowX)})`,
        );
        const ticks0 = g.labels.map((l) => l.text).join(" ");
        if (!v.touch) {
          await page.mouse.move(Math.round(g.nowX), 300);
          await page.keyboard.down("Control");
          for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -60);
          await page.keyboard.up("Control");
          await page.waitForTimeout(200);
          g = await geo();
          check(
            Math.abs(g.nowX - third) < 3,
            `${tag} log: zoom keeps Now under the pointer (${g.nowX} vs ${third})`,
          );
        } else {
          const cdp = await ctx.newCDPSession(page);
          const cx = Math.round(g.nowX);
          const pts = (d) => [
            { x: cx - d, y: 400 },
            { x: cx + d, y: 400 },
          ];
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(20) });
          for (const d of [30, 40, 50, 60])
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d) });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await page.waitForTimeout(200);
          g = await geo();
          const scale = await page.evaluate(() => visualViewport?.scale ?? 1);
          check(scale === 1, `${tag} log: the page itself did not zoom (${scale})`);
          check(
            Math.abs(g.nowX - cx) < 4,
            `${tag} log: pinch keeps Now under the fingers (${g.nowX} vs ${cx})`,
          );
        }
        check(
          g.labels.map((l) => l.text).join(" ") !== ticks0,
          `${tag} log: the axis re-ticks after a zoom (${g.labels.map((l) => l.text).join(" ")})`,
        );
        check(apart(g), `${tag} log: zoomed in, no tick labels overlap`);
        await shot("log-zoomed-in");

        // Switch to the linear axis: the checks below run on it.
        await page.locator('[data-testid="debug-chat-gantt-scale-linear"]').click();
        await page.waitForTimeout(250);
        g = await geo();
        check(g.scale === "linear", `${tag}: the toggle switches to the linear axis (${g.scale})`);
        check(apart(g), `${tag} linear: no tick labels overlap`);
      }

      let g = await geo();
      const quarter = g.sc.left + 0.25 * (g.sc.right - g.sc.left);
      check(
        g.nowX >= g.sc.left && g.nowX <= g.sc.right && Math.abs(g.nowX - quarter) < 4,
        `${tag}: Now in view, a quarter from the left (${Math.round(g.nowX)} vs ${Math.round(quarter)})`,
      );
      check(g.pageW <= v.width, `${tag}: no horizontal page scroll (${g.pageW})`);
      check(g.scrollWidth > g.sc.right - g.sc.left, `${tag}: the timeline scrolls sideways`);
      await shot("open");

      // Vertical: the axis stays at the top.
      await scroller.evaluate((el) => (el.scrollTop = 10_000));
      await page.waitForTimeout(100);
      g = await geo();
      check(g.scrollTop > 0, `${tag}: the rows scroll vertically (${g.scrollTop})`);
      check(
        Math.abs(g.axisTop - g.sc.top) < 1.5,
        `${tag}: axis header at the top after a vertical scroll (axis ${g.axisTop}, top ${g.sc.top}, scrollTop ${g.scrollTop}/${g.scrollHeight - g.clientHeight})`,
      );
      if (v.touch) await shot("scrolled-down");
      await scroller.evaluate((el) => (el.scrollTop = 0));

      // Sideways both ways: every name stays inside the view.
      for (const dx of [-2500, 6000, -1500]) {
        await scroller.evaluate((el, d) => (el.scrollLeft += d), dx);
        await page.waitForTimeout(120);
        g = await geo();
        check(namesIn(g), `${tag}: after scrolling ${dx} px every name is in view`);
      }
      await shot("panned");

      // Far left: the axis grows, the time under the view stays, the DOM stays bounded.
      const before = await geo();
      for (let i = 0; i < 12; i++) {
        await scroller.evaluate((el) => (el.scrollLeft = 0));
        await page.waitForTimeout(60);
      }
      g = await geo();
      check(g.scrollLeft > 0, `${tag}: the axis grew to the left (scrollLeft ${g.scrollLeft})`);
      check(
        g.nodes < before.nodes + 200,
        `${tag}: the DOM stays bounded (${before.nodes} → ${g.nodes} nodes)`,
      );
      check(namesIn(g), `${tag}: far in the past, every name is in view`);

      // Now button.
      await page.locator('[data-testid="debug-chat-gantt-now-btn"]').click();
      await page.waitForTimeout(150);
      g = await geo();
      check(
        g.nowX >= g.sc.left && g.nowX <= g.sc.right,
        `${tag}: the Now button brings Now back (${Math.round(g.nowX)})`,
      );

      // Zoom about the pointer (desktop: ctrl+wheel, a trackpad pinch).
      if (!v.touch) {
        const ticks0 = g.ticks.join(" ");
        const ax = Math.round(g.nowX);
        await page.mouse.move(ax, 300);
        await page.keyboard.down("Control");
        for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 60);
        await page.keyboard.up("Control");
        await page.waitForTimeout(200);
        g = await geo();
        check(
          Math.abs(g.nowX - ax) < 3,
          `${tag}: zoom keeps Now under the pointer (${g.nowX} vs ${ax})`,
        );
        check(
          g.ticks.join(" ") !== ticks0,
          `${tag}: the axis re-ticks (${g.ticks.slice(0, 6).join(" ")})`,
        );
        check(apart(g), `${tag}: zoomed out, no tick labels overlap`);
        await shot("zoomed-out");
      } else {
        // Touch pinch, synthesized: two fingers apart then together.
        const cdp = await ctx.newCDPSession(page);
        const cx = Math.round(g.nowX);
        const y = 400;
        const pts = (d) => [
          { x: cx - d, y },
          { x: cx + d, y },
        ];
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(60) });
        for (const d of [50, 40, 30, 20])
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d) });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(200);
        const z = await geo();
        const scale = await page.evaluate(() => visualViewport?.scale ?? 1);
        check(scale === 1, `${tag}: the page itself did not zoom (${scale})`);
        check(
          Math.abs(z.nowX - cx) < 4,
          `${tag}: pinch keeps Now under the fingers (${z.nowX} vs ${cx})`,
        );
        check(z.ticks.join(" ") !== g.ticks.join(" "), `${tag}: the axis re-ticks after a pinch`);
        await shot("pinched");
      }

      // Escape closes.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      check(!(await dlg.isVisible()), `${tag}: Escape closes`);
      // Open again: the linear axis was remembered (this device).
      await bar.click();
      await page.waitForTimeout(300);
      check(
        (await geo()).scale === "linear",
        `${tag}: the axis choice is remembered when it opens again`,
      );
      await page.keyboard.press("Escape");
      await ctx.close();
    }
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(BEFORE ? "before screenshots taken" : "all Gantt checks passed");

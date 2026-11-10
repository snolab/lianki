#!/usr/bin/env bun
/**
 * Browser checks for the full-screen Gantt (packages/debug-chat/src/GanttFull.tsx,
 * gantt-view.ts) on the local /harness page (`?eta`), with a fake clock, 10
 * open timed tasks (running, overdue, queued, one long) and 22 done (history), at
 * 1440×900, 1512×770 and 390×844 (iPhone), light and dark:
 *
 *   - a tap on the ETA bar opens it; the panel fills the viewport
 *   - the red Now line is at the horizontal centre on open (owner, 2026-11-10),
 *     and the open task closest to ending is at the vertical centre
 *   - no horizontal page scroll (the timeline scrolls inside its own box)
 *   - after a vertical scroll the axis header is still at the top
 *   - after scrolling sideways both ways, every row's name is inside the view
 *   - scrolling far left grows the axis (the view's time stays put); the DOM stays bounded
 *   - ctrl+wheel (a trackpad pinch) zooms about the pointer; the ticks re-label
 *   - the Now button brings Now back; Escape closes
 *
 * Categories first (owner, 2026-11-10 23:13; gantt-groups.ts), on open:
 *
 *   - one row per category, all folded; every task a slice on its row;
 *     overlapping slices in lanes stacked by the data (chat: two); a ▸
 *     <button> with aria-expanded and a label on each; slices keep their states,
 *     underlines and overruns; the focus task's category centred
 *   - a tap on a slice opens its category and centres that task's row; ▾ folds
 *     it back; then every category is opened and the checks below run on the
 *     task rows; the open set is kept when the Gantt opens again
 *
 * The logarithmic axis (the default; owner, 2026-11-09 15:27 JST) first:
 *
 *   - it opens on the log axis; Now at the horizontal centre
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

/**
 * The categories those tasks fall into (packages/debug-chat/src/gantt-groups.json):
 * /chat/* chat, /words words, /read import, /dev ui, the rest the fallback (arch).
 */
const GROUPS = ["chat", "words", "import", "ui", "arch"];

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
      // Categories (owner, 2026-11-10 23:13): folded by default, one row each,
      // every child's bar on it in lanes; tap a slice → its row; ▸/▾ toggles.
      const groupsAt = page.locator('[data-testid="debug-chat-gantt-group"]');
      const toggles = page.locator('[data-testid="debug-chat-gantt-toggle"]');
      const slices = page.locator('[data-testid="debug-chat-gantt-slice"]');
      const gInfo = () =>
        groupsAt.evaluateAll((els) =>
          els.map((e) => ({
            id: e.dataset.id,
            open: e.dataset.open === "true",
            lanes: Number(e.dataset.lanes),
            count: Number(e.dataset.count),
          })),
        );
      let gs = await gInfo();
      check(
        gs.length === GROUPS.length && GROUPS.every((id) => gs.some((x) => x.id === id)),
        `${tag}: one row per category (${gs.map((x) => x.id).join(",")})`,
      );
      check(
        gs.every((x) => !x.open) && (await rows.count()) === 0,
        `${tag}: every category folded by default, no task rows`,
      );
      check(
        gs.reduce((n, x) => n + x.count, 0) === TASKS.length &&
          (await slices.count()) === TASKS.length,
        `${tag}: every task is a slice on its category's row (${await slices.count()})`,
      );
      const chatG = gs.find((x) => x.id === "chat");
      check(
        chatG?.lanes === 2,
        `${tag}: two overlapping chat tasks take two lanes (${chatG?.lanes})`,
      );
      check(
        gs.find((x) => x.id === "words")?.lanes === 1,
        `${tag}: a category with one task has one lane`,
      );
      const tg = await toggles.evaluateAll((els) =>
        els.map((e) => ({
          tag: e.tagName,
          exp: e.getAttribute("aria-expanded"),
          label: e.getAttribute("aria-label") ?? "",
          left: e.getBoundingClientRect().left,
          h: e.getBoundingClientRect().height,
        })),
      );
      check(
        tg.length === GROUPS.length &&
          tg.every((x) => x.tag === "BUTTON" && x.exp === "false" && x.label.length > 3),
        `${tag}: each category has a ▸ button with aria-expanded and a label`,
      );
      // Slices keep their own looks: states, underlines, the overdue red overrun.
      const sStates = await slices.evaluateAll((els) => els.map((e) => e.dataset.state));
      check(
        sStates.includes("queued") && sStates.includes("reached") && sStates.includes("done"),
        `${tag}: slices keep running, overdue, queued and done (${[...new Set(sStates)].join(",")})`,
      );
      check(
        (await page.locator('[data-testid="debug-chat-gantt-slice-progress"]').count()) > 0 &&
          (await page.locator('[data-testid="debug-chat-gantt-slice-over"]').count()) > 0,
        `${tag}: slices keep their progress underline and overrun`,
      );
      // Lanes from the data: slices on different lanes of one row sit at different heights.
      const laneTops = await page.evaluate(() => {
        const g = document.querySelector('[data-testid="debug-chat-gantt-group"][data-id="chat"]');
        return [...g.querySelectorAll('[data-testid="debug-chat-gantt-slice"]')].map((s) => ({
          lane: s.dataset.lane,
          top: Math.round(s.getBoundingClientRect().top),
        }));
      });
      check(
        new Set(laneTops.map((x) => x.lane)).size === 2 &&
          new Set(laneTops.map((x) => x.top)).size === 2,
        `${tag}: the chat row's two lanes are stacked (${JSON.stringify(laneTops)})`,
      );
      // The category of the task closest to ending (/dev/users, in "ui") at the vertical centre.
      const centred = (sel) =>
        page.evaluate((s) => {
          const sc = document
            .querySelector('[data-testid="debug-chat-gantt-scroll"]')
            .getBoundingClientRect();
          const axis = document
            .querySelector('[data-testid="debug-chat-gantt-axis"]')
            .getBoundingClientRect();
          const row = document.querySelector(s).getBoundingClientRect();
          return { mid: (row.top + row.bottom) / 2, view: (axis.bottom + sc.bottom) / 2 };
        }, sel);
      let fc = await centred('[data-testid="debug-chat-gantt-group"][data-id="ui"]');
      check(
        Math.abs(fc.mid - fc.view) < 20,
        `${tag}: folded, the category of the task closest to ending is centred (${Math.round(fc.mid)} vs ${Math.round(fc.view)})`,
      );
      await shot("groups-folded");
      // Tap a slice: its category opens and that task's row is centred, marked.
      const devSlice = slices.and(page.locator('[data-id="/dev/users"]'));
      const sb = await devSlice.boundingBox();
      await devSlice.click({ position: { x: Math.max(1, sb.width - 3), y: sb.height / 2 } });
      await page.waitForTimeout(150);
      gs = await gInfo();
      check(gs.find((x) => x.id === "ui")?.open, `${tag}: a tapped slice opens its category`);
      const picked = page.locator('[data-testid="debug-chat-gantt-row"][data-id="/dev/users"]');
      check(
        (await picked.count()) === 1 && (await picked.getAttribute("data-picked")) === "true",
        `${tag}: the tapped task has its own row, marked`,
      );
      fc = await centred('[data-testid="debug-chat-gantt-row"][data-id="/dev/users"]');
      check(
        Math.abs(fc.mid - fc.view) < 20,
        `${tag}: the tapped task's row is centred (${Math.round(fc.mid)} vs ${Math.round(fc.view)})`,
      );
      check(
        (await page
          .locator(
            '[data-testid="debug-chat-gantt-group"][data-id="ui"] [data-testid="debug-chat-gantt-toggle"]',
          )
          .getAttribute("aria-expanded")) === "true",
        `${tag}: its ▾ says expanded`,
      );
      // ▾ folds it back.
      await page
        .locator(
          '[data-testid="debug-chat-gantt-group"][data-id="ui"] [data-testid="debug-chat-gantt-toggle"]',
        )
        .click();
      await page.waitForTimeout(100);
      check((await rows.count()) === 0, `${tag}: ▾ folds the category back onto its row`);
      // Open them all: each task its own row again, the checks below run on them.
      for (const id of GROUPS)
        await page
          .locator(
            `[data-testid="debug-chat-gantt-group"][data-id="${id}"] [data-testid="debug-chat-gantt-toggle"]`,
          )
          .click();
      await page.waitForTimeout(150);
      check((await rows.count()) === TASKS.length, `${tag}: all open, ${await rows.count()} rows`);
      check(
        (await toggles.evaluateAll((els) => els.map((e) => e.getAttribute("aria-expanded")))).every(
          (x) => x === "true",
        ),
        `${tag}: every ▾ says expanded`,
      );
      await shot("groups-open");
      const states = await rows.evaluateAll((els) => els.map((e) => e.dataset.state));
      check(
        states.includes("queued") && states.includes("reached") && states.includes("done"),
        `${tag}: running, overdue, queued and done rows (${states.join(",")})`,
      );
      const late = await page
        .locator(
          '[data-testid="debug-chat-gantt-row"] [data-testid="debug-chat-gantt-time"][data-late]',
        )
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
        const third = g.sc.left + (g.sc.right - g.sc.left) / 2;
        check(
          g.nowX >= g.sc.left && g.nowX <= g.sc.right && Math.abs(g.nowX - third) < 4,
          `${tag} log: Now at the centre (${Math.round(g.nowX)} vs ${Math.round(third)})`,
        );
        // All open, the Now button goes home: the open task closest to ending
        // (/dev/users, due in 15 min), now its own row, at the vertical centre.
        await page.locator('[data-testid="debug-chat-gantt-now-btn"]').click();
        await page.waitForTimeout(150);
        g = await geo();
        const focus = await page.evaluate(() => {
          const sc = document
            .querySelector('[data-testid="debug-chat-gantt-scroll"]')
            .getBoundingClientRect();
          const axis = document
            .querySelector('[data-testid="debug-chat-gantt-axis"]')
            .getBoundingClientRect();
          const row = document
            .querySelector('[data-testid="debug-chat-gantt-row"][data-id="/dev/users"]')
            .getBoundingClientRect();
          return { mid: (row.top + row.bottom) / 2, view: (axis.bottom + sc.bottom) / 2 };
        });
        check(
          Math.abs(focus.mid - focus.view) < 20,
          `${tag} log: the task closest to ending is centred (${Math.round(focus.mid)} vs ${Math.round(focus.view)})`,
        );
        // Rows by end time, expected or actual: within a category, and the categories by their last end.
        const ends = await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid="debug-chat-gantt-row"]')].map(
            (e) => e.dataset.id,
          ),
        );
        check(
          ends.indexOf("/done/old") < ends.indexOf("/queue/q0") &&
            ends.indexOf("/queue/q0") < ends.indexOf("/box/eta") &&
            ends.indexOf("/chat/avatar") < ends.indexOf("/chat/fill"),
          `${tag}: rows sorted by end time within a category`,
        );
        const order = (await gInfo()).map((x) => x.id);
        check(
          order.indexOf("chat") < order.indexOf("ui") &&
            order.indexOf("ui") < order.indexOf("arch"),
          `${tag}: categories sorted by their last end (${order.join(",")})`,
        );
        check(g.pageW <= v.width, `${tag} log: no horizontal page scroll (${g.pageW})`);
        check(namesIn(g), `${tag} log: every name in view on open`);
        check(
          apart(g) && g.labels.length >= 5,
          `${tag} log: ${g.labels.length} tick labels, none overlapping (${g.labels.map((l) => l.text).join(" ")})`,
        );
        const short = await barOf("/dev/users");
        check(
          short.r <= g.sc.right + 1 && short.l >= g.sc.left - 1,
          `${tag} log: the centred task's bar is on screen (${Math.round(short.l)}–${Math.round(short.r)})`,
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
          // Off Now, the midpoint moving (owner, 2026-11-10: "the time under the
          // fingers jumps"): the line under the fingers' midpoint follows it.
          // nowX is the line's left edge; the line is 2 px wide: its centre is the time.
          const mx = g.nowX + 1;
          const mpts = (d, m) => [
            { x: m - d, y: 420 },
            { x: m + d, y: 420 },
          ];
          // The Now line moves with the time it marks: start the pinch on a point
          // a known distance from it, then check that distance's time stays put
          // by pinching ON the Now line after a midpoint drift.
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: mpts(20, mx),
          });
          for (const [d, dm] of [
            [28, 8],
            [36, 16],
            [44, 24],
            [52, 32],
          ])
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: mpts(d, mx + dm),
            });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await page.waitForTimeout(250);
          g = await geo();
          check(
            Math.abs(g.nowX + 1 - (mx + 32)) <= 1,
            `${tag} log: a pinch whose midpoint drifts keeps Now under it (${g.nowX + 1} vs ${mx + 32})`,
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
      const quarter = g.sc.left + 0.5 * (g.sc.right - g.sc.left);
      check(
        g.nowX >= g.sc.left && g.nowX <= g.sc.right && Math.abs(g.nowX - quarter) < 4,
        `${tag}: Now at the centre (${Math.round(g.nowX)} vs ${Math.round(quarter)})`,
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
        // Linear too: a pinch whose midpoint drifts keeps the time under it.
        // The line's centre (nowX is its left edge, 2 px wide): the time under the fingers.
        const m0 = z.nowX + 1;
        const dpts = (d, m) => [
          { x: m - d, y: 420 },
          { x: m + d, y: 420 },
        ];
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: dpts(20, m0),
        });
        for (const [d, dm] of [
          [28, -6],
          [40, -14],
          [55, -22],
          [70, -30],
        ])
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: dpts(d, m0 + dm),
          });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(250);
        const z2 = await geo();
        check(
          Math.abs(z2.nowX + 1 - (m0 - 30)) <= 1,
          `${tag}: a pinch whose midpoint drifts keeps Now under it (${z2.nowX + 1} vs ${m0 - 30})`,
        );
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
      // And the open categories (session UI state, this tab).
      check(
        (await gInfo()).every((x) => x.open),
        `${tag}: the open categories are kept when it opens again`,
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

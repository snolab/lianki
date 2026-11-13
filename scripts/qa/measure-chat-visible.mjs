#!/usr/bin/env bun
// "Chat visible": how long after navigation the Learning Partner chat shows on
// a page load, and when the hub's history is in it (docs/cold-start.md, "The
// chat at once"). A measurement, not a pass/fail suite.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/measure-chat-visible.mjs [runs]
//
// A throwaway local account (dev email+password auth), debug mode on (the
// chat's gate), an iPhone viewport and a 4x CPU throttle (CDP). The hub is a
// stand-in WebSocket defined in the page (no lianki-push locally): it opens
// OPEN_MS after it is made and sends the history HUB_MS after that, so the
// numbers include a hub that is not instant. The first load of each context
// fills the device's copy; the next `runs` loads are measured.
//
// Points (ms from navigation start): FCP; chat = `[data-debug-chat]` in the
// page; hub = the newest hub line's text in it, no longer marked data-cached;
// cached = how many lines the chat showed when it first appeared.
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const RUNS = Number(process.argv[2] || 10);
const OPEN_MS = Number(process.env.OPEN_MS || 600);
const HUB_MS = Number(process.env.HUB_MS || 300);
const CPU = Number(process.env.CPU || 4);
const PATH = process.env.QA_PATH || "/home";
const NOCACHE = process.env.NOCACHE === "1";
const PW = "qa-test-pass-1234";

const HISTORY = Array.from({ length: 40 }, (_, i) => ({
  id: `m${i + 1}`,
  from: i % 2 ? "agent" : "friend",
  label: "",
  text: i === 39 ? "hub-newest-line" : `line ${i + 1}`,
  at: 1_700_000_000_000 + i * 1000,
}));

/** The hub stand-in, and the marks, before any page script runs. */
const INIT = `(() => {
  try { localStorage.setItem("lk:debug", "1"); localStorage.setItem("lk:agent", "1"); } catch {}
  const Real = window.WebSocket;
  const history = ${JSON.stringify(HISTORY)};
  class Hub {
    constructor(url) {
      this.url = String(url); this.readyState = 0; this.protocol = "";
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      setTimeout(() => {
        this.readyState = 1; this.onopen?.({});
        setTimeout(() => {
          this.onmessage?.({ data: JSON.stringify({ type: "friend-status", status: "open" }) });
          this.onmessage?.({ data: JSON.stringify({ type: "history", messages: history }) });
        }, ${HUB_MS});
      }, ${OPEN_MS});
    }
    send() {}
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code: 1000 }); }
    addEventListener() {} removeEventListener() {}
  }
  Hub.OPEN = 1; Hub.CONNECTING = 0; Hub.CLOSING = 2; Hub.CLOSED = 3;
  window.WebSocket = new Proxy(Real, {
    construct(T, args) { return /\\/api\\/version\\/debug/.test(String(args[0])) ? new Hub(args[0]) : new T(...args); },
  });
  window.__marks = {};
  new MutationObserver(() => {
    const m = window.__marks;
    const el = document.querySelector("[data-debug-chat]");
    if (!m.chat && el) {
      m.chat = performance.now();
      m.cached = el.hasAttribute("data-cached");
    }
    // The hub's lines, not the device's copy of them (data-cached until the history is in).
    if (!m.hub && document.querySelector("[data-debug-chat]:not([data-cached])")?.textContent?.includes("hub-newest-line"))
      m.hub = performance.now();
  }).observe(document, { childList: true, subtree: true, characterData: true });
})();`;

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};

const browser = await launchSilent(chromium);
const rows = [];
try {
  for (let r = 0; r < RUNS; r++) {
    const ctx = await newSilentContext(browser, { ...devices["iPhone 13"] });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    const email = `qa+chat${Date.now()}${r}@lianki.test`;
    const up = await page.request.post(`${BASE}/api/auth/sign-up/email`, {
      headers: { origin: BASE, "content-type": "application/json" },
      data: { email, password: PW, name: "QA" },
    });
    if (!up.ok()) throw new Error(`sign-up ${up.status()}`);
    // Load 1 fills the device's copy (when the build keeps one).
    await page.goto(`${BASE}${PATH}`);
    await page.waitForFunction(() => window.__marks?.hub, null, { timeout: 60_000 });
    await page.waitForTimeout(800);
    // NOCACHE=1: as on a device with no copy yet (the prefetch alone).
    if (NOCACHE) await page.evaluate(() => localStorage.removeItem("lk:chat-cache"));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
    await page.goto(`${BASE}${PATH}`);
    await page.waitForFunction(() => window.__marks?.hub, null, { timeout: 60_000 });
    const m = await page.evaluate(() => ({
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0,
      chat: window.__marks.chat,
      hub: window.__marks.hub,
      cached: window.__marks.cached,
    }));
    rows.push(m);
    console.log(
      `run ${r + 1}: fcp ${m.fcp | 0} chat ${m.chat | 0} hub ${m.hub | 0}` +
        (m.cached ? " (chat first painted from the device's copy)" : ""),
    );
    await ctx.close();
  }
} finally {
  await browser.close();
}
for (const k of ["fcp", "chat", "hub"]) {
  const xs = rows.map((x) => x[k]);
  console.log(`${k.padEnd(5)} P5/P50/P95 ${pct(xs, 5)}/${pct(xs, 50)}/${pct(xs, 95)} ms`);
}
const gap = rows.map((x) => x.chat - x.fcp);
console.log(`FCP→chat P5/P50/P95 ${pct(gap, 5)}/${pct(gap, 50)}/${pct(gap, 95)} ms`);
console.log(
  `(OPEN_MS ${OPEN_MS}, HUB_MS ${HUB_MS}, CPU ${CPU}x, ${RUNS} runs, ${BASE}${PATH}` +
    `${NOCACHE ? ", no device copy" : ""})`,
);

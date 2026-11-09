// The live doc's word card: a new word is a preview, its slider adds it, no button
// (reader-stream.tsx LiveTail; docs/books-plan.md). Silent; iPhone size, light and dark.
//
//   QA_BASE=http://localhost:3482 bun scripts/qa/qa-read-live-new-word.mjs [outDir]
//
// Against a local `wrangler dev`: it turns the flag read.gdoc-stream on
// in the local D1, and off again at the end. Not in qa:all, where it stays off. A throwaway account, made-up text under a fake doc
// id, and a stubbed stream socket. Checks:
//
// - a tap on a word of the tail: the slider, no add button, its meaning asked of
//   the route (no model set up here: qa-read-tap-gloss.mjs has a stubbed one), no card made;
// - a real touch drag short of a level adds nothing;
// - a drag past a level adds it with that grade; the toast's Undo takes it back,
//   and the word is a preview again.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/read-live-new-word";
const PW = "qa-test-pass-1234";
const FLAGS = ["read.gdoc-stream"];
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};
const until = async (page, f, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await page.waitForTimeout(100);
  }
  return false;
};
const d1 = (command) => {
  const r = spawnSync(
    "bunx",
    ["wrangler", "d1", "execute", "lianki", "--local", "--command", command],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`local D1: ${r.stderr}`);
};
const setFlags = (on) =>
  d1(
    on
      ? `INSERT OR REPLACE INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ${FLAGS.map(
          (f) => `('${f}', 1, '2026-11-06T00:00:00.000Z', 'qa')`,
        ).join(", ")}`
      : `DELETE FROM feature_flags WHERE key IN (${FLAGS.map((f) => `'${f}'`).join(", ")})`,
  );

const docHtml = (title) =>
  `<html><head><title>${title}</title></head><body><p>The first line of a made-up document.</p><p>The second line of it.</p></body></html>`;

const browser = await launchSilent(chromium);

async function run(scheme) {
  console.log(`— iphone ${scheme}`);
  const ctx = await newSilentContext(browser, {
    ...devices["iPhone 15"],
    baseURL: BASE,
    colorScheme: scheme,
  });
  const signUp = await ctx.request.post("/api/auth/sign-up/email", {
    data: {
      email: `qa+livenew${scheme}${Date.now()}@lianki.test`,
      password: PW,
      name: "QA Live",
    },
    headers: { origin: BASE },
  });
  check(signUp.ok(), `sign-up (${signUp.status()})`);
  const added = await ctx.request.post("/api/read/gdoc/stream", {
    data: { docId: "FAKE-qa-doc-id-00000000000000009", html: docHtml("QA live"), title: "QA live" },
    headers: { origin: BASE },
  });
  if (!added.ok()) throw new Error(`storing the doc: ${added.status()} ${await added.text()}`);
  const { id } = await added.json();

  let socket = null;
  await ctx.routeWebSocket(/\/api\/version\/read-stream/, (ws) => {
    socket = ws;
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const writes = [];
  const others = [];
  page.on("request", (q) => {
    if (q.method() !== "POST") return;
    if (q.url().includes("/make-cards")) others.push("make-cards");
    if (q.url().includes("/batch-grade")) {
      const b = JSON.parse(q.postData() || "{}");
      if (!b.probe) writes.push(b);
    }
  });
  await page.goto(`/reader/${id}?streamingFrom=google-docs`, { waitUntil: "load" });
  await page.getByTestId("reader-v2").waitFor({ timeout: 30000 });
  await until(page, () => !!socket, 15000);
  await page.waitForTimeout(800);
  socket.send(
    JSON.stringify({
      book: id,
      ops: [{ i: 100000, s: "Elephants wander beyond distant mountains quietly today." }],
    }),
  );
  const word = page.locator("[data-tail-w=wander]").first();
  await word.waitFor({ timeout: 8000 });
  await word.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const box = await word.boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

  const live = page.getByTestId("read-live-card");
  const knob = live.getByTestId("read-grade-knob");
  check(await until(page, () => knob.isVisible(), 15000), "a new word: the slider");
  check((await page.getByTestId("read-live-add").count()) === 0, "no add button");
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, `preview-${scheme}.png`) });

  const cdp = await ctx.newCDPSession(page);
  const drag = async (dx, back = false) => {
    const b = await knob.boundingBox();
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 14; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (dx * i) / 14, y }],
      });
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(150);
    if (back) {
      await page.screenshot({ path: join(OUT, `dragging-${scheme}.png`) });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await page.waitForTimeout(150);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };

  // Out past a level and back again before letting go: nothing.
  await drag(56, true);
  await page.waitForTimeout(600);
  check(writes.length === 0, `short of a level: nothing sent (${writes.length})`);
  check(others.length === 0, `no make-cards before the commit (${others})`);

  // Past a level: added with that grade.
  await drag(56);
  check(await until(page, () => writes.length === 1, 5000), "past a level: its batch is sent");
  check(writes[0]?.rating === 3, `the grade goes through (${writes[0]?.rating})`);
  check(writes[0]?.words?.[0]?.w === "wander", `the word (${writes[0]?.words?.[0]?.w})`);
  const toast = page.getByTestId("read-made-toast");
  check(await until(page, () => toast.isVisible(), 8000), "the toast, with Undo");
  check(!(await knob.isVisible()), "added: no slider, no second commit");
  await page.screenshot({ path: join(OUT, `added-${scheme}.png`) });

  const n = writes.length;
  await toast.locator("button").click();
  check(await until(page, () => writes.length === n + 1, 5000), "Undo asks the server");
  check(!!writes[n]?.undo, `the undo names its batch (${writes[n]?.undo})`);
  // A tap on the toast is a tap off the card, which closes: open the word again.
  await page.waitForTimeout(800);
  const again = await word.boundingBox();
  await page.touchscreen.tap(again.x + again.width / 2, again.y + again.height / 2);
  check(await until(page, () => knob.isVisible(), 8000), "undone: a preview again, the slider");

  // Gone on the server: a fresh probe finds no card.
  const probe = await (
    await ctx.request.post(`/api/read/${id}/batch-grade`, {
      data: { probe: { sentences: [], words: [{ w: "wander" }] } },
      headers: { origin: BASE },
    })
  ).json();
  check(
    probe.words?.[0]?.listId === null,
    `the card is gone (${JSON.stringify(probe.words?.[0])})`,
  );
  check(errs.length === 0, `no page errors (${errs.join(" | ").slice(0, 200)})`);
  await page.close();
  await ctx.close();
}

setFlags(true);
try {
  await run("light");
  await run("dark");
} finally {
  setFlags(false);
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);

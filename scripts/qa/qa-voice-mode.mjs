// /words voice mode end to end (docs/voice-mode.md), silent: the Settings
// switch, the mic session it takes (a fake capture device: input only, the
// browser is muted), and each spoken command's effect on the list. The
// speech itself comes from text fixtures handed to the mic's command taps
// (`__lkMicTaps.offer`), exactly where a final transcript arrives, so no STT
// runs and nothing is ever played.
//
//   QA_BASE=http://localhost:3217 QA_EMAIL=<an OWNER_EMAILS address> node scripts/qa/qa-voice-mode.mjs
//
// QA_EMAIL must be the dev server's OWNER_EMAILS (the flag is off locally, so
// only the owner's preview shows the switch). Runs a desktop and a phone pass.
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const EMAIL = process.env.QA_EMAIL || "qa+voice@lianki.test";
const PW = "qa-test-pass-1234";
let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) ok = false;
};

const browser = await launchSilent(chromium, {
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

async function pass(name, contextOptions) {
  console.log(`— ${name}`);
  const ctx = await newSilentContext(browser, { ...contextOptions, permissions: ["microphone"] });
  await ctx.addInitScript(() => localStorage.setItem("lk:first-run", "account"));
  await ctx.route("**/api/words/tts?*", (r) =>
    r.fulfill({ contentType: "audio/wav", body: Buffer.from("RIFF0000WAVE") }),
  );
  // No STT in this run: a transcript that reached the cloud route would be a leak past the taps.
  let sttCalls = 0;
  await ctx.route("**/api/debug/stt*", (r) => {
    sttCalls++;
    return r.fulfill({ contentType: "application/json", body: JSON.stringify({ text: "" }) });
  });
  const page = await ctx.newPage();
  if (process.env.QA_DEBUG)
    page.on("console", (m) => console.log(`  [console.${m.type()}] ${m.text().slice(0, 200)}`));
  const errs = [];
  page.on("pageerror", (e) => {
    if (!e.message.includes("Turnstile")) errs.push(e.message);
  });

  await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
  await page.locator("#email").fill(EMAIL);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForSelector("#password", { timeout: 10000 });
  await page.locator("#password").fill(PW);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForFunction(
    async () => (await (await fetch("/api/auth/get-session")).json())?.user,
    null,
    { timeout: 20000 },
  );
  await page.waitForURL((u) => /\/home|\/list|\/words/.test(u.toString()), { timeout: 20000 });

  await page.goto(`${BASE}/words`, { waitUntil: "networkidle" });
  const rows = page.locator('[role="listitem"]');
  if (
    !(await rows
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    // A fresh account: add a list (French, as qa-words does).
    const catalog = await page.evaluate(
      async () => (await (await fetch("/words/index.json")).json()).lists,
    );
    const first = catalog.find((c) => c.lang === "fr") ?? catalog[0];
    await page.getByRole("button", { name: first.lang, exact: true }).click();
    await page.getByRole("button", { name: "add", exact: true }).first().click();
  }
  await rows.first().waitFor({ timeout: 20000 });
  check((await rows.count()) > 5, `study list open (${await rows.count()} rows)`);

  // The switch: in Settings → Experimental, marked as the owner's preview.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const sw = page.getByRole("switch", { name: "Voice commands" });
  await sw.waitFor({ timeout: 5000 });
  check(
    (await page.locator('[data-voice-setting="preview"]').count()) === 1,
    "the switch shows, as an owner preview (flag off)",
  );
  // On (a rerun's account may have it on already, synced from the last run).
  if ((await sw.getAttribute("aria-checked")) !== "true") await sw.click();
  check(
    (await page.evaluate(() => localStorage.getItem("lk:words-voice-mode"))) === "1",
    "turning it on is kept in prefs (lk:words-voice-mode, synced as words.voiceMode)",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const badge = page.locator("[data-voice-mode]");
  await page.waitForFunction(
    () => {
      const s = document.querySelector("[data-voice-mode]")?.getAttribute("data-voice-mode");
      return s === "listening" || s === "failed";
    },
    null,
    { timeout: 20000 },
  );
  check((await badge.getAttribute("data-voice-mode")) === "listening", "the mic is listening");
  const mic = await page.evaluate(() => ({
    v: globalThis.__lkMic?.v,
    state: globalThis.__lkMic?.view().state,
    wake: globalThis.__lkMic?.view().wake,
    pinned: globalThis.__lkMicTaps?.pinned(),
  }));
  check(
    mic.v >= 10 && (mic.state === "listening" || mic.state === "capturing"),
    `page mic session v${mic.v}, ${mic.state}`,
  );
  check(mic.pinned && mic.wake === "active", "pinned to active: no wake word needed");

  const say = (text) => page.evaluate((t) => globalThis.__lkMicTaps.offer(t), text);
  const flash = async () => {
    await page.waitForTimeout(150);
    return page.locator("[data-voice-flash]").evaluate((e) => ({
      kind: e.getAttribute("data-voice-flash"),
      text: e.textContent,
    }));
  };
  const loose = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[role="listitem"]')].findIndex(
        (r) => r.classList.contains("slip-loose") || r.querySelector(".slip-loose"),
      ),
    );
  const stamped = (i) =>
    rows
      .nth(i)
      .locator(".lk-stamp")
      .getAttribute("aria-label")
      .catch(() => null);

  // Desktop's cursor starts on row 0; the touch focus too.
  if (contextOptions?.hasTouch) {
    // A tap focuses row 0 (and reads it, muted).
    await rows.nth(0).tap();
    await page.waitForTimeout(400);
  }
  const at0 = await loose();
  check(at0 === 0, `focus on row 0 (${at0})`);

  check((await say("下一张")) === true, "下一张 is kept from the chat");
  let f = await flash();
  check(f.kind === "done" && /下一张|Next card/.test(f.text), `下一张 → ${f.text}`);
  check((await loose()) === 1, "focus moved to row 1");

  await say("上一張"); // Traditional
  check((await loose()) === 0, "上一張 (Traditional) → back to row 0");
  await say("下");
  check((await loose()) === 1, "下 → row 1");

  await say("良好。");
  f = await flash();
  check(f.kind === "done", `良好 → ${f.text}`);
  check((await stamped(1)) === "Good", `row 1 graded Good (${await stamped(1)})`);
  check((await loose()) === 2, "a first grade moves on, as a swipe does");

  await say("左");
  check((await stamped(2)) === "Hard", `左 → Hard on row 2 (${await stamped(2)})`);
  await say("撤销");
  await page.waitForTimeout(150);
  check((await stamped(2)) === null, "撤销 → row 2's grade undone");

  // Not commands: shown as heard, nothing changes.
  const before = await loose();
  await say("我觉得下一张更难");
  f = await flash();
  check(f.kind === "unknown" && f.text.includes("我觉得下一张更难"), `sentence → ${f.text}`);
  check((await loose()) === before, "a command word inside a sentence did nothing");
  // The word itself: the row's first text cell (after the stamp).
  const term = (await rows.nth(before).innerText())
    .split(/[\n\t]+/)
    .map((x) => x.trim())
    .find((x) => x && !x.startsWith("▸"));
  await say(term);
  f = await flash();
  check(f.kind === "unknown" || f.kind === "echo", `the card's own word "${term}" → ${f.kind}`);
  check((await loose()) === before, "…and did nothing");
  check((await say("Linky, what's next?")) === false, "a line for the agent goes to the chat");

  await say("显示答案");
  f = await flash();
  check(f.kind === "done", `显示答案 → ${f.text}`);
  await say("再读一遍");
  f = await flash();
  check(f.kind === "done", `再读一遍 → ${f.text}`);

  await say("退出语音模式");
  await page.waitForTimeout(300);
  check((await badge.count()) === 0, "退出语音模式 → voice mode off");
  check(
    (await page.evaluate(() => localStorage.getItem("lk:words-voice-mode"))) === "0",
    "…and the pref says off",
  );
  const after = await page.evaluate(() => ({
    pinned: globalThis.__lkMicTaps?.pinned(),
    state: globalThis.__lkMic?.view().state,
  }));
  check(!after.pinned && after.state === "off", `mic released (${after.state})`);
  check(sttCalls === 0, `no transcript went to STT (${sttCalls})`);
  check(errs.length === 0, `no page errors${errs.length ? `: ${errs.join(" | ")}` : ""}`);
  await ctx.close();
}

try {
  await pass("desktop", { viewport: { width: 1280, height: 900 } });
  await pass("phone", { ...devices["iPhone 13"] });
} catch (e) {
  console.log(`✗ ${e.message}`);
  ok = false;
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);

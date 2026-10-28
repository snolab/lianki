// Word lists (/words) end to end on the D1 Worker: sign up, add a catalog list,
// grade one screen by exception, and check what the server stored.
import { chromium } from "playwright";
const BASE = process.env.QA_BASE || "http://localhost:3000";
const EMAIL = `qa+words${Date.now()}@lianki.test`;
const PW = "qa-test-pass-1234";

const browser = await chromium.launch();
const ctx = await browser.newContext();
// A signed-up user has answered the first-run question; skip its modal.
await ctx.addInitScript(() => localStorage.setItem("lk:first-run", "account"));
// Grade tones: a silent stand-in for Web Audio that records each note's pitch,
// so the wiring is checked and nothing ever sounds on the test machine.
const silentAudio = () => {
  window.__tones = [];
  const param = () => ({
    value: 0,
    setValueAtTime(v) {
      this.value = v;
    },
    exponentialRampToValueAtTime() {},
    cancelScheduledValues() {},
    setTargetAtTime() {},
  });
  const node = () => ({ connect: (n) => n, disconnect() {} });
  window.AudioContext = class {
    currentTime = 0;
    state = "running";
    destination = node();
    resume = async () => {};
    createGain = () => ({ ...node(), gain: param() });
    createBuffer = () => ({});
    createBufferSource = () => ({ ...node(), start() {} });
    createOscillator = () => {
      const o = { ...node(), type: "", frequency: param(), stop() {} };
      o.start = () => window.__tones.push(Math.round(o.frequency.value));
      return o;
    };
  };
  window.webkitAudioContext = window.AudioContext;
  // Speech too: record what would be said, with no voices listed (as on
  // many Android phones) — words must still be spoken.
  window.__spoken = [];
  Object.defineProperty(window, "speechSynthesis", {
    value: {
      speak(u) {
        if (u.text) window.__spoken.push(`${u.lang}:${u.text}`);
        setTimeout(() => u.onend?.(), 50);
      },
      cancel() {},
      getVoices: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  });
};
await ctx.addInitScript(silentAudio);
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => {
  // Local runs have no Turnstile site key; that warning is not this page's fault.
  if (!e.message.includes("Turnstile")) errs.push("PAGEERROR " + e.message);
});
let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) ok = false;
};

try {
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
  check(true, "signed in");

  // Only errors on the page under test count; sign-in's local Turnstile stub is noisy.
  errs.length = 0;
  await page.goto(`${BASE}/words`, { waitUntil: "networkidle" });
  const catalog = await page.evaluate(
    async () => (await (await fetch("/words/index.json")).json()).lists,
  );
  check(catalog?.length > 0, `catalog lists: ${catalog?.length}`);
  const first = catalog.find((c) => c.lang === "fr") ?? catalog[0];
  await page.getByRole("button", { name: first.lang, exact: true }).click();
  await page.getByRole("button", { name: "add", exact: true }).first().click();

  const rows = page.locator('[role="listitem"]');
  await rows.first().waitFor({ timeout: 15000 });
  check((await rows.count()) >= 20, `the list opens with ${await rows.count()} words`);
  check((await page.locator("span.text-emerald-600").count()) > 0, "new words are shown in green");
  const statusOf = async (i) => (await rows.nth(i).locator("span.tabular-nums").innerText()).trim();
  check((await statusOf(0)) === "new", `an ungraded new word says "new": ${await statusOf(0)}`);

  // F moves the cursor down (like ↓) and the focused row shows its meaning.
  const blurred = (i) =>
    rows
      .nth(i)
      .locator("span.text-sm")
      .first()
      .evaluate((el) => el.className.includes("blur-["));
  await page.keyboard.press("f");
  check(!(await blurred(1)) && (await blurred(0)), "F moves down and reveals the focused row");
  await page.keyboard.press("r");
  check(!(await blurred(0)), "R moves back up");

  const listsNow = async () =>
    (await page.evaluate(async () => (await fetch("/api/words/lists")).json())).lists.find(
      (l) => l.source === first.id,
    );
  const reviewed = () =>
    page.waitForResponse((r) => r.url().includes("/review") && r.request().method() === "POST");

  // Each grade is saved at once — no screens, no Next.
  let res = reviewed();
  await page.keyboard.press("a");
  check((await (await res).status()) === 200, "A saves that one word immediately");
  check(
    /^\d+(\.\d)?(s|m|h|d|mo|y)$/.test(await statusOf(0)),
    `it shows when it returns: ${await statusOf(0)}`,
  );

  // Going back and grading again re-grades: still one card, one review.
  await page.keyboard.press("r");
  res = reviewed();
  await page.keyboard.press("d");
  await res;
  let l = await listsNow();
  check(l?.cards === 1, `re-grading keeps one card (${l?.cards})`);

  // Z undoes it: the word is new again.
  await page.keyboard.press("r");
  const undone = page.waitForResponse((r) => r.url().includes("/undo"));
  await page.keyboard.press("z");
  check((await (await undone).status()) === 200, "Z undoes the focused word on the server");
  l = await listsNow();
  check(
    l?.cards === 0 && (await statusOf(0)) === "new",
    `after undo the word is new again (${l?.cards} cards)`,
  );
  // Each grade sounded its tone: Again falls, Easy rises, undo glides.
  const tones = await page.evaluate(() => window.__tones.join(","));
  check(tones === "330,262,523,784,880", `grade tones: Again, Easy, undo (${tones})`);

  // The URL keeps the list; a refresh lands back in it.
  check(/[?&]list=/.test(page.url()), `the open list is in the URL: ${new URL(page.url()).search}`);
  // Settings live in a panel of switches, and are remembered across a refresh.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Show all meanings" }).click();
  await page.reload({ waitUntil: "networkidle" });
  await rows.first().waitFor({ timeout: 15000 });
  check((await rows.count()) > 0, "a refresh lands back in the list");
  check(!(await blurred(5)), "Show all meanings is remembered across a refresh");
  await page.keyboard.press("e"); // back off, for the checks below
  check(await blurred(5), "E turns it off again");

  // Endless: grade 60 words in a row; more keep coming and all are saved.
  // 40 ms apart: still far faster than a person, slow enough for loading to keep up.
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("w");
    await page.waitForTimeout(40);
  }
  // Grades go out one by one from the sync queue: wait for the last to land.
  const cardsReach = async (n, ms = 40000) => {
    let c;
    for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(300))
      if ((c = (await listsNow())?.cards) === n) return c;
    return c;
  };
  const saved60 = await cardsReach(60);
  const ahead = await rows.evaluateAll(
    (els) => els.filter((e) => e.querySelector("span.tabular-nums")?.textContent === "new").length,
  );
  check(
    saved60 === 60 && ahead > 0,
    `60 graded and saved (${saved60}), more words below (${ahead})`,
  );

  // Scrolling to the bottom (no cursor movement, as on a phone) loads more too.
  const listBox = page.locator('[role="list"]');
  const heightBefore = await listBox.evaluate((el) => el.scrollHeight);
  for (let i = 0; i < 4; i++) {
    await listBox.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(700);
  }
  const heightAfter = await listBox.evaluate((el) => el.scrollHeight);
  check(
    heightAfter > heightBefore,
    `scrolling to the end loads more words (${heightBefore} → ${heightAfter}px)`,
  );
  // Offline: grades wait on the device, the page reopens from the cache, and
  // everything syncs once the network is back.
  // Let the sync queue drain first, so the offline count below is only new grades.
  await page
    .locator('[data-sync="synced"]')
    .filter({ hasText: "synced" })
    .waitFor({ timeout: 20000 });
  await ctx.setOffline(true);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("w");
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(500);
  const waitingText = await page
    .locator('[data-sync="pending"]')
    .innerText()
    .catch(() => "");
  check(
    /3 to sync/.test(waitingText),
    `offline grades wait on the device: "${waitingText.trim()}"`,
  );
  await page.reload({ waitUntil: "load" }).catch(() => {});
  await rows
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  check((await rows.count()) > 0, "offline, the list reopens from the device");
  await ctx.setOffline(false);
  const synced = await cardsReach(63, 20000);
  check(synced === 63, `back online, the offline grades reach the server (${synced})`);

  // Phone: holding a row reveals it (listen mode); letting go hides it again.
  {
    const { devices } = await import("playwright");
    const phone = await browser.newContext({
      ...devices["iPhone 13"],
      storageState: await ctx.storageState(),
    });
    await phone.addInitScript(silentAudio);
    const m = await phone.newPage();
    await m.goto(page.url(), { waitUntil: "networkidle" });
    const mrows = m.locator('[role="listitem"]');
    await mrows.first().waitFor({ timeout: 15000 });
    await m.waitForTimeout(500); // let the opening scroll settle
    const listTop = await m
      .locator('[role="list"]')
      .evaluate((el) => el.getBoundingClientRect().top);
    const firstTop = (await mrows.nth(0).boundingBox()).y;
    check(
      Math.abs(firstTop - listTop) < 50,
      `phone: the list opens with the first word at the top (${Math.round(firstTop - listTop)}px)`,
    );
    const blurredM = () =>
      mrows
        .nth(0)
        .locator("span.text-sm")
        .first()
        .evaluate((el) => el.className.includes("blur-["));
    const box = await mrows.nth(0).boundingBox();
    await m.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await m.mouse.down();
    await m.waitForTimeout(500);
    const whileHeld = !(await blurredM());
    const spoken = await m.evaluate(() => window.__spoken.slice(0, 2).join(" | "));
    check(spoken.length > 0, `phone: holding speaks the word, with no voices listed (${spoken})`);
    await m.mouse.up();
    await m.waitForTimeout(100);
    check(whileHeld && (await blurredM()), "phone: holding a row reveals it, releasing hides it");
    // Full screen: the API where there is one, else the Add to Home Screen hint.
    await m.getByRole("button", { name: "Settings" }).click();
    await m.getByRole("switch", { name: "Full screen" }).click();
    await m.waitForTimeout(300);
    const fsOn = await m.evaluate(() => !!document.fullscreenElement);
    const hint = await m.getByText("Add to Home Screen", { exact: false }).count();
    check(
      fsOn || hint > 0,
      `phone: the full screen button works (${fsOn ? "fullscreen" : "hint"})`,
    );
    await phone.close();
  }

  // /alphabet: same drill over its own catalog; its lists stay off /words.
  await page.goto(`${BASE}/alphabet`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "ja", exact: true }).click();
  await page.getByRole("button", { name: "add", exact: true }).first().click();
  await rows.first().waitFor({ timeout: 15000 });
  const firstTerms = await rows.locator("span.truncate.font-medium").allInnerTexts();
  const fronts = firstTerms.map((t) => t.split("\n")[0].trim());
  check(fronts[0] === "あ", `alphabet starts with あ: ${fronts.slice(0, 3)}`);
  // A reverse card is kept well away from its forward card (a right under あ gives it away).
  check(!fronts.slice(0, 20).includes("a"), "あ and its reverse a are kept 20+ rows apart");
  await page.goto(`${BASE}/words`, { waitUntil: "networkidle" });
  check((await page.getByText("Hiragana").count()) === 0, "alphabet lists stay off /words");

  // "Download for offline" saves the lists, catalogs and due words on the device.
  await page.getByRole("button", { name: /Download for offline/ }).click();
  const saved = await page
    .getByText("Saved on this device ✓")
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check(saved, "download for offline completes");

  // Study all: with two lists, one queue mixes both.
  await page.getByRole("button", { name: first.lang, exact: true }).click();
  await page.getByRole("button", { name: "add", exact: true }).first().click();
  await rows.first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "← lists" }).click();
  await page.getByRole("button", { name: /Study all lists together/ }).click();
  await rows.first().waitFor({ timeout: 15000 });
  check(page.url().includes("list=all"), "study all has its own URL");
  const sent = page.waitForResponse(
    (r) => r.url().includes("/review") && r.request().method() === "POST",
  );
  await page.keyboard.press("w");
  check((await sent).status() === 200, "study all: a graded word saves");

  // Drag the second list above the first by its handle; the order is saved.
  await page.goto(`${BASE}/words`, { waitUntil: "networkidle" });
  const handles = page.getByRole("button", { name: "Drag to reorder" });
  const before = (
    await page.evaluate(async () => (await (await fetch("/api/words/lists")).json()).lists)
  )
    .filter((l) => l.lang === first.lang)
    .map((l) => l.id);
  const h2 = await handles.nth(1).boundingBox();
  const h1 = await handles.nth(0).boundingBox();
  await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2);
  await page.mouse.down();
  await page.mouse.move(h1.x + h1.width / 2, h1.y - 10, { steps: 8 });
  await page.mouse.up();
  let after = before;
  for (let i = 0; i < 10 && after.join() === before.join(); i++, await page.waitForTimeout(300))
    after = (
      await page.evaluate(async () => (await (await fetch("/api/words/lists")).json()).lists)
    )
      .filter((l) => l.lang === first.lang)
      .map((l) => l.id);
  check(after[0] === before[1] && after[1] === before[0], "dragging a handle reorders the lists");

  // Drag the second row right: it nests under the first (Anki-style subdeck).
  await page.waitForTimeout(500);
  const n2 = await handles.nth(1).boundingBox();
  await page.mouse.move(n2.x + n2.width / 2, n2.y + n2.height / 2);
  await page.mouse.down();
  await page.mouse.move(n2.x + n2.width / 2 + 40, n2.y + n2.height / 2, { steps: 8 });
  await page.mouse.up();
  let nested = null;
  for (let i = 0; i < 10 && !nested?.parentId; i++, await page.waitForTimeout(300))
    nested = (
      await page.evaluate(async () => (await (await fetch("/api/words/lists")).json()).lists)
    ).find((l) => l.id === after[1]);
  check(nested?.parentId === after[0], "dragging right nests a list under the one above");

  // A group: study it (its lists) and study all, with groups present.
  const group = await page.evaluate(
    async () =>
      (
        await (
          await fetch("/api/words/lists", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "QA group", lang: "mul", source: "group:words" }),
          })
        ).json()
      ).list.id,
  );
  await page.evaluate(
    async ([g, ids]) =>
      fetch("/api/words/lists", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          order: [{ id: g, parentId: null }, ...ids.map((id) => ({ id, parentId: g }))],
        }),
      }),
    [group, after],
  );
  await page.goto(`${BASE}/words?list=${group}`, { waitUntil: "networkidle" });
  await rows.first().waitFor({ timeout: 15000 });
  check((await rows.count()) > 0, "studying a group lists its words");
  await page.goto(`${BASE}/words?list=all`, { waitUntil: "networkidle" });
  await rows.first().waitFor({ timeout: 15000 });
  check((await rows.count()) > 0, "study all works with groups present");
  check(errs.length === 0, `no page errors${errs.length ? ": " + errs.join(" | ") : ""}`);
} catch (e) {
  check(false, `threw: ${e.message}`);
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);

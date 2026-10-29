// Word lists (/words) end to end on the D1 Worker: sign up, add a catalog list,
// grade one screen by exception, and check what the server stored.
import { chromium } from "playwright";
const BASE = process.env.QA_BASE || "http://localhost:3000";
// QA_SHOTS=<dir>: also save screenshots of the list, to look at the layout.
const shot = (pg, name) =>
  process.env.QA_SHOTS ? pg.screenshot({ path: `${process.env.QA_SHOTS}/${name}.png` }) : null;
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
  // Server audio (the fallback voice): record what would play, play nothing.
  window.__played = [];
  HTMLMediaElement.prototype.play = function () {
    window.__played.push(this.src);
    return Promise.resolve();
  };
  // Speech too: record what would be said, with no voices listed (as on
  // many Android phones) — words must still be spoken, by the server: with no
  // voice of the word's language the OS would read it in its default one.
  window.__spoken = [];
  Object.defineProperty(window, "speechSynthesis", {
    value: {
      speak(u) {
        if (u.text) window.__spoken.push(`${u.lang}:${u.text}`);
        // __speechDead: an API with no engine behind it (Firefox on Android).
        if (window.__speechDead) return;
        u.onstart?.();
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
// Word audio from the server is stubbed everywhere: no AI call from QA.
await ctx.route("**/api/words/tts?*", (r) =>
  r.fulfill({ contentType: "audio/wav", body: Buffer.from("RIFF0000WAVE") }),
);
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

  // The term column is fitted to the terms on screen (6–20rem), one width for all rows.
  const termW = await page
    .locator('[role="list"]')
    .evaluate((el) => parseFloat(el.style.getPropertyValue("--term-w")));
  check(termW >= 96 && termW <= 320, `the term column is fitted: ${Math.round(termW)}px`);

  // Glance: in a narrow window, the cursor row's cut-off cells slide to their
  // end and back — a Web Animation on the compositor, not a CSS timer.
  const fullSize = page.viewportSize();
  await page.setViewportSize({ width: 560, height: fullSize.height });
  await page.waitForTimeout(400);
  const glance = await page.evaluate(() => {
    const row = document.querySelector('[role="listitem"] .outline')
      ? document.querySelector('[role="listitem"].outline')
      : document.querySelectorAll('[role="listitem"]')[0];
    const cut = [...(row?.querySelectorAll("span.overflow-hidden") ?? [])].filter(
      (el) => el.firstElementChild && el.firstElementChild.getAnimations().length > 0,
    );
    return { animated: cut.length, all: document.getAnimations().length };
  });
  check(
    glance.animated > 0,
    `a cut-off cell on the cursor row glances (${JSON.stringify(glance)})`,
  );
  await page.setViewportSize(fullSize);
  await page.waitForTimeout(200);

  // F moves the cursor down (like ↓) and the focused row shows its meaning;
  // a hidden meaning is a blank slot (留白, class slip-blank).
  const blurred = (i) =>
    rows
      .nth(i)
      .locator("span.text-sm")
      .first()
      .evaluate((el) => el.className.includes("slip-blank"));
  await page.keyboard.press("s");
  check(!(await blurred(1)) && (await blurred(0)), "S moves down and reveals the focused row");
  await page.keyboard.press("w");
  check(!(await blurred(0)), "W moves back up");

  const listsNow = async () =>
    (await page.evaluate(async () => (await fetch("/api/words/lists")).json())).lists.find(
      (l) => l.source === first.id,
    );
  const reviewed = () =>
    page.waitForResponse((r) => r.url().includes("/review") && r.request().method() === "POST");

  // Each grade is saved at once — no screens, no Next.
  let res = reviewed();
  await page.keyboard.press("1");
  check((await (await res).status()) === 200, "1 saves that one word immediately");
  check(
    (await rows.nth(0).locator("[data-stamp-cell] .lk-stamp").count()) === 1,
    "a graded slip gets a small seal at its left end",
  );
  // Desktop: the cursor's slip is the loose one; a right click opens its sheet.
  const loose = page.locator('[role="listitem"].slip-loose');
  check((await loose.count()) === 1, "the cursor's slip is the one loose slip");
  await loose.click({ button: "right" });
  check(
    (await page.locator("[data-slip-sheet]").count()) === 1,
    "a right click opens the slip's sheet",
  );
  await page.keyboard.press("Escape");
  check((await page.locator("[data-slip-sheet]").count()) === 0, "Escape closes the sheet");
  await shot(page, "words-desktop-graded");
  check(
    /^\d+(\.\d)?(s|m|h|d|mo|y)$/.test(await statusOf(0)),
    `it shows when it returns: ${await statusOf(0)}`,
  );
  // Again's minute counts down live: 58s, 57s…
  await page.waitForTimeout(2000);
  const tick1 = await statusOf(0);
  await page.waitForTimeout(1200);
  const tick2 = await statusOf(0);
  check(
    /^\d+s$/.test(tick1) && /^\d+s$/.test(tick2) && parseInt(tick2) < parseInt(tick1),
    `Again counts down live (${tick1} → ${tick2})`,
  );

  // Going back and grading again re-grades: still one card, one review.
  await page.keyboard.press("w");
  res = reviewed();
  await page.keyboard.press("4");
  await res;
  let l = await listsNow();
  check(l?.cards === 1, `re-grading keeps one card (${l?.cards})`);

  // Z undoes it: the word is new again.
  await page.keyboard.press("w");
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

  // The server voice is the default (browser voices can mislead): moving to
  // a word plays the server's recording (stubbed: no AI call, nothing audible).
  await page.getByRole("button", { name: "Settings" }).click();
  check(
    (await page.getByRole("switch", { name: "Server voice" }).getAttribute("aria-checked")) ===
      "true",
    "Server voice is on by default",
  );
  await page.getByRole("button", { name: "Settings" }).click();
  await page.keyboard.press("s");
  await page
    .waitForFunction(() => window.__played.length > 0, null, { timeout: 5000 })
    .catch(() => {});
  check((await page.evaluate(() => window.__played.length)) > 0, "Server voice plays server audio");
  // Server voice off, and no browser voice for the language: still the
  // server, never the OS's default voice (a Japanese voice reading French).
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Server voice" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.evaluate(() => {
    window.__played.length = 0;
    window.__spoken.length = 0;
  });
  await page.keyboard.press("s");
  await page
    .waitForFunction(() => window.__played.length > 0, null, { timeout: 5000 })
    .catch(() => {});
  const voiceless = await page.evaluate(() => [window.__spoken.length, window.__played.length]);
  check(
    voiceless[0] === 0 && voiceless[1] > 0,
    `no browser voice for the language: the server speaks, not the OS default (spoken ${voiceless[0]}, played ${voiceless[1]})`,
  );
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Server voice" }).click();
  await page.getByRole("button", { name: "Settings" }).click();

  // The installed app's scope is the whole site: /words opened from the home
  // screen must not fall outside it (iOS then shows the address bar).
  const manifest = await page.evaluate(async () => (await fetch("/manifest.json")).json());
  check(manifest.scope === "/", `the web app's scope is the whole site (${manifest.scope})`);

  // The seal icons are served as files, not swallowed by the locale redirect.
  const icons = await page.evaluate(async () =>
    Promise.all(
      ["/icon.svg", "/icon-192.png", "/apple-icon.png", "/favicon.ico"].map(async (u) => {
        const r = await fetch(u, { redirect: "manual" });
        return `${r.status}:${(r.headers.get("content-type") ?? "").split(";")[0]}`;
      }),
    ),
  );
  check(
    icons.every((x) => x.startsWith("200:image/")),
    `the seal icons are served (${icons.join(", ")})`,
  );

  // Server word audio validates before any (paid) generation. page.request
  // shares the session but bypasses the QA stub of this route.
  const ttsStatus = await Promise.all(
    ["lang=th&text=%E0%B8%81", "lang=fr&text=", `lang=fr&text=${"a".repeat(201)}`].map(async (q) =>
      (await page.request.get(`${new URL(page.url()).origin}/api/words/tts?${q}`)).status(),
    ),
  );
  check(
    ttsStatus.join() === "404,400,400",
    `word audio: no voice → 404, bad text → 400 (${ttsStatus.join()})`,
  );
  // The installed app has no address bar: seven quick taps on the stats line
  // toggle the debug log instead.
  const stats = page.locator("span", { hasText: /done ·/ }).last();
  for (let k = 0; k < 7; k++) await stats.click();
  check((await page.locator("[data-debug-badge]").count()) === 1, "seven taps turn debug on");
  for (let k = 0; k < 7; k++) await stats.click();
  check((await page.locator("[data-debug-badge]").count()) === 0, "seven more turn it off");

  // The owner's remote-debug log is the owner's alone.
  const devLog = await page.request.post(`${new URL(page.url()).origin}/api/dev/log`, {
    data: "{}",
  });
  check(devLog.status() === 404, `the debug log is owner-only (${devLog.status()})`);

  // A language with pre-rendered clips but none for this text: a 404 the
  // client must not take as "no voice for Italian".
  const miss = await page.request.get(
    `${new URL(page.url()).origin}/api/words/tts?lang=it&text=qa-no-such-clip`,
  );
  check(
    miss.status() === 404 && miss.headers()["x-voice"] === "miss",
    `word audio: a missing clip is a per-text miss (${miss.status()} ${miss.headers()["x-voice"]})`,
  );

  // New-version notice: lianki-push (workers/push) names the serving build
  // over a WebSocket; a page from an older build offers a refresh. The push
  // service is not part of the local Worker, so the socket is mocked here.
  await page.routeWebSocket("**/api/version/ws", (ws) =>
    ws.send(JSON.stringify({ build: "some-newer-build" })),
  );
  await page.evaluate(() => localStorage.setItem("lk:version-notice", "1"));
  await page.reload({ waitUntil: "load" });
  await page.bringToFront();
  const notice = page.getByRole("button", { name: "New version · Refresh" });
  await notice.waitFor({ timeout: 10000 }).catch(() => {});
  check(await notice.isVisible(), "a newer build pushed over the socket shows a Refresh button");
  await page.evaluate(() => localStorage.removeItem("lk:version-notice"));
  await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  await page.reload({ waitUntil: "networkidle" });
  await rows.first().waitFor({ timeout: 15000 });

  // Endless: grade 60 words in a row; more keep coming and all are saved.
  // 40 ms apart: still far faster than a person, slow enough for loading to keep up.
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("3");
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
    await page.keyboard.press("3");
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
    // This phone's speech API never speaks, like Firefox on Android: words
    // must come from the server instead (stubbed here — no AI call in QA).
    await phone.addInitScript(() => (window.__speechDead = true));
    const ttsAsked = [];
    await phone.route("**/api/words/tts?*", (r) => {
      ttsAsked.push(new URL(r.request().url()).searchParams.get("lang"));
      return r.fulfill({ contentType: "audio/wav", body: Buffer.from("RIFF0000WAVE") });
    });
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
        .evaluate((el) => el.className.includes("slip-blank"));
    const box = await mrows.nth(0).boundingBox();
    await m.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await m.mouse.down();
    await m.waitForTimeout(500);
    const whileHeld = !(await blurredM());
    const spoken = await m.evaluate(() => window.__spoken.length + window.__played.length);
    check(spoken > 0, `phone: holding speaks the word (${spoken} utterances)`);

    await m.mouse.up();
    await m.waitForTimeout(100);
    check(whileHeld && (await blurredM()), "phone: holding a row reveals it, releasing hides it");
    await shot(m, "words-phone");
    // A tap says the word once (releasing a hold stops speech, so tap here).
    await m.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await m
      .waitForFunction(() => window.__played.length > 0, null, { timeout: 6000 })
      .catch(() => {});
    check(
      ttsAsked.length > 0 && (await m.evaluate(() => window.__played.length)) > 0,
      `phone: speech that never starts falls back to server audio (${ttsAsked.join(",")})`,
    );
    // Focus = that slip's cords come loose (no more green bar).
    check(
      (await mrows.nth(0).getAttribute("class")).includes("slip-loose") &&
        (await m.locator('[role="listitem"].slip-loose').count()) === 1,
      "phone: the tapped slip is the one loose slip",
    );
    // A double tap opens the slip's other actions in a sheet; it does not
    // change what the slip shows.
    await m.waitForTimeout(400); // not part of the tap above
    const shownBefore = await blurredM();
    await m.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await m
      .locator("[data-slip-sheet]")
      .waitFor({ timeout: 3000 })
      .catch(() => {});
    check(
      (await m.locator("[data-slip-sheet]").count()) === 1,
      "phone: a double tap opens the sheet",
    );
    check((await blurredM()) === shownBefore, "phone: the double tap leaves the reveal as it was");
    await m.getByRole("button", { name: "Cancel" }).click();
    check((await m.locator("[data-slip-sheet]").count()) === 0, "phone: Cancel closes the sheet");
    // Swipe vs scroll: a steep drag is a scroll and never grades; a clearly
    // sideways drag grades.
    const mStatus = async (i) =>
      (await mrows.nth(i).locator("span.tabular-nums").innerText()).trim();
    const drag = async (i, dx, dy) => {
      const b = await mrows.nth(i).boundingBox();
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      await m.mouse.move(x, y);
      await m.mouse.down();
      for (let k = 1; k <= 8; k++) await m.mouse.move(x + (dx * k) / 8, y + (dy * k) / 8);
      await m.waitForTimeout(80); // stop before lifting: distance, not a flick
      await m.mouse.up();
      await m.waitForTimeout(400);
    };
    const before = await mStatus(3);
    await drag(3, 40, 45);
    check((await mStatus(3)) === before, `phone: a diagonal drag does not grade (${before})`);
    await drag(3, 70, 4);
    const after = await mStatus(3);
    check(after !== before, `phone: a sideways drag grades (${before} → ${after})`);
    // Swipe telemetry is queued and the server takes it.
    const tele = await m.evaluate(async () => {
      const queued = JSON.parse(localStorage.getItem("lk:swipe-unsent") ?? "[]");
      const r = await fetch("/api/words/telemetry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ swipes: queued.slice(0, 5) }),
      });
      return `${queued.length}:${r.status}`;
    });
    check(/^[1-9]\d*:200$/.test(tele), `phone: swipe telemetry is queued and stored (${tele})`);

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
  const firstTerms = await rows.locator("span.font-medium.overflow-hidden").allInnerTexts();
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
  await page.keyboard.press("3");
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

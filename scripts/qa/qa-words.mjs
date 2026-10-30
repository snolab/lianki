// Word lists (/words) end to end on the D1 Worker: sign up, add a catalog list,
// grade one screen by exception, and check what the server stored.
import { chromium } from "playwright";
import { buildApkg } from "./apkg-fixture.mjs";
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
/**
 * The lists picker. /words with no ?list= reopens the list this tab had open
 * (docs/ui-state.md); "← lists" goes back to the picker and forgets it.
 */
const toPicker = async () => {
  await page.goto(`${BASE}/words`, { waitUntil: "networkidle" });
  if (!new URL(page.url()).searchParams.has("list")) return;
  const back = page.getByRole("button", { name: "← lists" });
  await back.waitFor({ timeout: 15000 });
  await back.click();
};
const errs = [];
page.on("pageerror", (e) => {
  // Local runs have no Turnstile site key; that warning is not this page's fault.
  if (!e.message.includes("Turnstile")) errs.push("PAGEERROR " + e.message);
});
let ok = true;

/**
 * The grade reveal paints behind its slip: at rest the point over a label's
 * spot hits the card; slid away (Good uncovered), it hits the label. The
 * reveal ignores pointers, so they are let through for the probe only (the
 * page is closed right after).
 */
async function revealOrder(pg, variant) {
  await pg.addStyleTag({
    content:
      "[data-swipe-underlay],[data-swipe-strip],[data-reveal-slot],[data-reveal],[data-reveal] *{pointer-events:auto!important}",
  });
  const barB = await pg
    .locator("[data-words-top]")
    .evaluate((el) => el.getBoundingClientRect().bottom);
  const rows = pg.locator('[role="listitem"]');
  let i = 0;
  let b = null;
  for (; !b; i++) {
    const bi = await rows.nth(i).boundingBox();
    if (bi && bi.y > barB + 100) b = bi;
  }
  const row = rows.nth(i - 1);
  const [x, y] = [b.x + 20, b.y + b.height / 2];
  const hit = () =>
    pg.evaluate(
      ([x, y]) => {
        // The topmost thing that shows: a faded-out reveal layer doesn't count.
        for (const e of document.elementsFromPoint(x, y)) {
          const r = e.closest("[data-reveal]");
          if (r && Number(getComputedStyle(r).opacity) > 0.5) return `label:${r.dataset.reveal}`;
          if (!r && e.closest(".slip")) return "card";
        }
        return "none";
      },
      [x, y],
    );
  const rest = await hit();
  let mid;
  if (variant === "native") {
    // Slid right by a, probed in the same task (before the slip glides home).
    mid = await row.evaluate(
      (r, [x, y]) => {
        const a = parseFloat(getComputedStyle(r).getPropertyValue("--a"));
        r.querySelector(".slip-scroller").scrollTo({ left: a, behavior: "instant" });
        for (const e of document.elementsFromPoint(x, y)) {
          const z = e.closest("[data-reveal]");
          if (z && Number(getComputedStyle(z).opacity) > 0.5) return `label:${z.dataset.reveal}`;
          if (!z && e.closest(".slip")) return "card";
        }
        return "none";
      },
      [x, y],
    );
    await row.evaluate((r) => {
      const a = parseFloat(getComputedStyle(r).getPropertyValue("--a"));
      r.querySelector(".slip-scroller").scrollTo({ left: 2 * a, behavior: "instant" });
    });
  } else {
    const cx = b.x + b.width / 2;
    // A press within 120ms of a list scroll catches a fling (no slide), and
    // one held 300ms before moving is a hold (no slide): start only once the
    // list has been still a while, and go past the slop on the first move.
    await pg.evaluate(
      () =>
        new Promise((done) => {
          const list = document.querySelector('[role="list"]');
          let t;
          const quiet = () => {
            clearTimeout(t);
            t = setTimeout(() => {
              list.removeEventListener("scroll", quiet);
              done();
            }, 300);
          };
          list.addEventListener("scroll", quiet, { passive: true });
          quiet();
        }),
    );
    await pg.mouse.move(cx, y);
    await pg.mouse.down();
    await pg.mouse.move(cx + 20, y);
    await pg.mouse.move(cx + 60, y, { steps: 4 });
    // Headless WebKit can stall its rendering updates once the slip gets its
    // own layer (will-change) mid-drag: no requestAnimationFrame runs, the
    // queued pointermoves are coalesced away, and the slip is never painted
    // off its spot — the probe then sees the card (CI main runs, and 5 of 5
    // local runs with extra observers attached). A screenshot forces a
    // rendering update; the app's own rAF paint then runs as on a device.
    await pg.screenshot();
    // The label fades in (150ms); a loaded runner may take longer to paint.
    await pg
      .waitForFunction(
        ([x, y]) =>
          document
            .elementsFromPoint(x, y)
            .some(
              (e) =>
                Number(getComputedStyle(e.closest("[data-reveal]") ?? e).opacity) > 0.5 &&
                e.closest("[data-reveal]"),
            ),
        [x, y],
        { timeout: 2000 },
      )
      .catch(() => {});
    mid = await hit();
    if (mid !== "label:3") {
      // Why not: the slip's transform and the underlay's state.
      const why = await pg.evaluate(() => {
        const u = document.querySelector("[data-swipe-underlay]");
        const moved = document.querySelector('[role="list"] [style*="translate"]');
        return `transform=${moved?.style.transform ?? "none"} underlay=${u?.style.visibility}`;
      });
      mid += ` (${why})`;
    }
    await pg.mouse.move(cx, y, { steps: 10 });
    await pg.mouse.up();
  }
  await pg.waitForTimeout(500);
  return `${rest} → ${mid}`;
}
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
  // Sign-in ends in a full page load of /home; let it land, or the goto below
  // aborts it mid-flight (net::ERR_ABORTED).
  await page.waitForURL((u) => /\/home|\/list/.test(u.toString()), { timeout: 20000 });
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

  // Glass: the list fills the window and scrolls under the toolbar and the
  // help strip, which float over it fixed, translucent and blurred.
  const glass = await page.evaluate(() => {
    const list = document.querySelector('[role="list"]');
    const bars = ["[data-words-top]", "[data-words-help]"].map((q) => {
      const el = document.querySelector(q);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        fixed: cs.position === "fixed",
        blur: /blur\(12px\)/.test(cs.backdropFilter || cs.webkitBackdropFilter || ""),
        alpha: Number(/\/\s*([\d.]+)\s*\)$/.exec(cs.backgroundColor)?.[1] ?? 1),
      };
    });
    const r = list.getBoundingClientRect();
    return {
      bars,
      listFixed: getComputedStyle(list).position === "fixed",
      full: Math.round(r.top) === 0 && Math.round(r.bottom) === innerHeight,
      scrollPad: parseFloat(getComputedStyle(list).scrollPaddingTop),
      tray: document.querySelectorAll('[role="list"] [data-empty-tray][aria-hidden="true"] svg')
        .length,
    };
  });
  check(
    glass.bars.every((b) => b && b.fixed && b.blur && b.alpha < 0.7),
    `the toolbar and the help strip are fixed glass overlays (${JSON.stringify(glass.bars)})`,
  );
  check(
    glass.listFixed && glass.full && glass.scrollPad > 0,
    `the list fills the window under the overlays, scroll-padded by them (${glass.scrollPad}px)`,
  );
  check(glass.tray === 2, `an empty tray fills the over-scroll at both ends (${glass.tray})`);
  {
    // Scrolled, a row passes under the toolbar: the bar covers the list.
    const under = await page.evaluate(async () => {
      const list = document.querySelector('[role="list"]');
      const bar = document.querySelector("[data-words-top]").getBoundingClientRect();
      const before = list.scrollTop;
      list.scrollTop = before + 120;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const covered = [...list.querySelectorAll('[role="listitem"]')].some((row) => {
        const b = row.getBoundingClientRect();
        return b.top < bar.bottom && b.bottom > bar.top;
      });
      list.scrollTop = before;
      return { covered, doc: document.scrollingElement.scrollTop };
    });
    check(
      under.covered && under.doc === 0,
      `the list scrolls under the glass toolbar; the page itself never scrolls (${JSON.stringify(under)})`,
    );
  }

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
  // The list's progress (lib/words/progress.ts): a word just studied scores a little.
  const prog = (await listsNow())?.progress;
  check(
    typeof prog === "number" && prog > 0 && prog < 1,
    `the list's progress counts the studied word, partly (${prog})`,
  );
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

  // The open Settings panel is UI state of this tab (docs/ui-state.md): it
  // is still open after the refresh.
  check(
    await page.getByRole("switch", { name: "Server voice" }).isVisible(),
    "the Settings panel stays open across a refresh (sessionStorage)",
  );
  // Where the reader was is this tab's UI state too: scrolled down, a
  // refresh reopens at the same word; /words with no ?list= reopens the list.
  {
    const topRow = () =>
      page.evaluate(() => {
        const bar = document.querySelector("[data-words-top]")?.getBoundingClientRect().bottom ?? 0;
        let best = "";
        let d = Infinity;
        for (const r of document.querySelectorAll('[role="listitem"]')) {
          const y = Math.abs(r.getBoundingClientRect().top - bar);
          if (y < d) [d, best] = [y, (r.textContent ?? "").trim().slice(0, 40)];
        }
        return best;
      });
    const first = await topRow();
    await page.locator('[role="list"]').hover();
    await page.mouse.wheel(0, 44 * 8);
    await page.waitForTimeout(600);
    const before = await topRow();
    await page.reload({ waitUntil: "networkidle" });
    await rows.first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    const after = await topRow();
    check(
      before !== first && after === before,
      `a refresh reopens at the same word (${first} → ${before} → ${after})`,
    );
    const listUrl = new URL(page.url());
    const bare = new URL(page.url());
    bare.searchParams.delete("list");
    await page.goto(bare.href, { waitUntil: "networkidle" });
    await rows.first().waitFor({ timeout: 15000 });
    check(
      new URL(page.url()).searchParams.get("list") === listUrl.searchParams.get("list"),
      `no ?list=: this tab's list reopens (${new URL(page.url()).search})`,
    );
    // Back to the opening position for the checks below.
    await page.evaluate(() => {
      for (const k of Object.keys(sessionStorage)) {
        if (!k.startsWith("lk:ui:")) continue;
        const v = JSON.parse(sessionStorage.getItem(k) ?? "null");
        if (!v?.state?.anchors) continue;
        v.state.anchors = {};
        sessionStorage.setItem(k, JSON.stringify(v));
      }
    });
    await page.reload({ waitUntil: "networkidle" });
    await rows.first().waitFor({ timeout: 15000 });
  }
  // The server voice is the default (browser voices can mislead): moving to
  // a word plays the server's recording (stubbed: no AI call, nothing audible).
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

  // Hints follow the input: a keyboard was used, so key hints, no gestures.
  const deskHint = await page.locator("text=? all keys").count();
  check(
    deskHint === 1 && (await page.locator("text=/tap = show/").count()) === 0,
    "with a keyboard the hints are keys, not gestures",
  );

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
  // The page links only the seal's versioned files (the ?v= busts Chrome's
  // sticky favicon cache) — no Next.js app/favicon.ico left behind.
  const iconLinks = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map((l) =>
      l.getAttribute("href"),
    ),
  );
  check(
    iconLinks.length >= 2 && iconLinks.every((h) => /\?v=\d+$/.test(h ?? "")),
    `the page links only versioned seal icons (${iconLinks.join(", ")})`,
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
  /** Visible text, aria-labels, titles and placeholders that say "debug". */
  const debugText = (p) =>
    p.evaluate(() => {
      const hits = [];
      const shown = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden";
      };
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const el = n.parentElement;
        if (!el || el.closest("script,style,noscript")) continue;
        if (/debug/i.test(n.textContent ?? "") && shown(el)) hits.push(n.textContent.trim());
      }
      for (const el of document.querySelectorAll("[aria-label],[title],[placeholder]")) {
        for (const at of ["aria-label", "title", "placeholder"]) {
          const v = el.getAttribute(at);
          if (v && /debug/i.test(v)) hits.push(`${at}=${v}`);
        }
      }
      return hits;
    });
  // The installed app has no address bar: seven quick taps on the Settings
  // button toggle the debug log instead (the stats line stays selectable text).
  const gear = page.getByRole("button", { name: "Settings" });
  for (let k = 0; k < 7; k++) await gear.click();
  check((await page.locator("[data-debug-badge]").count()) === 1, "seven taps turn debug on");
  {
    // Users know debug mode as their "Learning Partner" (docs/dev-debug-widget.md).
    const badge = (await page.locator("[data-debug-badge]").innerText()).trim();
    const hits = await debugText(page);
    check(
      badge === "Learning Partner" && hits.length === 0,
      `debug on, /words names the Learning Partner and shows no "debug" (badge "${badge}", ${JSON.stringify(hits)})`,
    );
  }
  check(
    (await page.locator('[data-debug-proto="slip"][href="/proto/slip"]').count()) === 1 &&
      (await page.locator("[data-debug-proto]").count()) === 1,
    "debug mode links the slip prototype (and nothing else)",
  );
  for (let k = 0; k < 7; k++) await gear.click();
  check((await page.locator("[data-debug-badge]").count()) === 0, "seven more turn it off");
  // The same hidden switch on every page: ten quick taps on your own name in
  // the profile menu (the menu stays open between taps).
  {
    const flag = () => page.evaluate(() => localStorage.getItem("lk:debug"));
    await page.locator("[data-profile-menu]").click();
    const name = page.locator("[data-debug-name]");
    await name.waitFor({ timeout: 5000 });
    for (let k = 0; k < 10; k++) await name.click();
    const on = await flag();
    for (let k = 0; k < 10; k++) await name.click();
    check(
      on === "1" && (await flag()) === "0",
      `ten taps on your name in the profile menu toggle debug (${on})`,
    );
    await page.keyboard.press("Escape");
  }

  // With the Learning Partner on (via the ?agent=1 alias), no visible text on
  // /profile, /preferences or the profile menu says "debug" (/words is checked
  // above). Owner-only dev pages are exempt.
  {
    const origin = new URL(page.url()).origin;
    const tab = await ctx.newPage();
    const seen = {};
    for (const path of ["/profile?agent=1", "/preferences"]) {
      await tab.goto(`${origin}${path}`, { waitUntil: "networkidle" });
      seen[path] = await debugText(tab);
    }
    // The profile menu marks the mode by name: "you@… · Learning Partner".
    await tab.locator("[data-profile-menu]").click();
    const name = tab.locator("[data-debug-name]");
    await name.waitFor({ timeout: 5000 });
    const marker = (await name.innerText()).trim();
    seen.menu = await debugText(tab);
    const flag = await tab.evaluate(() => [
      localStorage.getItem("lk:agent"),
      localStorage.getItem("lk:debug"),
    ]);
    check(
      flag.join() === "1,1" && marker.endsWith("· Learning Partner"),
      `?agent=1 turns the Learning Partner on under both keys (${flag.join()}, menu "${marker}")`,
    );
    check(
      Object.values(seen).every((h) => h.length === 0),
      `no visible "debug" on /profile, /preferences or the menu with it on (${JSON.stringify(seen)})`,
    );
    // ?agent=0 is applied after hydration, which can come after "load": wait
    // for the flag itself, or closing the tab can leave the Learning Partner
    // on for every later check (the version notice then auto-reloads).
    await tab.goto(`${origin}/profile?agent=0`, { waitUntil: "load" });
    await tab.waitForFunction(
      () => localStorage.getItem("lk:agent") === "0" && localStorage.getItem("lk:debug") === "0",
      null,
      { timeout: 15000 },
    );
    await tab.close();
  }

  // The study view speaks the app's language: on a French or Chinese phone
  // the Settings sheet, the toolbar and the help strip show no English (one
  // French item among English ones was the owner's report, 2026-10-30). The
  // English run supplies the phrases to look for; brand and voice names stay.
  {
    const { devices } = await import("playwright");
    const listUrl = page.url().replace(/[?&]lang=[^&]*/, "");
    /** Visible text, aria-labels and titles of the sheet, toolbar controls and help strip. */
    const studyText = async (lang, colorScheme) => {
      const c = await browser.newContext({
        ...devices["iPhone 13"],
        colorScheme,
        storageState: await ctx.storageState(),
      });
      await c.addInitScript(silentAudio);
      await c.addInitScript(() => localStorage.setItem("lk:first-run", "account"));
      await c.route("**/api/words/tts?*", (r) =>
        r.fulfill({ contentType: "audio/wav", body: Buffer.from("RIFF0000WAVE") }),
      );
      const p = await c.newPage();
      p.on("pageerror", (e) => errs.push(`PAGEERROR (${lang}) ${e.message}`));
      await p.goto(`${listUrl}${listUrl.includes("?") ? "&" : "?"}lang=${lang}`, {
        waitUntil: "networkidle",
      });
      await p.locator('[role="listitem"]').first().waitFor({ timeout: 15000 });
      await p.locator("[data-words-top] button[aria-expanded]").click();
      await p.locator("[data-words-settings]").waitFor({ timeout: 5000 });
      const htmlLang = await p.evaluate(() => document.documentElement.lang);
      const texts = await p.evaluate(() => {
        const out = [];
        const roots = [
          ...document.querySelectorAll("[data-words-settings], [data-words-help]"),
          // The toolbar's own words: not the list's name (that is data).
          ...document.querySelectorAll("[data-words-top] button, [data-words-top] .tabular-nums"),
        ];
        for (const root of roots) {
          out.push(root.innerText);
          for (const el of [root, ...root.querySelectorAll("[aria-label],[title]")])
            for (const at of ["aria-label", "title"])
              if (el.getAttribute(at)) out.push(el.getAttribute(at));
        }
        return out.join("\n");
      });
      if (process.env.QA_SHOTS && lang !== "en")
        await p.screenshot({ path: `${process.env.QA_SHOTS}/settings-${lang}-${colorScheme}.png` });
      await c.close();
      return { htmlLang, texts };
    };
    const en = await studyText("en", "light");
    // English phrases of three letters or more; names that stay as they are.
    const KEEP = /^(Lianki|VOICEVOX|No|Kokoro|Piper|Thorsten-Voice|Dmitri|MeloTTS|min)$/;
    const phrases = [
      ...new Set(
        en.texts
          .split(/[\n·()=:,.;?↶←→↑↓✓…–—\d/+"“”]+/)
          .flatMap((s) => s.trim().split(/\s+(?=[A-Z])|^\s+|\s+$/))
          .map((s) => s.trim())
          .filter((s) => /^[A-Za-z' -]{3,}$/.test(s) && !KEEP.test(s)),
      ),
    ];
    check(
      phrases.length > 10,
      `the English study view has phrases to look for (${phrases.length})`,
    );
    for (const lang of ["fr", "zh"]) {
      for (const scheme of ["light", "dark"]) {
        const got = await studyText(lang, scheme);
        if (scheme === "dark") continue; // same strings; the dark run is for the screenshots
        const left = phrases.filter((ph) =>
          new RegExp(
            `(^|[^\\p{L}])${ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`,
            "u",
          ).test(got.texts),
        );
        check(
          got.htmlLang.split("-")[0] === lang && left.length === 0,
          `${lang}: the study Settings, toolbar and help show no English (lang=${got.htmlLang}, ${JSON.stringify(left)})`,
        );
      }
    }
  }

  // /learn speaks the page's language (it used to be English-only) and links
  // AnkiWeb's shared decks for each language we teach.
  {
    const learn = await ctx.newPage();
    await learn.goto(`${new URL(page.url()).origin}/learn?lang=fr`, { waitUntil: "load" });
    const deckLinks = learn.locator(
      '[data-anki-decks] a[href^="https://ankiweb.net/shared/decks"]',
    );
    await deckLinks
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => {});
    const h1 = (await learn.locator("h1").first().innerText()).trim();
    check(
      h1 !== "Import Learning Materials" && (await deckLinks.count()) >= 10,
      `/learn?lang=fr is translated and lists AnkiWeb decks (h1 "${h1}", ${await deckLinks.count()} links)`,
    );
    check(
      (await learn.locator('[data-anki-decks] a[href*="/words/import"]').count()) === 1,
      "/learn's shared decks lead to /words/import",
    );
    // ?lang= is for an explicit switch only: the app's own links stay bare, and
    // the language rides on the cookie that the explicit ?lang= just set.
    const langLinks = await learn
      .locator('a[href^="/"]')
      .evaluateAll((as) =>
        as.map((a) => a.getAttribute("href")).filter((h) => /[?&]lang=/.test(h)),
      );
    check(
      langLinks.length === 0,
      `app links carry no ?lang= (${langLinks.slice(0, 3).join(", ")})`,
    );
    await learn.goto(`${new URL(page.url()).origin}/learn`, { waitUntil: "load" });
    const bareH1 = (await learn.locator("h1").first().innerText()).trim();
    check(bareH1 === h1, `a bare /learn after ?lang=fr stays French ("${bareH1}")`);
    // Back to English: /words is translated now too, and the checks below
    // find its buttons by their English names.
    await learn.goto(`${new URL(page.url()).origin}/learn?lang=en`, { waitUntil: "load" });
    await learn.close();
  }

  // Granting Pro by hand is the owner's alone too.
  const grant = await page.request.post(`${new URL(page.url()).origin}/api/dev/membership`, {
    data: { email: "someone@example.com", days: 7 },
  });
  check(grant.status() === 404, `granting Pro is owner-only (${grant.status()})`);
  // So is the list of every account.
  const users = await page.request.get(`${new URL(page.url()).origin}/dev/users`);
  check(users.status() === 404, `/dev/users is owner-only (${users.status()})`);

  // The owner's remote-debug log is the owner's alone.
  const devLog = await page.request.post(`${new URL(page.url()).origin}/api/dev/log`, {
    data: "{}",
  });
  check(devLog.status() === 404, `the debug log is owner-only (${devLog.status()})`);
  // The owner-only check stays a 404 for anyone else.
  const whoami = await page.request.get(`${new URL(page.url()).origin}/api/dev/whoami`);
  check(whoami.status() === 404, `/api/dev/whoami is owner-only (${whoami.status()})`);
  // The debug socket (lianki-push) admits any signed-in user, as whoever
  // this names: a non-owner is a "friend" with their own chat thread, never
  // the owner's. The hub's thread and pairing rules are unit-tested
  // (unit/debug-hub.test.ts): lianki-push is not part of the local Worker,
  // so the socket never opens here and no chat box shows.
  const identity = await page.request.get(`${new URL(page.url()).origin}/api/debug/identity`);
  const who = identity.ok() ? await identity.json() : {};
  check(
    identity.status() === 200 &&
      who.owner === false &&
      typeof who.userId === "string" &&
      !!who.email,
    `the debug identity names a signed-in non-owner as a friend (${identity.status()} ${JSON.stringify({ owner: who.owner, hasId: !!who.userId })})`,
  );
  const guest = await browser.newContext();
  const guestIdentity = await guest.request.get(`${new URL(page.url()).origin}/api/debug/identity`);
  await guest.close();
  check(
    guestIdentity.status() === 401,
    `the debug identity refuses a guest (${guestIdentity.status()})`,
  );
  const friends = await page.request.get(`${new URL(page.url()).origin}/api/dev/friends`);
  check(friends.status() === 404, `the friends list is owner-only (${friends.status()})`);
  const friendsPage = await page.request.get(`${new URL(page.url()).origin}/dev/friends`);
  check(friendsPage.status() === 404, `/dev/friends is owner-only (${friendsPage.status()})`);
  check(
    (await page.locator("[data-debug-eval]").count()) === 0,
    "a non-owner page with no debug socket (no lianki-push here) shows no remote-eval UI",
  );
  check(
    (await page.locator("[data-debug-chat]").count()) === 0,
    "a non-owner page with no debug socket (no lianki-push here) shows no chat box",
  );

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
  // A Learning Partner device reloads by itself instead of showing the
  // button: this check is about a user's device, so the flag must be off.
  const partnerFlags = () =>
    page.evaluate(() => [localStorage.getItem("lk:agent"), localStorage.getItem("lk:debug")]);
  const partnerBefore = await partnerFlags();
  check(
    !partnerBefore.includes("1"),
    `the Learning Partner is off before the version notice check (${partnerBefore.join()})`,
  );
  await page.evaluate(() => localStorage.setItem("lk:version-notice", "1"));
  await page.reload({ waitUntil: "load" });
  await page.bringToFront();
  const notice = page.getByRole("button", { name: "New version · Refresh" });
  await notice.waitFor({ timeout: 15000 }).catch(() => {});
  check(await notice.isVisible(), "a newer build pushed over the socket shows a Refresh button");
  // With the Learning Partner on, the page reloads itself once for that
  // build; when the reload still hears the old build is stale, it shows the
  // button rather than reloading again and again.
  {
    await page.evaluate(() => {
      for (const k of ["lk:agent", "lk:debug"]) localStorage.setItem(k, "1");
      sessionStorage.removeItem("lk:reloaded-for");
    });
    let loads = 0;
    const onLoad = () => loads++;
    page.on("load", onLoad);
    await page.reload({ waitUntil: "load" });
    await notice.waitFor({ timeout: 20000 }).catch(() => {});
    const shown = await notice.isVisible().catch(() => false);
    await page.waitForTimeout(3000); // a second auto-reload would land in here
    page.off("load", onLoad);
    check(
      shown && loads === 2,
      `a Learning Partner device reloads once for a new build, then shows Refresh (loads ${loads}, shown ${shown})`,
    );
  }
  await page.evaluate(() => {
    localStorage.removeItem("lk:version-notice");
    for (const k of ["lk:agent", "lk:debug"]) localStorage.setItem(k, "0");
  });
  await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  await page.reload({ waitUntil: "load" });
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

  // Phone, once per swipe implementation: "js" (WordRow, JS detents — the
  // default) and "native" (NativeSlipRow, the experimental "New swipe" — each
  // slip a native horizontal scroller, turned on by its Settings switch).
  // Both must look and behave the same; only the gesture mechanism differs.
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
    // A phone of its own: not the desktop's remembered keyboard.
    await phone.addInitScript(() => localStorage.removeItem("lk:input-modality"));
    const ttsAsked = [];
    const ttsTexts = [];
    await phone.route("**/api/words/tts?*", (r) => {
      const q = new URL(r.request().url()).searchParams;
      ttsAsked.push(q.get("lang"));
      ttsTexts.push(q.get("text"));
      return r.fulfill({ contentType: "audio/wav", body: Buffer.from("RIFF0000WAVE") });
    });
    /** Variant A's slip look, to hold variant B's against. */
    let lookA = null;
    for (const variant of ["js", "native"]) {
      const tag = `phone/${variant}:`;
      const m = await phone.newPage();
      m.on("pageerror", (e) => errs.push(`PAGEERROR (${tag}) ${e.message}`));
      await m.goto(page.url(), { waitUntil: "networkidle" });
      const mrows = m.locator('[role="listitem"]');
      await mrows.first().waitFor({ timeout: 15000 });
      if (variant === "native") {
        // The experimental switch, under its own heading in Settings.
        await m.getByRole("button", { name: "Settings" }).click();
        check(
          (await m.locator("[data-experimental]").innerText()).includes("It may change or go away"),
          `${tag} Settings has an Experimental section with its note`,
        );
        const sw = m.getByRole("switch", { name: "New swipe" });
        check(
          (await sw.getAttribute("aria-checked")) === "false",
          `${tag} New swipe is off by default`,
        );
        await sw.click();
        await m.getByRole("button", { name: "Settings" }).click();
        await m.locator('[data-swipe="native"]').first().waitFor({ timeout: 5000 });
        check(
          (await m.evaluate(() => localStorage.getItem("lk:swipe-ab"))) === "native" &&
            (await m.locator('[data-swipe="native"]').count()) === (await mrows.count()),
          `${tag} the switch turns every row native at once, and is remembered`,
        );
        // Back to the top, as a fresh page would open.
        await m.reload({ waitUntil: "networkidle" });
        await mrows.first().waitFor({ timeout: 15000 });
        check(
          (await m.locator('[data-swipe="native"]').count()) > 0,
          `${tag} still native after a reload`,
        );
      } else {
        check(
          (await m.locator('[data-swipe="native"]').count()) === 0,
          `${tag} rows are WordRow by default`,
        );
      }
      await m.waitForTimeout(500); // let the opening scroll settle
      if (variant === "js") {
        // Prefetch: the visible rows' audio is fetched before any tap.
        const firstRow = await mrows.nth(0).innerText();
        check(
          ttsTexts.length > 1 && ttsTexts.some((t) => t && firstRow.includes(t)),
          `${tag} the visible rows' audio is fetched before the first tap (${ttsTexts.length} clips)`,
        );
        // Hints follow the input used last: gestures on a phone, keys once a
        // hardware keyboard is used, gestures again after a touch.
        const gestures = () => m.locator("text=/tap = show/").count();
        const keys = () => m.locator("text=? all keys").count();
        const seeded = [await gestures(), await keys()].join();
        await m.keyboard.press("Shift");
        await m
          .locator("text=? all keys")
          .waitFor({ timeout: 3000 })
          .catch(() => {});
        const typed = [await gestures(), await keys()].join();
        const hint = await m.locator("text=? all keys").boundingBox();
        if (hint) await m.touchscreen.tap(hint.x + 5, hint.y + 5);
        await m
          .locator("text=/tap = show/")
          .waitFor({ timeout: 3000 })
          .catch(() => {});
        const touched = [await gestures(), await keys()].join();
        check(
          seeded === "1,0" && typed === "0,1" && touched === "1,0",
          `${tag} hints follow the last input: touch, keyboard, touch (${seeded} → ${typed} → ${touched})`,
        );
      }
      // The list runs under the glass toolbar; it opens with the first word
      // just below it, not behind it.
      const barBottom = await m
        .locator("[data-words-top]")
        .evaluate((el) => el.getBoundingClientRect().bottom);
      const firstTop = (await mrows.nth(0).boundingBox()).y;
      check(
        firstTop >= barBottom - 2 && firstTop - barBottom < 50,
        `${tag} the list opens with the first word just under the toolbar (${Math.round(firstTop - barBottom)}px)`,
      );
      // Parity: the face of a slip — the row itself (A) or the scroller's
      // face (B) — carries the same paper, node line, seam and cords.
      const look = await m.evaluate(() => {
        const faces = [...document.querySelectorAll('[role="listitem"]')]
          .slice(0, 3)
          .map((r) => r.querySelector(".slip-face") ?? r);
        const cs = faces.map((f) => getComputedStyle(f));
        const scroller = document.querySelector('[role="listitem"] .slip-scroller');
        return {
          image: cs[0].backgroundImage,
          size: cs[0].backgroundSize,
          classes: faces[0].className
            .split(/\s+/)
            .filter((c) => /^slip|^grid|^text-base|^pr-/.test(c) && c !== "slip-face")
            .sort()
            .join(" "),
          // The grain shifts per row.
          grains: new Set(cs.map((c) => c.backgroundPosition)).size,
          cords: faces.every((f) => f.querySelector("[data-cords]")),
          width: Math.round(faces[0].getBoundingClientRect().width),
          left: Math.round(faces[0].getBoundingClientRect().left),
          centred: scroller ? Math.round(scroller.scrollLeft) : null,
        };
      });
      check(
        look.image.includes("bamboo") && look.cords && look.grains === 3,
        `${tag} slips have the bamboo paper, cords, and a grain per row (${look.grains})`,
      );
      if (variant === "js") lookA = look;
      else {
        check(
          look.image === lookA.image &&
            look.size === lookA.size &&
            look.classes === lookA.classes &&
            look.width === lookA.width &&
            look.left === lookA.left,
          `${tag} the face matches A's slip: background layers, classes, place (${look.classes} · ${look.width}px@${look.left})`,
        );
        check(look.centred === 88, `${tag} each slip starts centred (scrollLeft ${look.centred})`);
      }
      await shot(m, `ab-${variant}-rest`);
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
      check(spoken > 0, `${tag} holding speaks the word (${spoken} utterances)`);

      await m.mouse.up();
      await m.waitForTimeout(100);
      check(whileHeld && (await blurredM()), `${tag} holding a row reveals it, releasing hides it`);
      if (variant === "js") await shot(m, "words-phone");
      // A tap says the word once (releasing a hold stops speech, so tap here).
      const playedBefore = await m.evaluate(() => window.__played.length);
      await m.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await m
        .waitForFunction((n) => window.__played.length > n, playedBefore, { timeout: 6000 })
        .catch(() => {});
      check(
        ttsAsked.length > 0 && (await m.evaluate(() => window.__played.length)) > playedBefore,
        `${tag} speech that never starts falls back to server audio (${ttsAsked.length} clips asked)`,
      );
      // Focus = that slip's cords come loose (no more green bar).
      check(
        (await mrows.nth(0).getAttribute("class")).includes("slip-loose") &&
          (await m.locator('[role="listitem"].slip-loose').count()) === 1 &&
          (await mrows.nth(0).locator('[data-cords="loose"]').count()) === 1,
        `${tag} the tapped slip is the one loose slip`,
      );
      // Visual: the loose cords hang at the slip's two edges, with animations
      // on and off ("Disable animations" sets html[data-motion=off], which
      // zeroes every animation-duration: B's scroll-driven .slip-pin then
      // sat on its last keyframe and hung the cords 2a into the slip).
      for (const motion of ["on", "off"]) {
        const cords = await mrows.nth(0).evaluate(async (row, motion) => {
          if (motion === "off") document.documentElement.dataset.motion = "off";
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const rb = row.getBoundingClientRect();
          const paths = [...row.querySelectorAll('[data-cords="loose"] path')].map((p) => {
            const b = p.getBoundingClientRect();
            return [Math.round(b.left - rb.left), Math.round(rb.right - b.right)];
          });
          return paths;
        }, motion);
        await shot(m, `cords-${variant}-motion-${motion}`);
        check(
          cords.length === 2 &&
            cords[0][0] >= 0 &&
            cords[0][0] <= 12 &&
            cords[1][1] >= 0 &&
            cords[1][1] <= 12,
          `${tag} the loose cords hang at the slip's edges, animations ${motion} (${JSON.stringify(cords)})`,
        );
      }
      await m.evaluate(() => delete document.documentElement.dataset.motion);
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
        `${tag} a double tap opens the sheet`,
      );
      check(
        (await blurredM()) === shownBefore,
        `${tag} the double tap leaves the reveal as it was`,
      );
      // The sheet shows the example in full, and the word's tags (its list,
      // the list's level), which the row never shows.
      check(
        (await m.locator("[data-slip-sheet] [data-sheet-example]").count()) === 1,
        `${tag} the sheet shows the word's example sentence`,
      );
      check(
        (await m.locator("[data-slip-sheet] [data-sheet-tags] span").count()) > 0,
        `${tag} the sheet shows the word's tags`,
      );
      // One row = the whole card: front, then the back (meaning, then the
      // example), in the row's fixed height, so the windowing stays exact.
      const unified = await mrows.nth(0).evaluate((el) => ({
        example: el.querySelectorAll("[data-row-back] [data-row-example]").length,
        h: Math.round(el.getBoundingClientRect().height),
      }));
      check(
        unified.example === 1 && unified.h === 44,
        `${tag} the row shows the example under the meaning, at the fixed height (${JSON.stringify(unified)})`,
      );
      await m.getByRole("button", { name: "Cancel" }).click();
      check((await m.locator("[data-slip-sheet]").count()) === 0, `${tag} Cancel closes the sheet`);
      // Swipe vs scroll: a steep drag is a scroll and never grades; a clearly
      // sideways drag grades. A: pointer drags (WordRow reads pointer events).
      // B: real touches through CDP, so Chromium's own gesture code scrolls the
      // slip — axis latching, snapping and scrollend are the browser's.
      const mStatus = async (i) =>
        (await mrows.nth(i).locator("span.tabular-nums").innerText()).trim();
      const cdp = variant === "native" ? await phone.newCDPSession(m) : null;
      const touch = (type, x, y) =>
        cdp.send("Input.dispatchTouchEvent", {
          type,
          touchPoints: type === "touchEnd" ? [] : [{ x, y }],
        });
      const drag = async (i, dx, dy) => {
        const b = await mrows.nth(i).boundingBox();
        const x = b.x + b.width / 2;
        const y = b.y + b.height / 2;
        if (cdp) {
          await touch("touchStart", x, y);
          for (let k = 1; k <= 8; k++) {
            await touch("touchMove", x + (dx * k) / 8, y + (dy * k) / 8);
            await m.waitForTimeout(16);
          }
          await m.waitForTimeout(80);
          await touch("touchEnd");
          await m.waitForTimeout(900); // snap, scrollend, glide home
          return;
        }
        await m.mouse.move(x, y);
        await m.mouse.down();
        for (let k = 1; k <= 8; k++) await m.mouse.move(x + (dx * k) / 8, y + (dy * k) / 8);
        await m.waitForTimeout(80); // stop before lifting: distance, not a flick
        await m.mouse.up();
        await m.waitForTimeout(400);
      };
      const before = await mStatus(3);
      await drag(3, 40, 45);
      check((await mStatus(3)) === before, `${tag} a diagonal drag does not grade (${before})`);
      await drag(3, 70, 4);
      const after = await mStatus(3);
      check(after !== before, `${tag} a sideways drag grades (${before} → ${after})`);
      // An undo right after a swipe (undoing it) is logged against the variant.
      await m.getByRole("button", { name: "Undo" }).click();
      const undoRow = await m.evaluate(() =>
        JSON.parse(localStorage.getItem("lk:swipe-unsent") ?? "[]")
          .map((r) => r.params)
          .find((p) => p.includes("ev=undo") && p.includes(`ab=`)),
      );
      check(
        !!undoRow && undoRow.includes(`ab=${variant}`),
        `${tag} an undo within 5 s of a swipe is logged (${undoRow})`,
      );
      if (cdp) {
        // It glided home, and the list scrolled on by a row as in A.
        const home = await m.evaluate(() =>
          Math.round(document.querySelectorAll(".slip-scroller")[3].scrollLeft),
        );
        check(home === 88, `${tag} the graded slip glides home (scrollLeft ${home})`);
        // A vertical drag on a slip scrolls the list.
        const top0 = await m.locator('[role="list"]').evaluate((el) => el.scrollTop);
        await drag(6, 0, -120);
        const top1 = await m.locator('[role="list"]').evaluate((el) => el.scrollTop);
        check(
          top1 > top0 + 40,
          `${tag} a vertical drag on a slip scrolls the list (${top0} → ${top1})`,
        );
      }
      // What the slip uncovers: A's list-wide grade strip put under that row;
      // B's strip of the same zones, held still behind the face.
      const under = await m.evaluate((native) => {
        const rows = document.querySelectorAll('[role="listitem"]');
        if (native) {
          const r = rows[3];
          const strip = r?.querySelector("[data-swipe-strip]");
          const s = r?.querySelector(".slip-scroller");
          if (!strip || !s) return "missing";
          // Slid right by a: the strip must not move with the face.
          s.scrollTo({ left: 44, behavior: "instant" });
          const still = Math.round(
            strip.getBoundingClientRect().left - r.getBoundingClientRect().left,
          );
          s.scrollTo({ left: 88, behavior: "instant" });
          return `${getComputedStyle(strip).visibility}:${still === 0}:${strip.querySelectorAll("[data-reveal]").length}`;
        }
        const u = document.querySelector("[data-swipe-underlay]");
        const row = rows[3];
        return u && row
          ? `${getComputedStyle(u).visibility}:${u.offsetTop === row.offsetTop}:${u.querySelectorAll("[data-reveal]").length}`
          : "missing";
      }, variant === "native");
      check(
        under === "visible:true:4",
        `${tag} the grade strip sits under the slid row (${under})`,
      );
      await m.waitForTimeout(400);
      if (variant === "js") {
        // The reveal: the far detent's grade replaces the first one's in the
        // same spot (Good → Easy, Hard → Again), and going back restores it.
        const listTop = (await m.locator('[role="list"]').boundingBox()).y;
        let b = null;
        for (let i = 0; !b; i++) {
          const bi = await mrows.nth(i).boundingBox();
          if (bi && bi.y > listTop + 200) b = bi;
        }
        const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
        const shown = () =>
          m.evaluate(() => {
            const u = document.querySelector("[data-swipe-underlay]");
            const side = (slot) =>
              [...u.querySelectorAll(`[data-reveal-slot="${slot}"] > [data-reveal]`)]
                .filter((el) => Number(getComputedStyle(el).opacity) > 0.5)
                .map((el) => el.textContent)
                .join("+");
            return `${side("hard")}|${side("good")}`;
          });
        await m.mouse.move(x, y);
        await m.mouse.down();
        const seen = [];
        for (const dx of [48, 96, 48, -48, -96, -48]) {
          await m.mouse.move(x + dx, y, { steps: 10 });
          await m.waitForTimeout(250);
          seen.push(await shown());
        }
        await m.mouse.move(x, y, { steps: 10 });
        await m.mouse.up();
        await m.waitForTimeout(600);
        check(
          seen.join(" ") === "Hard|Good Hard|Easy Hard|Good Hard|Good Again|Good Hard|Good",
          `${tag} a far detent's grade replaces the first one's in place, and back (${seen.join(" ")})`,
        );
      }
      if (process.env.QA_SHOTS) {
        // Mid-swipe, held on each level, then back to rest (no grade): a
        // finger held down — a pointer for A, a real touch for B.
        // Below the glass toolbar, where the list's own top is now the window's.
        const listTop = await m
          .locator("[data-words-top]")
          .evaluate((el) => el.getBoundingClientRect().bottom);
        let b = null;
        for (let i = 0; !b; i++) {
          const bi = await mrows.nth(i).boundingBox();
          if (bi && bi.y > listTop + 88) b = bi;
        }
        const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
        if (cdp) await touch("touchStart", x, y);
        else {
          await m.mouse.move(x, y);
          await m.mouse.down();
        }
        for (const [dx, name] of [
          [48, "good"],
          [96, "easy"],
          [-48, "hard"],
          [-96, "again"],
        ]) {
          if (cdp)
            for (let k = 1; k <= 10; k++) {
              await touch("touchMove", x + dx + (k < 10 ? (k - 10) * 3 : 0), y);
              await m.waitForTimeout(16);
            }
          else await m.mouse.move(x + dx, y, { steps: 10 });
          await m.waitForTimeout(150);
          await m.screenshot({ path: `${process.env.QA_SHOTS}/ab-${variant}-mid-${name}.png` });
        }
        if (cdp) {
          for (let k = 1; k <= 10; k++) {
            await touch("touchMove", x - 96 + (96 * k) / 10, y);
            await m.waitForTimeout(16);
          }
          await m.waitForTimeout(100);
          await touch("touchEnd");
        } else {
          await m.mouse.move(x, y, { steps: 10 });
          await m.mouse.up();
        }
        await m.waitForTimeout(600);
      }
      // Swipe telemetry is queued, tagged with the variant, and the server takes it.
      const tele = await m.evaluate(async () => {
        const queued = JSON.parse(localStorage.getItem("lk:swipe-unsent") ?? "[]");
        const r = await fetch("/api/words/telemetry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ swipes: queued.slice(-5) }),
        });
        return `${queued.length}:${r.status}:${/;ab=(\w+)/.exec(queued.at(-1)?.params ?? "")?.[1]}`;
      });
      check(
        new RegExp(`^[1-9]\\d*:200:${variant}$`).test(tele),
        `${tag} swipe telemetry is queued, tagged and stored (${tele})`,
      );
      // Sent already: the next variant's checks read only their own rows.
      await m.evaluate(() => localStorage.removeItem("lk:swipe-unsent"));

      if (variant === "native") {
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
      }
      const order = await revealOrder(m, variant);
      check(
        order === "card → label:3",
        `${tag} the grade reveal is behind the slip: card at rest, label slid away (${order})`,
      );
      await m.close();
    }
    // The heavy feel (lib/words/swipe-feel.ts, docs/swipe-core.md), opt-in per
    // device, here by `?feel=heavy` for one page load: on both swipes the
    // dragged slip lifts, a sideways drag grades by the same tiers, the slip
    // springs home, and its telemetry says which feel it was.
    for (const variant of ["js", "native"]) {
      const tag = `phone/${variant}+heavy:`;
      const m = await phone.newPage();
      m.on("pageerror", (e) => errs.push(`PAGEERROR (${tag}) ${e.message}`));
      const u = new URL(page.url());
      u.searchParams.set("swipe", variant);
      u.searchParams.set("feel", "heavy");
      await m.goto(u.href, { waitUntil: "networkidle" });
      await m.evaluate(() => localStorage.removeItem("lk:swipe-unsent"));
      const mrows = m.locator('[role="listitem"]');
      await mrows.nth(3).waitFor({ timeout: 15000 });
      const cdp = variant === "native" ? await phone.newCDPSession(m) : null;
      const touch = (type, x, y) =>
        cdp.send("Input.dispatchTouchEvent", {
          type,
          touchPoints: type === "touchEnd" ? [] : [{ x, y }],
        });
      const b = await mrows.nth(3).boundingBox();
      const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
      const to = async (dx) => {
        if (cdp)
          for (let k = 1; k <= 8; k++) {
            await touch("touchMove", x + (dx * k) / 8, y);
            await m.waitForTimeout(16);
          }
        else for (let k = 1; k <= 8; k++) await m.mouse.move(x + (dx * k) / 8, y);
      };
      if (cdp) await touch("touchStart", x, y);
      else {
        await m.mouse.move(x, y);
        await m.mouse.down();
      }
      await to(70);
      await m.waitForTimeout(250);
      const lifted = await m.evaluate(
        () => document.querySelectorAll('[data-swipe-cue="up"]').length,
      );
      check(lifted === 1, `${tag} the dragged slip lifts (${lifted} lifted)`);
      if (process.env.QA_SHOTS)
        for (const scheme of ["light", "dark"]) {
          await m.emulateMedia({ colorScheme: scheme });
          await m.waitForTimeout(100);
          await m.screenshot({
            path: `${process.env.QA_SHOTS}/heavy-${variant}-mid-good-${scheme}.png`,
          });
        }
      if (cdp) await touch("touchEnd");
      else await m.mouse.up();
      await m.waitForTimeout(1500);
      const rest = await m.evaluate((native) => {
        const row = document.querySelectorAll('[role="listitem"]')[3];
        const sc = row.querySelector(".slip-scroller");
        return native
          ? `${Math.round(sc.scrollLeft)}:${sc.style.overflowX || "-"}:${sc.style.scrollSnapType || "-"}`
          : getComputedStyle(row).transform;
      }, !!cdp);
      check(
        cdp ? rest === "88:-:-" : rest === "none",
        `${tag} the slip springs home and gives the scroller back (${rest})`,
      );
      const params = await m.evaluate(
        () =>
          JSON.parse(localStorage.getItem("lk:swipe-unsent") ?? "[]")
            .filter((r) => !r.params.includes(";ev="))
            .map((r) => `${r.rating}|${r.params}`)
            .at(-1) ?? "",
      );
      check(
        params.startsWith("3|") &&
          params.includes(`ab=${variant}`) &&
          params.includes("feel=heavy") &&
          (!cdp || params.includes("scroll-snap+spring")),
        `${tag} it grades Good and its telemetry names the feel (${params})`,
      );
      await m.close();
    }
    await phone.close();
  }

  // iPhone on WebKit, both swipe variants: the page itself never scrolls, and
  // the list opens with its first word right under the glass toolbar — on
  // load, on reload, and when the list is shown again (pageshow).
  {
    const { webkit, devices } = await import("playwright");
    const wk = await webkit.launch();
    const listUrl = page.url();
    for (const variant of ["js", "native"]) {
      const tag = `webkit-iphone/${variant}:`;
      const c = await wk.newContext({
        ...devices["iPhone 13"],
        storageState: await ctx.storageState(),
      });
      await c.addInitScript(silentAudio);
      // Stubbed as everywhere else (no AI call from QA).
      await c.route("**/api/words/tts?*", (r) =>
        r.fulfill({ contentType: "audio/wav", body: Buffer.from("RIFF0000WAVE") }),
      );
      await c.addInitScript((v) => {
        localStorage.setItem("lk:first-run", "account");
        localStorage.setItem("lk:swipe-ab", v);
      }, variant);
      const w = await c.newPage();
      // WebKit reports a word-audio prefetch that a reload cuts off as a page
      // error ("… due to access control checks."). The prefetch is aborted on
      // purpose; it used to stop early only because a 503 silenced the language.
      const cutPrefetch = (m) =>
        m.includes("/api/words/tts?") && m.includes("due to access control checks");
      w.on("pageerror", (e) => {
        if (!cutPrefetch(e.message)) errs.push(`PAGEERROR (${tag}) ${e.message}`);
      });
      const opening = () =>
        w.evaluate(() => {
          const bar = document.querySelector("[data-words-top]").getBoundingClientRect().bottom;
          const row = document.querySelector('[role="listitem"]').getBoundingClientRect().top;
          return {
            scrollY: Math.round(scrollY),
            gap: Math.round(row - bar),
            native: document.querySelectorAll(".slip-native").length > 0,
          };
        });
      for (const when of ["load", "reload"]) {
        if (when === "load") await w.goto(listUrl, { waitUntil: "networkidle" });
        else await w.reload({ waitUntil: "networkidle" });
        await w.locator('[role="listitem"]').first().waitFor({ timeout: 15000 });
        await w.waitForTimeout(800);
        const o = await opening();
        check(
          o.scrollY === 0 && o.gap >= 0 && o.gap < 4 && o.native === (variant === "native"),
          `${tag} ${when}: the page doesn't scroll and the first word sits right under the toolbar (${JSON.stringify(o)})`,
        );
      }
      // Experimental "Paper scrolls with the list" (lk:words-paper-scrolls):
      // off by default — the texture stays fixed on the body and no layer is
      // mounted; on — a layer inside the list scrolls with the rows and the
      // body behind it is plain.
      const paper = () =>
        w.evaluate(async () => {
          const list = document.querySelector('[role="list"]');
          const layer = list.querySelector("[data-paper-layer]");
          const body = getComputedStyle(document.body).backgroundImage;
          if (!layer) return { layer: false, bodyPaper: body.includes("url(") };
          const at = () => Math.round(layer.getBoundingClientRect().top);
          const before = at();
          const top0 = list.scrollTop;
          list.scrollTop = top0 + 200;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const moved = before - at();
          list.scrollTop = top0;
          const cs = getComputedStyle(layer);
          return {
            layer: layer === list.firstElementChild,
            bodyPaper: body.includes("url("),
            pointer: cs.pointerEvents,
            textured: cs.backgroundImage.includes("url("),
            covers: Math.abs(layer.offsetHeight - list.scrollHeight) <= 1,
            moved,
          };
        });
      const off = await paper();
      check(
        !off.layer && off.bodyPaper,
        `${tag} paper scrolls off by default: fixed body texture, no layer (${JSON.stringify(off)})`,
      );
      await w.evaluate(() => localStorage.setItem("lk:words-paper-scrolls", "1"));
      await w.reload({ waitUntil: "networkidle" });
      await w.locator('[role="listitem"]').first().waitFor({ timeout: 15000 });
      await w.waitForTimeout(500);
      const on = await paper();
      check(
        on.layer &&
          !on.bodyPaper &&
          on.pointer === "none" &&
          on.textured &&
          on.covers &&
          on.moved === 200,
        `${tag} paper scrolls on: a layer under the rows scrolls with them, the body is plain (${JSON.stringify(on)})`,
      );
      await w.evaluate(() => localStorage.removeItem("lk:words-paper-scrolls"));
      await w.reload({ waitUntil: "networkidle" });
      await w.locator('[role="listitem"]').first().waitFor({ timeout: 15000 });
      await w.waitForTimeout(800);
      const order = await revealOrder(w, variant);
      check(
        order === "card → label:3",
        `${tag} the grade reveal is behind the slip: card at rest, label slid away (${order})`,
      );
      // The owner's iPhone PWA (414×848, a 48px status bar). env(safe-area-*)
      // can't be emulated, so the body's safe-area padding and the toolbar's
      // offset stand in for it — that padding once made the page 48px taller
      // than the window, and iOS left it scrolled by that much.
      await w.setViewportSize({ width: 414, height: 848 });
      await w.addInitScript(() =>
        document.addEventListener("DOMContentLoaded", () => {
          const st = document.createElement("style");
          st.textContent = "body{padding-top:48px!important}[data-words-top]{top:104px!important}";
          document.head.append(st);
        }),
      );
      await w.reload({ waitUntil: "networkidle" });
      await w.locator('[role="listitem"]').first().waitFor({ timeout: 15000 });
      await w.waitForTimeout(800);
      const layout = () =>
        w.evaluate(() => {
          const bar = document.querySelector("[data-words-top]").getBoundingClientRect();
          const row = document.querySelector('[role="listitem"]').getBoundingClientRect();
          return {
            scrollY: Math.round(scrollY),
            docH: document.documentElement.scrollHeight,
            innerH: innerHeight,
            barH: Math.round(bar.height),
            gap: Math.round(row.top - bar.bottom),
            sheet: !!document.querySelector("[data-words-settings]"),
          };
        });
      const pageFits = (o) => o.scrollY === 0 && o.docH <= o.innerH;
      let o = await layout();
      check(
        pageFits(o) && o.gap >= 0 && o.gap < 4,
        `${tag} 414×848 + safe area: the page is exactly the window, first word under the toolbar (${JSON.stringify(o)})`,
      );
      const gear = w.getByRole("button", { name: "Settings" });
      await gear.click();
      await w.waitForTimeout(400);
      o = await layout();
      check(
        (await w
          .locator("[data-experimental]")
          .getByRole("switch", { name: "Paper scrolls with the list" })
          .count()) === 1,
        `${tag} Experimental has the "Paper scrolls with the list" switch`,
      );
      check(
        o.sheet && o.barH <= 72 && pageFits(o) && o.gap >= 0 && o.gap < 4,
        `${tag} settings open in their own sheet: the toolbar stays ≤72px and the list doesn't move (${JSON.stringify(o)})`,
      );
      await gear.click();
      await w.waitForTimeout(400);
      o = await layout();
      check(
        !o.sheet && o.barH <= 72 && pageFits(o) && o.gap >= 0 && o.gap < 4,
        `${tag} settings closed: the first word is still right under the toolbar (${JSON.stringify(o)})`,
      );
      if (variant === "native") {
        // At rest the face covers the label strip; a completed swipe (the
        // touch sequence iOS gives: touchstart, pointercancel as the scroller
        // takes over, a scroll to the Good level, touchend resting there)
        // grades and glides back to centre.
        const s = await w.evaluate(async () => {
          const bar = document.querySelector("[data-words-top]").getBoundingClientRect().bottom;
          const row = [...document.querySelectorAll(".slip-native")].find(
            (x) => x.getBoundingClientRect().top > bar + 60,
          );
          const b = row.getBoundingClientRect();
          const y = b.top + b.height / 2;
          const face = (x) => !!document.elementFromPoint(x, y)?.closest(".slip-face");
          const sc = row.querySelector(".slip-scroller");
          const a = parseFloat(getComputedStyle(row).getPropertyValue("--a"));
          const out = {
            rest: sc.scrollLeft,
            a,
            faceAtRest: face(b.left + 20) && face(b.right - 20),
          };
          const fire = (type, x) => {
            const e = new Event(type, { bubbles: true });
            const t = [{ clientX: x, clientY: y }];
            Object.defineProperty(e, "touches", { value: type === "touchend" ? [] : t });
            Object.defineProperty(e, "changedTouches", { value: t });
            sc.dispatchEvent(e);
          };
          fire("touchstart", 100);
          sc.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          sc.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
          sc.scrollTo({ left: a, behavior: "instant" });
          await new Promise((r) => setTimeout(r, 50));
          out.slid = sc.scrollLeft;
          fire("touchend", 100 + a);
          await new Promise((r) => setTimeout(r, 1500));
          out.after = sc.scrollLeft;
          out.faceAfter = face(b.left + 20);
          out.graded = !!row.querySelector(".slip-face .lk-stamp");
          return out;
        });
        check(
          s.faceAtRest && s.rest === 2 * s.a,
          `${tag} at rest the slip's face covers its label strip (${JSON.stringify(s)})`,
        );
        check(
          s.slid === s.a && s.graded && Math.abs(s.after - s.rest) < 1 && s.faceAfter,
          `${tag} a completed swipe grades and the slip returns to centre (${JSON.stringify(s)})`,
        );
      } else {
        // ?swipe=native: that page load only, never stored — also in an iframe.
        const sep = listUrl.includes("?") ? "&" : "?";
        await w.goto(`${listUrl}${sep}swipe=native`, { waitUntil: "networkidle" });
        await w.locator('[role="listitem"]').first().waitFor({ timeout: 15000 });
        const forced = await w.evaluate(() => ({
          native: document.querySelectorAll(".slip-native").length > 0,
          stored: localStorage.getItem("lk:swipe-ab"),
        }));
        await w.setContent(
          `<iframe src="${listUrl}${sep}swipe=native&embed=1" style="width:414px;height:700px"></iframe>`,
        );
        const fr = w.frameLocator("iframe");
        await fr.locator('[role="listitem"]').first().waitFor({ timeout: 15000 });
        const framed = await fr.locator(".slip-native").count();
        await w.goto(listUrl, { waitUntil: "networkidle" });
        await w.locator('[role="listitem"]').first().waitFor({ timeout: 15000 });
        const plain = await w.locator(".slip-native").count();
        check(
          forced.native && forced.stored === "js" && framed > 0 && plain === 0,
          `${tag} ?swipe=native applies to that load only (iframe too) and is never stored (${JSON.stringify({ ...forced, framed, plain })})`,
        );
      }
      await w.close();
      await c.close();
    }
    await wk.close();
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
  await toPicker();
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
  await toPicker();
  // Each row ends in its progress ring: a percentage, labelled for screen readers.
  const ring = page.locator("[data-progress]").first();
  await ring.waitFor({ timeout: 10000 }).catch(() => {});
  const ringInfo = (await ring.count())
    ? await ring.evaluate((el) => ({
        pct: Number(el.getAttribute("data-progress")),
        label: el.getAttribute("aria-label") ?? "",
        text: el.textContent ?? "",
      }))
    : null;
  check(
    !!ringInfo &&
      ringInfo.pct >= 0 &&
      ringInfo.pct <= 100 &&
      ringInfo.text.includes("%") &&
      ringInfo.label.includes("words"),
    `each list shows its progress ring (${JSON.stringify(ringInfo)})`,
  );
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

  // ── A row's ⋯ menu: rename (keyboard only), delete with Undo ──
  const serverLists = () =>
    page.evaluate(async () => (await (await fetch("/api/words/lists")).json()).lists);
  const waitFor = async (pred) => {
    let v;
    for (let i = 0; i < 20 && !pred((v = await serverLists())); i++) await page.waitForTimeout(300);
    return v;
  };
  // The picker: forget this tab's open list, or /words reopens it.
  await page.evaluate(() => {
    for (const k of Object.keys(sessionStorage))
      if (k.startsWith("lk:ui:")) sessionStorage.removeItem(k);
  });
  await page.goto(`${BASE}/words`, { waitUntil: "networkidle" });
  const groupMenu = page.getByRole("button", { name: /More actions for .QA group/ });
  await groupMenu.waitFor({ timeout: 15000 });
  const menuBox = await groupMenu.boundingBox();
  check(
    menuBox && menuBox.width >= 44 && menuBox.height >= 44,
    `the ⋯ button is a 44px target (${menuBox?.width}×${menuBox?.height})`,
  );
  await groupMenu.focus();
  await page.keyboard.press("ArrowDown");
  const renameItem = page.getByRole("menuitem", { name: "Rename" });
  check(
    await renameItem.evaluate((el) => el === document.activeElement),
    "↓ on ⋯ opens the menu on its first item",
  );
  await page.keyboard.press("Escape");
  check(
    (await page.getByRole("menu").count()) === 0 &&
      (await groupMenu.evaluate((el) => el === document.activeElement)),
    "Escape closes the menu back to the ⋯ button",
  );
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // Rename, the focused first item
  const field = page.getByRole("textbox", { name: /New name for .QA group/ });
  await field.waitFor({ timeout: 5000 });
  await field.fill("QA folder");
  await page.keyboard.press("Enter");
  const renamed = await waitFor((ls) => ls.find((l) => l.id === group)?.name === "QA folder");
  check(
    renamed.find((l) => l.id === group)?.name === "QA folder",
    "rename from the ⋯ menu reaches the server (through the pending queue)",
  );
  await page.reload({ waitUntil: "networkidle" });
  const folderMenu = page.getByRole("button", { name: /More actions for .QA folder/ });
  await folderMenu.waitFor({ timeout: 15000 });
  check(true, "the new name survives a reload");

  // Delete, then Undo: nothing is deleted.
  await folderMenu.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const toast = page.locator("[data-undo-delete]");
  await toast.waitFor({ timeout: 5000 });
  check(
    (await toast.innerText()).includes("QA folder") && (await folderMenu.count()) === 0,
    "delete hides the row at once and shows an Undo notice",
  );
  const undoButton = toast.getByRole("button", { name: "Undo" });
  check(
    await undoButton.evaluate((el) => el === document.activeElement),
    "the Undo button takes the focus",
  );
  await undoButton.click();
  await folderMenu.waitFor({ timeout: 5000 });
  await page.waitForTimeout(9000); // past the undo window
  check(
    (await serverLists()).some((l) => l.id === group),
    "Undo keeps the group on the server",
  );

  // Delete for real: it goes out when the notice runs out; the lists stay.
  await folderMenu.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await toast.waitFor({ timeout: 5000 });
  check(
    (await serverLists()).some((l) => l.id === group),
    "the delete waits for the Undo window",
  );
  await page.waitForTimeout(8000); // the Undo window (UNDO_MS)
  const settled = await waitFor((ls) => !ls.some((l) => l.id === group));
  check(
    !settled.some((l) => l.id === group) &&
      after.every((id) => settled.find((l) => l.id === id)?.parentId === null),
    "after the Undo window the group is deleted and its lists move up",
  );

  // ── /words/import: an Anki deck dropped in becomes a word list ──
  const deckNotes = [
    { guid: "n-hola", fields: ["<b>hola</b>", "hello", "¡Hola, amigo!"] },
    { guid: "n-gato", fields: ["gato", 'cat <img src="cat.jpg">', ""] },
    { guid: "n-perro", fields: ["perro [sound:perro.mp3]", "dog", ""] },
  ];
  const apkg = await buildApkg({
    deck: "QA Spanish",
    deckId: 1700000000777,
    fields: ["Front", "Back", "Example"],
    notes: deckNotes,
  });
  await toPicker();
  // By its address: an earlier check visits /learn?lang=fr, and the language sticks.
  await page.locator('a[href*="/words/import"]').click();
  await page.waitForURL(/\/words\/import/);
  check(true, "the /words picker links to /words/import");
  // Back to English for the checks below.
  await page.goto(`${BASE}/words/import?lang=en`, { waitUntil: "networkidle" });
  // A real drop: a File in a DataTransfer, dropped on the zone.
  const drop = await page.evaluateHandle(
    (bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], "qa-spanish.apkg"));
      return dt;
    },
    [...apkg],
  );
  await page.dispatchEvent('[data-testid="apkg-drop"]', "drop", { dataTransfer: drop });
  const deckCard = page.locator('[data-testid="apkg-deck"]');
  await deckCard.waitFor({ timeout: 15000 });
  check(
    (await deckCard.locator("h2").innerText()) === "QA Spanish",
    "a dropped .apkg shows its deck",
  );
  const preview = await page.locator('[data-testid="apkg-preview"]').innerText();
  check(
    preview.includes("hola") && !preview.includes("<b>") && !preview.includes("[sound:"),
    "the preview is plain text (HTML and [sound:] stripped)",
  );
  check(
    (await page.locator('[data-testid="apkg-images"]').count()) === 1 &&
      (await page.locator('[data-testid="apkg-images"] a[href*="/import"]').count()) === 1,
    "a deck with images warns, and offers Lianki cards (/import)",
  );
  check(
    (await page.locator('select[data-role="term"]').inputValue()) === "0" &&
      (await page.locator('select[data-role="ex"]').inputValue()) === "2",
    "fields are mapped from their names (Front → word, Example → example)",
  );
  check(
    (await deckCard.locator("select").nth(0).inputValue()) === "es",
    "the language is guessed from the words (es)",
  );
  await shot(page, "words-import-desktop");
  if (process.env.QA_SHOTS) {
    const size = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: `${process.env.QA_SHOTS}/words-import-phone.png`,
      fullPage: true,
    });
    await page.setViewportSize(size);
  }
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const done = page.locator('[data-testid="apkg-done"]');
  await done.waitFor({ timeout: 15000 });
  check((await done.innerText()).includes("3 added"), `import: ${await done.innerText()}`);
  const imported = (
    await page.evaluate(async () => (await (await fetch("/api/words/lists")).json()).lists)
  ).find((x) => x.source === "anki:1700000000777");
  check(imported?.size === 3, `the imported list holds 3 words (${imported?.size})`);

  await done.getByRole("link").click();
  await page.waitForURL(/[?&]list=/);
  await rows.first().waitFor({ timeout: 15000 });
  const firstTerm = await rows.nth(0).locator("span").first().innerText();
  check(
    (await page.locator('[role="list"]').innerText()).includes("hola"),
    `the imported list opens in /words (first: ${firstTerm})`,
  );
  await shot(page, "words-import-list");
  res = reviewed();
  await page.keyboard.press("3");
  check((await (await res).status()) === 200, "a word of the imported list is graded");
  const graded = (
    await page.evaluate(async () => (await (await fetch("/api/words/lists")).json()).lists)
  ).find((x) => x.id === imported.id);
  check(graded?.cards === 1, `the grade is stored (${graded?.cards} card)`);

  // Re-import the deck, changed: one word renamed, one added — updated in
  // place, nothing doubled, the review kept.
  const apkg2 = await buildApkg({
    deck: "QA Spanish",
    deckId: 1700000000777,
    fields: ["Front", "Back", "Example"],
    notes: [
      { guid: "n-hola", fields: ["hola", "hello; hi", "¡Hola, amigo!"] },
      ...deckNotes.slice(1),
      { guid: "n-casa", fields: ["casa", "house", ""] },
    ],
  });
  await page.goto(`${BASE}/words/import?lang=en`, { waitUntil: "networkidle" });
  await page.locator('input[type="file"]').setInputFiles({
    name: "qa-spanish.apkg",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(apkg2),
  });
  await deckCard.waitFor({ timeout: 15000 });
  check(
    (await deckCard.locator("select").last().inputValue()) === imported.id,
    "re-importing the same deck targets its list",
  );
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await done.waitFor({ timeout: 15000 });
  const again = await done.innerText();
  check(again.includes("1 added") && again.includes("1 updated"), `re-import syncs: ${again}`);
  const after2 = (
    await page.evaluate(async () => (await (await fetch("/api/words/lists")).json()).lists)
  ).filter((x) => x.source === "anki:1700000000777");
  check(
    after2.length === 1 && after2[0].size === 4 && after2[0].cards === 1,
    `one list, 4 words, the review kept (${JSON.stringify(after2.map((x) => [x.size, x.cards]))})`,
  );
  const entries = await page.evaluate(
    async (id) => (await (await fetch(`/api/words/lists/${id}/entries`)).json()).entries,
    imported.id,
  );
  check(
    entries.find((e) => e.term === "hola")?.back === "hello; hi",
    "a changed meaning is updated",
  );

  check(errs.length === 0, `no page errors${errs.length ? ": " + errs.join(" | ") : ""}`);
} catch (e) {
  check(false, `threw: ${e.message}`);
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);

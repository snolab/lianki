// The header's language picker on a phone (owner, 2026-10-31, iPhone 414x721):
// it opened with its top above the viewport and the options could not be
// tapped. The glass header has backdrop-filter, which makes it the containing
// block of a position:fixed child, so a picker rendered inside it was laid out
// against the 56px header instead of the screen.
//
// Opens the picker in WebKit and Chromium at 414x721 (touch, mobile) on an app
// page (AppShell's glass header), and checks:
//   - the dialog's rect lies inside the viewport;
//   - it scrolls internally rather than growing past the screen;
//   - every option, scrolled into view inside the picker, is the element at
//     its own centre (elementFromPoint): nothing covers it.
//
//   QA_BASE=http://localhost:3000 node scripts/qa/qa-lang-menu.mjs
import { chromium, webkit } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const VIEWPORT = { width: 414, height: 721 };
// App pages (AppShell's glass header, where the bug was). The landing Header
// is left out: its nav is wider than a phone (the page lays out at ~600px),
// a separate layout issue.
const PAGES = ["/sign-in?lang=fr", "/words?lang=fr"];

let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) ok = false;
};

for (const type of [webkit, chromium]) {
  const browser = await launchSilent(type);
  const ctx = await newSilentContext(browser, {
    viewport: VIEWPORT,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    locale: "fr-FR",
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("lk:words-sound", "off");
      // A guest on /words is asked first-run local vs account; answer it.
      localStorage.setItem("lk:first-run", "local");
    } catch {}
  });
  for (const path of PAGES) {
    const page = await ctx.newPage();
    const tag = `${type.name()} ${path}`;
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await page.locator('button[aria-label="Changer de langue"]').first().tap();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    const r = await dialog.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height };
    });
    console.log(`  ${tag} rect ${JSON.stringify(r)}`);
    check(
      r.top >= 0 && r.left >= 0 && r.bottom <= VIEWPORT.height && r.right <= VIEWPORT.width,
      `${tag}: picker inside the ${VIEWPORT.width}x${VIEWPORT.height} viewport`,
    );

    const options = dialog.locator("button[data-lang]");
    const n = await options.count();
    check(n >= 16, `${tag}: ${n} language options`);
    const blocked = [];
    for (let i = 0; i < n; i++) {
      const hit = await options.nth(i).evaluate((el) => {
        el.scrollIntoView({ block: "nearest" });
        const b = el.getBoundingClientRect();
        const x = b.left + b.width / 2;
        const y = b.top + b.height / 2;
        const inView = y >= 0 && y <= innerHeight && x >= 0 && x <= innerWidth;
        const at = document.elementFromPoint(x, y);
        return inView && !!at && (at === el || el.contains(at));
      });
      if (!hit) blocked.push(await options.nth(i).getAttribute("data-lang"));
    }
    check(
      blocked.length === 0,
      `${tag}: every option tappable${blocked.length ? ` (blocked: ${blocked})` : ""}`,
    );

    await page.keyboard.press("Escape");
    check(!(await dialog.isVisible()), `${tag}: Escape closes the picker`);
    await page.close();
  }
  await browser.close();
}

if (!ok) process.exit(1);
console.log("lang menu QA passed");

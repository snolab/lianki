// /reader's first screen (owner, 2026-11-11): silent, iPhone and 360 px,
// light and dark screenshots.
//
//   QA_BASE=http://localhost:3017 bun scripts/qa/qa-read-home.mjs [outDir]
//
// Checks: signed out, a short welcome with sign-in, and Import opens the
// pop-up straight on the paste form (the text then opens in the reader).
// Signed in: a compact header with one primary Import button and no import
// options on the page; the pop-up is a labelled modal dialog (role, aria-modal,
// its heading), Tab stays inside it, Escape closes it and focus goes back to
// the button; it holds the paste, EPUB and Google Doc options; the Google Doc
// form opens inside it and Cancel goes back to the options. "Continue
// reading" shows the book whose position moved last, with how far in, above
// the list. No sideways scroll at 360 px.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { budget } from "./load-budget.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/read-home";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const browser = await launchSilent(chromium);
const iphone = devices["iPhone 13"];
const narrow = {
  ...iphone,
  viewport: { width: 360, height: 740 },
  screen: { width: 360, height: 740 },
};

const SHEET = '[data-testid="read-import-sheet"]';
const noSideways = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shots = async (page, name) => {
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(120);
    await page.screenshot({ path: join(OUT, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
};

// ── Signed out ──────────────────────────────────────────────────────────────
{
  const ctx = await newSilentContext(browser, { ...iphone, baseURL: BASE });
  // The first-visit choice (lib/first-run.ts) would sit over the page: "on this device".
  await ctx.addInitScript(() => localStorage.setItem("lk:first-run", "local"));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("/reader", { waitUntil: "networkidle" });
  check(await page.getByTestId("read-welcome").isVisible(), "signed out: the welcome shows");
  check(
    (await page.getByTestId("read-sign-in").getAttribute("href"))?.startsWith("/sign-in"),
    "signed out: sign-in link",
  );
  await shots(page, "guest");
  await page.getByTestId("read-import").click();
  const form = page.locator(`${SHEET} [data-testid="read-text-form"]`);
  await form.waitFor({ timeout: budget(5000) });
  check(await form.isVisible(), "signed out: Import opens on the paste form");
  check(
    (await page.locator(`${SHEET} [data-testid="read-import-epub"]`).count()) === 0,
    "signed out: no EPUB option",
  );
  await shots(page, "guest-sheet");
  await form.locator("textarea").fill("Guest line one.\nGuest line two.");
  await form.locator('button[type="submit"]').click();
  await page.waitForURL(/\/reader\/[^/]+$/, { timeout: budget(15000) });
  check(true, "signed out: pasted text opens in the reader");
  check(errs.length === 0, `signed out: no page errors (${errs.join("; ")})`);
  await ctx.close();
}

// ── Signed in ───────────────────────────────────────────────────────────────
for (const [name, device] of [
  ["iphone", iphone],
  ["360", narrow],
]) {
  const ctx = await newSilentContext(browser, { ...device, baseURL: BASE });
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+readhome${name}${Date.now()}@lianki.test`, password: PW, name: "QA Home" },
    headers: { origin: BASE },
  });
  check(r.ok(), `${name}: sign-up (${r.status()})`);
  const ids = [];
  for (const title of ["Older text", "Book I was reading"]) {
    const a = await ctx.request.post("/api/read", {
      data: {
        title,
        content: Array.from({ length: 21 }, (_, i) => `${title} line ${i}.`).join("\n"),
      },
      headers: { origin: BASE },
    });
    ids.push((await a.json()).id);
  }
  // A reading position in the first one, half way: it is the one read last.
  const pos = await ctx.request.put(`/api/read/${ids[0]}/progress`, {
    data: { line: 10, offset: 0, at: new Date().toISOString() },
    headers: { origin: BASE },
  });
  check(pos.ok(), `${name}: reading position saved (${pos.status()})`);

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("/reader", { waitUntil: "networkidle" });
  await page
    .locator('[data-testid="read-row"]')
    .first()
    .waitFor({ timeout: budget(15000) });

  // The first screen: header, Continue reading, the list; no import clutter.
  const btn = page.getByTestId("read-import");
  check(await btn.isVisible(), `${name}: the Import button shows`);
  const box = await btn.boundingBox();
  check(!!box && box.y < 200 && box.height >= 44, `${name}: Import in the header (y=${box?.y})`);
  check(
    await btn.evaluate((el) => el.classList.contains("lk-btn-primary")),
    `${name}: Import is the primary button`,
  );
  check(!(await page.locator(SHEET).isVisible()), `${name}: the pop-up starts closed`);
  check(
    !(await page.getByTestId("read-import-text").isVisible()) &&
      !(await page.getByTestId("read-import-epub").isVisible()),
    `${name}: no import options on the page itself`,
  );
  const cont = page.getByTestId("read-continue");
  await cont.waitFor({ timeout: budget(10000) });
  check(
    (await cont.innerText()).includes("Older text"),
    `${name}: Continue reading names the book read last`,
  );
  check(
    /50%/.test(await page.getByTestId("read-continue-pct").innerText()),
    `${name}: Continue reading says how far in (${await page.getByTestId("read-continue-pct").innerText()})`,
  );
  check(
    (await page.getByTestId("read-continue-link").getAttribute("href")) === `/reader/${ids[0]}`,
    `${name}: Continue reading opens that book`,
  );
  const contBox = await cont.boundingBox();
  const rowBox = await page.locator('[data-testid="read-row"]').first().boundingBox();
  check(!!contBox && !!rowBox && contBox.y < rowBox.y, `${name}: Continue reading above the list`);
  check(await noSideways(page), `${name}: no sideways scroll`);
  await shots(page, `home-${name}`);

  // The pop-up: a labelled modal dialog.
  await btn.click();
  const dlg = page.locator(SHEET);
  await dlg.waitFor({ state: "visible", timeout: budget(5000) });
  check((await dlg.getAttribute("role")) === "dialog", `${name}: role=dialog`);
  check((await dlg.getAttribute("aria-modal")) === "true", `${name}: aria-modal`);
  const label = await dlg.evaluate(
    (el) => document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent ?? "",
  );
  check(label.length > 0, `${name}: labelled by its heading (${label})`);
  check((await btn.getAttribute("aria-expanded")) === "true", `${name}: button says expanded`);
  for (const id of ["read-import-text", "read-import-epub", "read-import-gdoc"])
    check(await dlg.getByTestId(id).isVisible(), `${name}: ${id} inside the pop-up`);
  const sheetBox = await dlg.boundingBox();
  const vp = page.viewportSize();
  check(
    !!sheetBox && Math.abs(sheetBox.y + sheetBox.height - vp.height) < 2,
    `${name}: a bottom sheet on a phone`,
  );
  check(await noSideways(page), `${name}: no sideways scroll with the pop-up`);
  await shots(page, `sheet-${name}`);

  // Tab stays inside.
  let outside = 0;
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    if (!(await dlg.evaluate((el) => el.contains(document.activeElement)))) outside++;
  }
  check(outside === 0, `${name}: Tab stays inside the pop-up (${outside} outside)`);

  // The Google Doc form opens inside; Cancel goes back to the options.
  await dlg.getByTestId("read-import-gdoc").click();
  const gform = dlg.getByTestId("read-gdoc-form");
  await gform.waitFor({ timeout: budget(5000) });
  check(
    await gform.locator('input[type="url"]').evaluate((el) => el === document.activeElement),
    `${name}: the link field takes focus`,
  );
  check(!(await dlg.getByTestId("read-import-epub").isVisible()), `${name}: options hidden`);
  await gform.locator('input[type="url"]').fill("https://example.com/not-a-doc");
  await gform.locator('button[type="submit"]').click();
  const gerr = dlg.getByTestId("read-gdoc-error");
  await gerr.waitFor({ timeout: budget(5000) });
  check(await gerr.isVisible(), `${name}: a bad link says so inside the pop-up`);
  await gform.getByRole("button").first().click();
  await dlg.getByTestId("read-import-epub").waitFor({ timeout: budget(5000) });
  check(true, `${name}: Cancel goes back to the options`);

  // Escape closes; focus back on the Import button.
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "hidden", timeout: budget(5000) });
  check(
    await btn.evaluate((el) => el === document.activeElement),
    `${name}: Escape closes, focus back on Import`,
  );

  // The paste form keeps what was typed when the pop-up is closed by mistake.
  await btn.click();
  await dlg.getByTestId("read-import-text").click();
  await dlg.locator("textarea").fill("Kept line.");
  await dlg.getByTestId("read-import-sheet-close").click();
  await dlg.waitFor({ state: "hidden", timeout: budget(5000) });
  await btn.click();
  check(
    (await dlg.locator("textarea").inputValue()) === "Kept line.",
    `${name}: a draft survives closing the pop-up`,
  );
  await page.keyboard.press("Escape");

  check(errs.length === 0, `${name}: no page errors (${errs.join("; ")})`);
  await ctx.close();
}

await browser.close();
console.log(
  failed ? `\n${failed} check(s) failed` : `\n✓ read-home QA passed (screenshots in ${OUT})`,
);
process.exit(failed ? 1 : 0);

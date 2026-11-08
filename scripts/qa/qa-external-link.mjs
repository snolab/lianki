// The disclaimer before another website (app/components/ExternalLinkGuard.tsx,
// docs/external-links.md). Silent; 360 px wide, light and dark screenshots.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-external-link.mjs [outDir]
//
// A guest page gets links put in by the test; every other site is stubbed by
// page.route, so nothing leaves the machine. Checks:
//
// - a link to another site opens the dialog and does not navigate; Cancel stays;
// - "Open site" goes there, without a Referer;
// - "Don't ask again for this site": the next click on that site goes at once,
//   another site still asks;
// - "Don't ask again for any site": no site asks after that;
// - a lianki.com subdomain never asks;
// - the dialog fits a 360 px screen, light and dark.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/external-link";
const PAGE = "/sign-in?lang=en";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const browser = await launchSilent(chromium);
try {
  for (const scheme of ["light", "dark"]) {
    const ctx = await newSilentContext(browser, {
      viewport: { width: 360, height: 740 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      colorScheme: scheme,
    });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("lk:first-run", "local");
      } catch {}
    });
    /** Requests that reached a stubbed site: url → its Referer header. */
    const reached = new Map();
    await ctx.route(/^https:\/\/([a-z0-9-]+\.)*(example\.(com|org|net)|lianki\.com)\//, (route) => {
      const req = route.request();
      if (req.isNavigationRequest()) reached.set(req.url(), req.headers().referer ?? null);
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>stub</title><p>stub</p>",
      });
    });
    const page = await ctx.newPage();
    const dialog = page.getByTestId("external-link-dialog");

    /** Open the Lianki page with one link on it and click it. */
    const clickOut = async (href) => {
      await page.goto(`${BASE}${PAGE}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!globalThis.__lkExternalLink, null, { timeout: 15000 });
      await page.evaluate((h) => {
        const a = document.createElement("a");
        a.href = h;
        a.id = "qa-out";
        a.textContent = "out";
        a.style.cssText = "position:fixed;top:120px;left:20px;z-index:1;padding:12px";
        document.body.appendChild(a);
      }, href);
      await page.locator("#qa-out").click();
    };
    const visible = () => dialog.isVisible();
    const landed = async (url) => {
      try {
        await page.waitForURL(url, { timeout: 8000 });
        return true;
      } catch {
        return false;
      }
    };

    const tag = `[${scheme}]`;
    // 1. Asks, and does not leave.
    await clickOut("https://example.com/qa-1");
    await dialog.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    check(await visible(), `${tag} a link to another site opens the dialog`);
    check(
      (await page.getByTestId("external-link-host").textContent()) === "example.com",
      `${tag} the dialog names the site`,
    );
    check(page.url().startsWith(BASE), `${tag} nothing navigated while asking`);
    const box = await dialog.boundingBox();
    check(
      !!box && box.x >= 0 && box.x + box.width <= 360 && box.y >= 0 && box.y + box.height <= 740,
      `${tag} the dialog fits a 360 px screen`,
    );
    await page.screenshot({ path: join(OUT, `dialog-${scheme}.png`) });

    // 2. Cancel stays.
    await page.getByTestId("external-link-cancel").click();
    check(!(await visible()) && page.url().startsWith(BASE), `${tag} Cancel stays on Lianki`);

    // 3. Open site goes, without the referrer.
    await page.locator("#qa-out").click();
    await page.getByTestId("external-link-go").click();
    check(await landed("https://example.com/qa-1"), `${tag} Open site goes to the site`);
    check(reached.get("https://example.com/qa-1") === null, `${tag} no Referer is sent`);

    // 4. Don't ask again for this site.
    await clickOut("https://example.com/qa-2");
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    await page.getByTestId("external-link-skip-site").check();
    await page.getByTestId("external-link-go").click();
    check(await landed("https://example.com/qa-2"), `${tag} goes with "this site" ticked`);
    await clickOut("https://www.example.com/qa-3");
    check(await landed("https://www.example.com/qa-3"), `${tag} that site no longer asks`);
    await clickOut("https://example.org/qa-4");
    await dialog.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    check(await visible(), `${tag} another site still asks`);

    // 5. Don't ask again for any site.
    await page.getByTestId("external-link-skip-all").check();
    await page.getByTestId("external-link-go").click();
    check(await landed("https://example.org/qa-4"), `${tag} goes with "any site" ticked`);
    await clickOut("https://example.net/qa-5");
    check(await landed("https://example.net/qa-5"), `${tag} no site asks any more`);
    const stored = await page
      .goto(`${BASE}${PAGE}`)
      .then(() =>
        page.evaluate(() => [
          localStorage.getItem("lk:link-confirm"),
          localStorage.getItem("lk:link-allowed"),
        ]),
      );
    check(
      stored[0] === "0" && stored[1] === JSON.stringify(["example.com"]),
      `${tag} both settings are kept for the account sync`,
    );

    // 6. Our own hosts never ask (asking turned back on first).
    await page.evaluate(() => localStorage.setItem("lk:link-confirm", "1"));
    await clickOut("https://dev.lianki.com/qa-6");
    check(await landed("https://dev.lianki.com/qa-6"), `${tag} a lianki.com subdomain never asks`);

    await ctx.close();
  }
} finally {
  await browser.close();
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nexternal links: all checks passed");

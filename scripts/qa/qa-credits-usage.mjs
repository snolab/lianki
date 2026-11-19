// The credits usage page (/membership/credits, lib/payments/credit-usage.ts).
// Silent; light and dark, at 360 px and on desktop.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-credits-usage.mjs [outDir]
//
// In qa:all (suite credits-usage), or against any local server on local D1.
//
// - one tap from the wallet card on /membership, and one from the account menu;
// - a new wallet: its sign-up gift or empty ledger, no sideways scroll at 360 px;
// - the filters (feature, dates) and Clear; CSV agrees with the account's ledger;
// - every text's colour against its background: WCAG AA (4.5:1, 3:1 large);
// - the API is 401 signed out.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/credits-usage";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

async function signUp(ctx, tag) {
  const email = `qa+credits${tag}${Date.now()}@lianki.test`;
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email, password: PW, name: "QA Credits" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up (${r.status()})`);
}

/** The lowest text contrast on the page: each text's colour over its nearest opaque background. */
const CONTRAST = (root) => {
  const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const rgba = (css) => {
    c.clearRect(0, 0, 1, 1);
    c.fillStyle = css;
    c.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = c.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const bgOf = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const b = rgba(getComputedStyle(e).backgroundColor);
      if (b[3] > 0.95) return b;
    }
    return rgba(getComputedStyle(document.body).backgroundColor);
  };
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || !el.checkVisibility() || el.closest("option")) continue;
    const cs = getComputedStyle(el);
    const fg = rgba(cs.color);
    const bg = bgOf(el);
    const mix = fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
    const a = lum(mix);
    const b = lum(bg);
    const px = parseFloat(cs.fontSize);
    const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
    out.push({
      text: n.textContent.trim().slice(0, 30),
      ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100,
      need: large ? 3 : 4.5,
    });
  }
  return out;
};

const browser = await launchSilent(chromium);
try {
  // Signed out: the API refuses.
  {
    const ctx = await newSilentContext(browser, { baseURL: BASE });
    const r = await ctx.request.get("/api/payments/credits/usage");
    check(r.status() === 401, `API signed out → 401 (${r.status()})`);
    await ctx.close();
  }
  for (const scheme of ["light", "dark"]) {
    for (const [name, opts] of [
      ["w360", { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true }],
      ["desktop", { viewport: { width: 1280, height: 900 } }],
    ]) {
      const tag = `${name} ${scheme}`;
      console.log(`— ${tag}`);
      const ctx = await newSilentContext(browser, {
        ...opts,
        baseURL: BASE,
        colorScheme: scheme,
        reducedMotion: "reduce",
      });
      await signUp(ctx, `${name}${scheme}`);
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push(e.message));

      // One tap from the wallet card.
      await page.goto("/membership?lang=en");
      const fromWallet = page.locator("[data-credits-usage-link]");
      await fromWallet.waitFor({ timeout: 30000 });
      await fromWallet.click();
      await page.waitForURL(/\/membership\/credits/, { timeout: 15000 });
      const view = page.locator("[data-credits-usage]");
      await view.waitFor({ timeout: 15000 });
      check(true, `${tag}: wallet card → credits usage in one tap`);
      await page.waitForFunction(
        () => document.querySelector("[data-usage-balance]")?.textContent?.trim() !== "…",
        null,
        { timeout: 15000 },
      );
      // Sign-up can grant credits (and its daily cap can leave a wallet empty).
      // Compare the UI with this account's ledger instead of assuming a zero balance.
      const usage = await ctx.request.get("/api/payments/credits/usage?tz=Asia/Tokyo");
      if (!usage.ok()) throw new Error(`Usage snapshot failed (${usage.status()})`);
      const snapshot = await usage.json();
      check(
        snapshot.total === snapshot.entries.length &&
          snapshot.entries.every((entry) => entry.reason === "gift" && entry.amount > 0) &&
          snapshot.entries.reduce((sum, entry) => sum + entry.amount, 0) === snapshot.balance,
        `${tag}: new wallet contains only its granted credits`,
      );
      const waitForLedger = async () => {
        if (snapshot.entries.length) {
          for (const entry of snapshot.entries)
            await page.locator(`[id="usage-${entry.id}"]`).waitFor({ timeout: 10000 });
        } else await page.getByText("No credits used or added yet.").waitFor({ timeout: 10000 });
      };
      await waitForLedger();
      const balance = (await page.locator("[data-usage-balance]").textContent())?.trim() ?? "";
      check(
        Number(balance.replace(/[^\d.-]/g, "")) === snapshot.balance,
        `${tag}: wallet balance matches its ledger (${balance})`,
      );
      check(
        (await page.locator("[data-usage-entry]").count()) === snapshot.total,
        `${tag}: ledger entries match the account (${snapshot.total})`,
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check(overflow <= 0, `${tag}: no sideways scroll (${overflow}px)`);

      // Filters: a date range shows Clear and the no-match line; Clear removes it.
      await Promise.all([
        page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === "/api/payments/credits/usage" &&
            url.searchParams.get("to") === "2000-01-01" &&
            response.ok()
          );
        }),
        page.locator('input[type="date"]').nth(1).fill("2000-01-01"),
      ]);
      await page.getByRole("button", { name: "Clear filters" }).waitFor({ timeout: 10000 });
      await page.getByText("Nothing matches these filters.").waitFor({ timeout: 10000 });
      check(
        (await page.getByText("Nothing matches these filters.").count()) === 1,
        `${tag}: a filter with nothing in it says so`,
      );
      await Promise.all([
        page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === "/api/payments/credits/usage" &&
            !url.searchParams.has("to") &&
            !url.searchParams.has("from") &&
            response.ok()
          );
        }),
        page.getByRole("button", { name: "Clear filters" }).click(),
      ]);
      await waitForLedger();
      check(true, `${tag}: Clear filters`);

      // The CSV includes the same sign-up grants as the account's ledger.
      const csv = await ctx.request.get("/api/payments/credits/usage?format=csv&tz=Asia/Tokyo");
      const body = await csv.text();
      const exported = body.trim().split("\r\n").slice(1);
      const oldestFirst = [...snapshot.entries].reverse();
      check(
        csv.ok() &&
          (csv.headers()["content-type"] ?? "").includes("text/csv") &&
          body.startsWith("time_utc,time_local,feature,") &&
          exported.length === snapshot.total &&
          exported.every((row, i) => {
            // Fresh-wallet gift rows contain ISO times, fixed labels and numbers.
            const cells = row.split(","),
              entry = oldestFirst[i];
            return (
              cells[0] === entry.at &&
              cells[2] === entry.feature &&
              cells[3] === entry.reason &&
              Number(cells[4]) === entry.amount &&
              Number(cells[6]) === entry.balanceAfter
            );
          }),
        `${tag}: CSV export matches the ledger (${csv.status()}, ${snapshot.total} entries)`,
      );

      const runs = await view.evaluate(CONTRAST);
      const worst = runs.reduce((a, b) => (b.ratio / b.need < a.ratio / a.need ? b : a));
      check(
        runs.length >= 8 && runs.every((r) => r.ratio >= r.need),
        `${tag}: text AA (${runs.length} runs; lowest ${worst.ratio}:1 at "${worst.text}", needs ${worst.need})`,
      );
      await page.screenshot({ path: join(OUT, `credits-${name}-${scheme}.png`), fullPage: true });

      // One tap from the account menu (the header's on desktop, the drawer's on phones).
      if (name === "desktop") {
        await page.goto("/membership?lang=en");
        await page
          .locator("[data-profile-menu]:visible, [data-rail-profile]:visible")
          .first()
          .click();
        await page.locator('a[href="/membership/credits"]').first().click();
        await page.waitForURL(/\/membership\/credits/, { timeout: 15000 });
        check(true, `${tag}: account menu → credits usage`);
      }
      check(errs.length === 0, `${tag}: no page errors (${errs.join(" | ")})`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall credits-usage checks passed");
process.exit(failed ? 1 : 0);

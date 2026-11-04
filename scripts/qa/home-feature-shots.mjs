#!/usr/bin/env bun
/**
 * Screenshots of the features under Explore on /home, used as the cards'
 * backgrounds (public/home-features/<key>-<light|dark>.webp).
 *
 *   bun run shots:home                    # against QA_BASE (default http://localhost:3000)
 *   bun run shots:home -- alphabet read   # only these features
 *
 * Point it at a local app, never production: `bun run qa:all -- --keep`
 * leaves one up (its port is printed), or `bun run dev`.
 *
 * A throwaway `qa+shots…@lianki.test` account (dev email+password) with only
 * demo content (a public-domain fable), so no real person's decks, books or
 * email ever land in an image. An iPhone-size, muted Chromium
 * (scripts/qa/silent.mjs) in light and dark; the app's top bar is left out;
 * each shot is encoded to a small WebP in the browser itself, so no image tool
 * is needed. Re-run it when one of those pages changes look.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { HOME_FEATURES, HOME_FEATURE_SHOT } from "../../lib/home-features.ts";

const BASE = process.env.QA_BASE || "http://localhost:3000";
if (/lianki\.com/.test(BASE)) throw new Error("shots come from a local app, never production");
const OUT = join(import.meta.dir, "..", "..", "public", "home-features");
const EMAIL = `qa+shots${Date.now()}@lianki.test`;
const PW = "qa-test-pass-1234";
const only = process.argv.slice(2);

/** iPhone 12–16 viewport, in CSS px. */
const VIEW = { width: 390, height: 844 };
/** CSS px of the app's top bar; the shots start below it. */
const TOP_BAR = 56;

/** Demo content: a public-domain fable (Aesop, tr. Townsend 1867), nobody's own text. */
const FABLE = [
  "The Fox and the Grapes",
  "",
  "A famished Fox saw some clusters of ripe black grapes hanging from a trellised vine.",
  "She resorted to all her tricks to get at them, but wearied herself in vain, for she could not reach them.",
  "At last she turned away, hiding her disappointment and saying:",
  '"The Grapes are sour, and not ripe as I thought."',
].join("\n");

/**
 * Per feature, what to do before the shot so it shows the feature at work
 * rather than an empty first visit. Returns the path to shoot (null: href).
 */
const PREPARE = {
  // Add Hiragana and open it, so the drill shows symbols to grade (as
  // qa-words.mjs's addFromTree does).
  async alphabet(page) {
    const node = page.locator('[data-add-node="ja-hiragana"]');
    if (!(await node.isVisible()))
      await page.locator('[data-add-node="lang:ja"] button').first().click();
    await node.locator("label").click();
    await page.locator("[data-add-selected]").click();
    await page.locator("[data-added-toast]").waitFor({ timeout: 15000 });
    await page.locator("[data-fresh] [data-open-list]").first().click();
    await page.locator('[role="listitem"]').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(1000);
    const u = new URL(page.url());
    return u.pathname + u.search;
  },
  // Import the fable and open it in the reader.
  async read(page) {
    const id = await page.evaluate(async (content) => {
      const r = await fetch("/api/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "The Fox and the Grapes", content }),
      });
      return r.ok ? (await r.json()).id : null;
    }, FABLE);
    return id ? `/read/${id}` : null;
  },
};

const browser = await launchSilent(chromium);
mkdirSync(OUT, { recursive: true });

// One account for both themes: sign up once, share the cookies; the light
// pass seeds the demo content, the dark pass reuses it.
let storageState;
const seeded = new Map();
for (const scheme of ["light", "dark"]) {
  const ctx = await newSilentContext(browser, {
    viewport: VIEW,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: scheme,
    locale: "en-US",
    reducedMotion: "reduce",
    ...(storageState ? { storageState } : {}),
  });
  if (!storageState) {
    const r = await ctx.request.post(`${BASE}/api/auth/sign-up/email`, {
      data: { email: EMAIL, password: PW, name: "Demo" },
      headers: { origin: BASE },
    });
    if (!r.ok()) throw new Error(`sign-up: HTTP ${r.status()}`);
    storageState = await ctx.storageState();
  }
  const page = await ctx.newPage();
  for (const f of HOME_FEATURES) {
    if (only.length && !only.includes(f.key)) continue;
    await page.goto(`${BASE}${f.href}`, { waitUntil: "networkidle" }).catch(() => {});
    if (!seeded.has(f.key)) {
      const prepare = PREPARE[f.key];
      const path = prepare
        ? await prepare(page).catch((e) => {
            console.error(`${f.key}: no demo content (${e.message.split("\n")[0]}); first visit`);
            return null;
          })
        : null;
      seeded.set(f.key, path);
    }
    const path = seeded.get(f.key);
    if (path) await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" }).catch(() => {});
    // Let fonts, catalogs and the first paint after hydration settle.
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    // Account banners (the demo account's trial end date) are not the feature.
    await page.evaluate(() => {
      for (const a of document.querySelectorAll('.bg-yellow-500 > a[href="/membership"]'))
        a.parentElement.remove();
    });
    await page.waitForTimeout(1500);
    const png = await page.screenshot({
      type: "png",
      clip: { x: 0, y: TOP_BAR, width: VIEW.width, height: VIEW.height - TOP_BAR },
    });
    const webp = await page.evaluate(
      async ({ b64, w, h, q }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const g = c.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(img, 0, 0, w, h);
        return c.toDataURL("image/webp", q).split(",")[1];
      },
      {
        b64: png.toString("base64"),
        w: HOME_FEATURE_SHOT.width,
        h: HOME_FEATURE_SHOT.height,
        q: 0.62,
      },
    );
    const file = join(OUT, `${f.key}-${scheme}.webp`);
    const buf = Buffer.from(webp, "base64");
    writeFileSync(file, buf);
    console.log(
      `${f.key}-${scheme}.webp  ${(buf.length / 1024).toFixed(1)} KB  (${path ?? f.href})`,
    );
  }
  await ctx.close();
}
await browser.close();

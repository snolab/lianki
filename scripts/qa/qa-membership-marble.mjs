// The marble plan cards on /membership (app/(app)/membership/PlanCards.tsx).
// Silent; light and dark, iPhone 13, 360 px and desktop; screenshots of the
// plan cards in each.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-membership-marble.mjs [outDir]
//
// In qa:all (suite membership-marble), or against any local server on local D1.
//
// - marble without a parameter; ?card=wood still previews wood;
// - the cards fit 360 px with no sideways scroll;
// - nothing on marble animates (so reduced motion has nothing to stop);
// - text contrast over the stone, measured: the card is shot with its text
//   hidden, and every pixel under each line of text is held against the text's
//   own colour (opacity included) — WCAG AA, 4.5:1, or 3:1 for large text;
// - and each text colour against every pixel of the stone, so AA holds at any
//   layout (the slab is scaled to the card: another height, font or locale
//   moves the veins under the text).
// Deterministic: measured after fonts load and the cards' boxes hold still,
// and a shot an overlay got into (the bottom bar mounting late on a cold
// server — 1:1 at "Video speed control", 2026-11-09) is taken again.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/membership-marble";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

async function signUp(ctx, tag) {
  const email = `qa+marble${tag}${Date.now()}@lianki.test`;
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email, password: PW, name: "QA Marble" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up (${r.status()})`);
}

/** Every line of text over the stone in one card: its boxes (relative to the
 * card) and its colour as sRGB with alpha. Buttons with their own fill are left
 * out — their text sits on the button, not on the marble. */
const TEXT_RUNS = (card) => {
  const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const rgba = (css, opacity) => {
    c.clearRect(0, 0, 1, 1);
    c.fillStyle = css;
    c.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = c.getImageData(0, 0, 1, 1).data;
    return [r, g, b, (a / 255) * opacity];
  };
  const box = card.getBoundingClientRect();
  const runs = [];
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || el.closest(".lk-plan-btn, [aria-hidden]")) continue;
    if (!el.checkVisibility()) continue;
    let opacity = 1;
    for (let e = el; e && e !== card; e = e.parentElement)
      opacity *= Number(getComputedStyle(e).opacity);
    const cs = getComputedStyle(el);
    const px = parseFloat(cs.fontSize);
    const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects())
      runs.push({
        text: n.textContent.trim().slice(0, 30),
        x: r.left - box.left,
        y: r.top - box.top,
        w: r.width,
        h: r.height,
        color: rgba(cs.color, opacity),
        need: large ? 3 : 4.5,
      });
  }
  return runs;
};

/** The lowest contrast under each run, from a PNG of the card without text. */
const MEASURE = async ({ png, runs, cssWidth, skip = [] }) => {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width;
  cv.height = img.height;
  const c = cv.getContext("2d", { willReadFrequently: true });
  c.drawImage(img, 0, 0);
  const k = img.width / cssWidth;
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return runs.map((run) => {
    const x0 = Math.max(0, Math.floor(run.x * k));
    const y0 = Math.max(0, Math.floor(run.y * k));
    const w = Math.min(img.width - x0, Math.ceil(run.w * k));
    const h = Math.min(img.height - y0, Math.ceil(run.h * k));
    const d = c.getImageData(x0, y0, w, h).data;
    const [tr, tg, tb, ta] = run.color;
    const out = skip.map((s) => [s.x * k, s.y * k, (s.x + s.w) * k, (s.y + s.h) * k]);
    let min = Infinity;
    for (let i = 0; i < d.length; i += 4) {
      const px = x0 + ((i / 4) % w);
      const py = y0 + Math.floor(i / 4 / w);
      if (out.some(([l, t, r, b]) => px >= l && px < r && py >= t && py < b)) continue;
      // the text as drawn: its colour over this pixel at its own alpha
      const fr = tr * ta + d[i] * (1 - ta);
      const fg = tg * ta + d[i + 1] * (1 - ta);
      const fb = tb * ta + d[i + 2] * (1 - ta);
      const a = lum(fr, fg, fb);
      const b = lum(d[i], d[i + 1], d[i + 2]);
      min = Math.min(min, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
    }
    return { text: run.text, need: run.need, min: Math.round(min * 100) / 100 };
  });
};

const HIDE_TEXT = `.lk-plan :is(h3, li, p, .lk-plan-btn2, .lk-plan-chop) {
  color: transparent !important; text-shadow: none !important; }
  .lk-plan :is(.lk-plan-mark, .lk-plan-chop, .lk-plan-btn2 svg) { visibility: hidden !important; }
  .lk-plan-btn2 { border-color: transparent !important; box-shadow: none !important; }`;

/** Fixed and sticky overlays (the bottom bar) hidden while a card is shot:
 * they would stand between the stone and the camera. With "check", returns the
 * overlays that still cover `rect` (viewport px) unhidden — a bar mounted, or
 * swapped in by its hot island, after the hide; the shot is then taken again. */
const overlays = (page, hide, rect = null) =>
  page.evaluate(
    ({ hide, rect }) => {
      const missed = [];
      for (const el of document.querySelectorAll("body *")) {
        const fixed = /fixed|sticky/.test(getComputedStyle(el).position);
        if (hide === "check") {
          if (!fixed || el.dataset.qaHidden || !el.checkVisibility({ visibilityProperty: true }))
            continue;
          const r = el.getBoundingClientRect();
          if (
            r.right > rect.x &&
            r.left < rect.x + rect.width &&
            r.bottom > rect.y &&
            r.top < rect.y + rect.height
          )
            missed.push(`${el.tagName}.${el.className}`.slice(0, 60));
        } else if (hide && fixed) {
          el.dataset.qaHidden = "1";
          el.style.setProperty("visibility", "hidden", "important");
        } else if (!hide && el.dataset.qaHidden) {
          delete el.dataset.qaHidden;
          el.style.removeProperty("visibility");
        }
      }
      return missed;
    },
    { hide, rect },
  );

/** Layout settled: fonts in, no request in flight, and the cards' boxes the
 * same over two frames — the text runs and the shot must see one layout. */
async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.evaluate(async () => {
    await document.fonts.ready;
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const boxes = () =>
      JSON.stringify(
        [...document.querySelectorAll(".lk-plan")].map((e) => e.getBoundingClientRect()),
      );
    for (let prev = "", i = 0; i < 60; i++) {
      await frame();
      await frame();
      const now = boxes();
      if (now === prev) return;
      prev = now;
    }
  });
}

async function contrast(page, tag) {
  for (const tier of ["free", "pro"]) {
    const card = page.locator(`.lk-plan--${tier}`);
    await card.scrollIntoViewIfNeeded();
    await settle(page);
    // the text's own colours first, then the stone under it with the text hidden
    const runs = await card.evaluate(TEXT_RUNS);
    // filled buttons carry their own ground: left out of the stone
    const skip = await card.evaluate((card) => {
      const box = card.getBoundingClientRect();
      return [...card.querySelectorAll(".lk-plan-btn")].map((b) => {
        const r = b.getBoundingClientRect();
        return {
          x: r.left - box.left - 4,
          y: r.top - box.top - 4,
          w: r.width + 8,
          h: r.height + 8,
        };
      });
    });
    const style = await page.addStyleTag({ content: HIDE_TEXT });
    let shot;
    let missed = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await overlays(page, true);
      shot = await card.screenshot({ animations: "disabled" });
      missed = await overlays(page, "check", await card.boundingBox());
      if (!missed.length) break;
      console.log(`  ${tag} ${tier}: retake, an overlay was in the shot (${missed.join(", ")})`);
    }
    const box = await card.boundingBox();
    await overlays(page, false);
    await style.evaluate((s) => s.remove());
    writeFileSync(join(OUT, `stone-${tag.replace(" ", "-")}-${tier}.png`), shot);
    check(!missed.length, `${tag} ${tier}: no overlay over the stone shot (${missed.join(", ")})`);
    const png = shot.toString("base64");
    const res = await page.evaluate(MEASURE, { png, runs, cssWidth: box.width });
    const worst = res.reduce((a, b) => (b.min / b.need < a.min / a.need ? b : a));
    check(
      res.length >= 4 && res.every((r) => r.min >= r.need),
      `${tag} ${tier}: text AA over the marble (${res.length} runs; lowest ${worst.min}:1 at "${worst.text}", needs ${worst.need})`,
    );
    // Any layout: each text colour held against every pixel of the stone (an
    // inset past the polished arris, filled buttons left out), so a longer
    // translation, another font or another card height cannot land a line on
    // a vein that fails.
    const seen = new Set();
    const face = runs
      .filter((r) => {
        const key = `${r.color}|${r.need}`;
        return !seen.has(key) && seen.add(key);
      })
      .map((r) => ({ ...r, x: 6, y: 6, w: box.width - 12, h: box.height - 12 }));
    const any = await page.evaluate(MEASURE, { png, runs: face, cssWidth: box.width, skip });
    const low = any.reduce((a, b) => (b.min / b.need < a.min / a.need ? b : a));
    check(
      any.every((r) => r.min >= r.need),
      `${tag} ${tier}: every text colour AA anywhere on the stone (lowest ${low.min}:1 for "${low.text}", needs ${low.need})`,
    );
  }
}

const browser = await launchSilent(chromium);
try {
  for (const scheme of ["light", "dark"]) {
    for (const [name, opts] of [
      ["iphone", devices["iPhone 13"]],
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
      await page.goto("/membership?lang=en");
      const plans = page.locator(".lk-plans");
      await plans.waitFor({ timeout: 30000 });
      await page
        .locator(".lk-plan--pro .lk-plan-btn, .lk-plan--pro .lk-plan-btn2")
        .first()
        .waitFor();
      await settle(page);
      check((await plans.getAttribute("data-skin")) === "marble", `${tag}: marble by default`);
      const anims = await plans.evaluate((el) =>
        el.getAnimations({ subtree: true }).map((a) => a.animationName ?? "?"),
      );
      check(anims.length === 0, `${tag}: nothing animates (${anims.join(",")})`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check(overflow <= 0, `${tag}: no sideways scroll (${overflow}px)`);
      await contrast(page, tag);
      await plans.scrollIntoViewIfNeeded();
      await overlays(page, true);
      await plans.screenshot({ path: join(OUT, `plans-${name}-${scheme}.png`) });
      await overlays(page, false);
      if (name === "iphone" && scheme === "light") {
        await page.goto("/membership?lang=en&card=wood");
        await page.waitForFunction(
          () => document.querySelector(".lk-plans")?.getAttribute("data-skin") === "wood",
          null,
          { timeout: 15000 },
        );
        check(true, `${tag}: ?card=wood still previews wood`);
      }
      check(errs.length === 0, `${tag}: no page errors (${errs.join(" | ")})`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall membership-marble checks passed");
process.exit(failed ? 1 : 0);

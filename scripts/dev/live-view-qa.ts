#!/usr/bin/env bun
/**
 * Silent browser QA for live view (docs/live-view.md): the real banner and
 * menu switch (scripts/dev/live-view-harness.tsx), verifying pointers with
 * Chromium's own WebCrypto against a throwaway test key — never the Mac's.
 *
 *   bun scripts/dev/live-view-qa.ts [--shots <dir>]   # default .shots/
 *
 * Checks: a good pointer shows "Live view · <branch>@<sha>"; a pointer signed
 * by another key, an expired one, or the switch off shows no banner. Saves
 * the banner with the menu open at iPhone size, light and dark.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "../qa/silent.mjs";
import { b64url } from "../../lib/stt-ticket";
import { importLiveViewPrivateKey, signLiveView } from "../../lib/live-view/rules";
import { ROOT, harnessCss, widgetCss } from "./debug-widget-build";
import { LIVE_VIEW_ORIGINS } from "../../lib/live-view/origins";

const i = process.argv.indexOf("--shots");
const SHOTS = resolve(i >= 0 ? process.argv[i + 1] : join(ROOT, ".shots"));
mkdirSync(SHOTS, { recursive: true });

async function pair() {
  const p = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    priv: await importLiveViewPrivateKey(await crypto.subtle.exportKey("jwk", p.privateKey)),
    raw: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", p.publicKey))),
  };
}
const test = await pair();
const stranger = await pair();

const t = Math.floor(Date.now() / 1000);
const claim = (exp = t + 3600) => ({
  op: "on" as const,
  serial: Date.now(),
  iat: Math.min(t, exp - 1),
  exp,
  widget: `${LIVE_VIEW_ORIGINS[0]}/lianki-widget/debug-chat.js`,
  islands: `${LIVE_VIEW_ORIGINS[0]}/lianki-islands/islands.js`,
  branch: "feat/live-view",
  sha: "abc1234def5678",
});

const HARNESS = join(ROOT, "scripts/dev/live-view-harness.tsx");
const build = await Bun.build({
  entrypoints: [HARNESS],
  target: "browser",
  define: {
    "process.env.NODE_ENV": '"development"',
    "process.env.NEXT_PUBLIC_LIVE_VIEW_TEST_KEY": JSON.stringify(test.raw),
  },
});
if (!build.success) throw new Error(build.logs.join("\n"));
const js = await build.outputs[0].text();
const css =
  harnessCss() + "\n" + (await widgetCss([HARNESS, join(ROOT, "app/components/LiveView.tsx")]));

const labels = {
  liveView: "Live view",
  normal: "Normal",
  waiting: "Waiting for the dev machine",
  refused: "Pointer refused",
};
const page = (lv: unknown) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<style>${css}</style><div id="root"></div>` +
  `<script>window.__LV=${JSON.stringify(lv)}</script><script type="module" src="/app.js"></script>`;

const cases: Record<string, unknown> = {
  good: { wanted: true, token: await signLiveView(test.priv, claim()), labels },
  stranger: { wanted: true, token: await signLiveView(stranger.priv, claim()), labels },
  expired: { wanted: true, token: await signLiveView(test.priv, claim(t - 10)), labels },
  off: { wanted: false, token: await signLiveView(test.priv, claim()), labels },
};

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    const path = new URL(req.url).pathname.slice(1);
    if (path === "app.js")
      return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    return new Response(page(cases[path] ?? cases.good), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

let failed = 0;
const rec = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const browser = await launchSilent(chromium);
try {
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await newSilentContext(browser, {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      colorScheme: scheme,
    });
    const p = await ctx.newPage();
    p.on("console", (m) => m.type() === "error" && console.error(`console: ${m.text()}`));
    p.on("pageerror", (e) => console.error(`pageerror: ${e.message}`));
    await p.goto(`${BASE}/good`);
    await p.locator("[data-live-view-switch]").waitFor({ timeout: 5000 });
    if (process.env.DEBUG) console.error(await p.locator("[data-live-view-switch]").innerText());
    const banner = p.locator("[data-live-view-banner]");
    await banner.waitFor({ timeout: 5000 });
    const text = (await banner.innerText()).replace(/\s+/g, " ").trim();
    rec(
      `${scheme}: good pointer shows the banner`,
      text.startsWith("Live view · feat/live-view@abc1234"),
      text,
    );
    const sub = await p.locator("[data-live-view-switch]").innerText();
    rec(
      `${scheme}: menu switch is on, with the label`,
      sub.includes("feat/live-view@abc1234"),
      sub.replace(/\n/g, " | "),
    );
    const shot = join(SHOTS, `live-view-banner-${scheme}.png`);
    await p.screenshot({ path: shot, clip: { x: 0, y: 0, width: 390, height: 300 } });
    console.log(`shot  ${shot}`);
    await ctx.close();
  }

  const ctx = await newSilentContext(browser, { viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  for (const [name, why] of [
    ["stranger", "Pointer refused (bad signature)"],
    ["expired", "Pointer refused (expired)"],
    ["off", null],
  ] as const) {
    await p.goto(`${BASE}/${name}`);
    await p.locator("[data-live-view-switch]").waitFor();
    // Give the async verify its turn before checking that nothing appeared.
    await p.waitForFunction(() => document.readyState === "complete");
    await p.waitForTimeout(300);
    rec(`${name}: no banner`, (await p.locator("[data-live-view-banner]").count()) === 0);
    if (why) {
      const sub = await p.locator("[data-live-view-switch]").innerText();
      rec(`${name}: the switch says why`, sub.includes(why), sub.replace(/\n/g, " | "));
    }
  }
  await ctx.close();
} finally {
  await browser.close();
  server.stop(true);
}
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");

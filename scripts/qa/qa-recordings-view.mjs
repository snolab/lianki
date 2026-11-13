// Isolated real recordings viewer with fixture APIs; no live account or audio.
// Run from the repo root: bun scripts/qa/qa-recordings-view.mjs
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const dictionaries = {
  "my-recordings": (await import(resolve("app/(app)/my/recordings/my-recordings.content.ts")))
    .default.content,
  "virtual-list": (await import(resolve("app/components/virtual-list.content.ts"))).default.content,
};
const built = await Bun.build({
  entrypoints: ["recordings-entry"],
  target: "browser",
  plugins: [
    {
      name: "recordings-view",
      setup(build) {
        build.onResolve({ filter: /^recordings-entry$/ }, () => ({
          path: "entry",
          namespace: "review",
        }));
        build.onLoad({ filter: /.*/, namespace: "review" }, () => ({
          loader: "tsx",
          resolveDir: process.cwd(),
          contents: `
 import React from 'react';import {createRoot} from 'react-dom/client';
 import Preferences from ${JSON.stringify(resolve("app/(app)/my/recordings/RecordingsClient.tsx"))};
 createRoot(document.getElementById('root')).render(<Preferences/>);`,
        }));
        build.onResolve({ filter: /^next-intlayer$/ }, () => ({
          path: "dictionary",
          namespace: "review-dict",
        }));
        build.onLoad({ filter: /.*/, namespace: "review-dict" }, () => ({
          loader: "js",
          resolveDir: process.cwd(),
          contents: `
 import React from 'react';const dictionaries=${JSON.stringify(dictionaries)};const lang=new URL(location.href).searchParams.get('lang')||'en';
 function wrap(v){if(v&&v.translation){const text=v.translation[lang]||v.translation.en;return {...React.createElement('span',null,text),value:text};}if(Array.isArray(v))return v.map(wrap);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,v])=>[k,wrap(v)]));return v;}
 export const useIntlayer=key=>{if(!dictionaries[key])throw new Error('missing dictionary '+key);return wrap(dictionaries[key]);};
 export const useLocale=()=>({locale:lang,setLocale:()=>{}});`,
        }));
        build.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: "navigation",
          namespace: "review-next",
        }));
        build.onLoad({ filter: /.*/, namespace: "review-next" }, () => ({
          loader: "js",
          contents: `export const usePathname=()=>'/my/preferences';export const useSearchParams=()=>new URLSearchParams();export const useRouter=()=>({push(){},replace(){},refresh(){}});`,
        }));
      },
    },
  ],
});
if (!built.success) throw new Error(built.logs.join("\n"));
const css = (
  await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), {
    from: resolve("app/globals.css"),
  })
).css;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    return p === "/entry.js"
      ? new Response(built.outputs[0])
      : p === "/style.css"
        ? new Response(css, { headers: { "content-type": "text/css" } })
        : new Response(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/entry.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
  },
});
const browser = await launchSilent(chromium);
const context = await newSilentContext(browser);
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
try {
  const DAY = "2026-11-14";
  const clips = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"].map((id) => ({
    id,
    day: DAY,
    at: 1794614400000,
    durationMs: 1000,
    text: "Fixture transcript",
    mode: "active",
    source: "local",
    speaker: null,
  }));
  let failDay = true;
  let failDelete = true;
  const pending = [];
  await page.route("**/api/my/recordings**", async (route) => {
    const u = new URL(route.request().url());
    if (route.request().method() === "DELETE") {
      if (failDelete) {
        failDelete = false;
        return route.fulfill({ status: 500, json: {} });
      }
      pending.push(route);
      return;
    }
    if (u.searchParams.has("day")) {
      if (failDay) {
        failDay = false;
        return route.fulfill({ status: 503, json: {} });
      }
      return route.fulfill({ json: { clips } });
    }
    return route.fulfill({
      json: { days: [{ day: DAY, clips: 2, ms: 2000, bytes: 100 }], more: false },
    });
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`${server.url}?lang=de`);
  await page.locator('[data-qa="recordings-day"] button[aria-expanded]').click();
  await page.getByRole("alert").waitFor();
  await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await page.locator('[data-qa="recordings-clip"]').nth(1).waitFor();
  console.log("PASS failed load -> explicit retry -> two clips");
  await page.locator('[data-qa="recordings-delete-clip"]').first().click();
  await page.locator('[data-qa="recordings-confirm"] button').first().click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Aufnahmen konnten nicht gelöscht werden" })
    .waitFor();
  if ((await page.locator('[data-qa="recordings-clip"]').count()) !== 2)
    throw new Error("Failed deletion removed a clip");
  console.log("PASS failed deletion keeps clips and reports a retryable error");
  for (const id of clips.map((c) => c.id)) {
    await page.locator(`[data-clip="${id}"] [data-qa="recordings-delete-clip"]`).click();
    await page.locator('[data-qa="recordings-confirm"] button').first().click();
  }
  await page.waitForFunction(() => true);
  const deadline = Date.now() + 5000;
  while (pending.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  if (pending.length !== 2) throw new Error("Expected two pending deletes");
  await pending[1].fulfill({ json: { ok: true, deleted: 1 } });
  await page.locator(`[data-clip="${clips[1].id}"]`).waitFor({ state: "detached" });
  await pending[0].fulfill({ json: { ok: true, deleted: 1 } });
  await page.locator(`[data-clip="${clips[0].id}"]`).waitFor({ state: "detached" });
  const remaining = await page.locator('[data-qa="recordings-clip"]').count();
  console.log("concurrent deletion remaining clips:", remaining);
  if (remaining !== 0) throw new Error("A deleted clip reappeared after concurrent deletes");
  if (pageErrors.length) throw new Error(pageErrors.join("\n"));
  console.log("PASS concurrent deletion");
} finally {
  await context.close();
  await browser.close();
  server.stop(true);
}

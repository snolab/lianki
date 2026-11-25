// Isolated, silent UI proof. No live account, userscript manager, or external requests.
import { expect } from "@playwright/test";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { launchSilent, newSilentContext } from "./silent.mjs";
import dictionary from "../../app/(app)/chat/sites/pill-install.content";
const locales = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "ar",
  "bn",
  "pt",
  "ru",
  "ur",
  "id",
  "de",
  "ja",
  "sw",
  "mr",
  "ko",
];
const labels = Object.fromEntries(
  locales.map((locale) => [
    locale,
    Object.fromEntries(
      Object.entries(dictionary.content).map(([key, value]) => [key, value.translation[locale]]),
    ),
  ]),
);
const built = await Bun.build({
  entrypoints: ["pill-install-entry"],
  target: "browser",
  plugins: [
    {
      name: "pill-install-proof",
      setup(build) {
        build.onResolve({ filter: /^pill-install-entry$/ }, () => ({
          path: "entry",
          namespace: "pill-proof",
        }));
        build.onLoad({ filter: /.*/, namespace: "pill-proof" }, () => ({
          loader: "tsx",
          resolveDir: process.cwd(),
          contents: `import React from 'react';import {createRoot} from 'react-dom/client';
import Guide from ${JSON.stringify(resolve("app/(app)/chat/sites/PillInstallGuide.tsx"))};
const labels=${JSON.stringify(labels)};const locale=new URL(location.href).searchParams.get('lang')||'en';
createRoot(document.getElementById('root')).render(<Guide latestVersion="2.10.0" labels={labels[locale]}/>);`,
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
    const path = new URL(req.url).pathname;
    if (path === "/entry.js") return new Response(built.outputs[0]);
    if (path === "/style.css")
      return new Response(css, { headers: { "content-type": "text/css" } });
    return new Response(
      '<meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><div id="root" style="max-width:42rem;margin:auto;padding:1rem"></div><script type="module" src="/entry.js"></script>',
      { headers: { "content-type": "text/html" } },
    );
  },
});
const browser = await launchSilent(chromium);
try {
  const context = await newSilentContext(browser);
  const page = await context.newPage();
  await page.goto(server.url.href);
  const guide = page.getByTestId("pill-install-guide");
  await expect(guide).toHaveAttribute("data-install-status", "missing");
  await expect(page.getByTestId("pill-install-link")).toHaveAttribute("href", "/lianki.user.js");
  await expect(page.getByTestId("pill-manager-help")).toHaveAttribute(
    "href",
    "https://www.tampermonkey.net/",
  );
  await page.evaluate(() =>
    localStorage.setItem("lk:status", JSON.stringify({ version: "99.0.0" })),
  );
  await page.reload();
  await expect(guide).toHaveAttribute("data-install-status", "missing");
  console.log(
    "PASS missing script and stale localStorage show installation, not a false ready state",
  );
  const cdp = await context.newCDPSession(page);
  const tree = await cdp.send("Page.getFrameTree");
  const isolated = await cdp.send("Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id,
    worldName: "userscript-presence-proof",
  });
  const inject = async (version) =>
    cdp.send("Runtime.evaluate", {
      contextId: isolated.executionContextId,
      expression: `document.documentElement.setAttribute('data-lianki-userscript-version', ${JSON.stringify(version)})`,
    });
  await inject("2.9.0");
  await expect(guide).toHaveAttribute("data-install-status", "outdated");
  await expect(page.getByTestId("pill-install-link")).toContainText(labels.en.update);
  await inject("2.10.0");
  await expect(guide).toHaveAttribute("data-install-status", "ready");
  await expect(page.getByTestId("pill-try-site")).toHaveAttribute("href", "https://example.com/");
  await expect(page.getByTestId("pill-try-site")).toHaveAttribute("rel", "noopener noreferrer");
  console.log("PASS isolated-world version marker switches update to example.com trial");
  await inject("bad-version");
  await expect(guide).toHaveAttribute("data-install-status", "outdated");
  await expect(page.getByTestId("pill-try-site")).toHaveCount(0);
  await context.close();

  const mobile = await newSilentContext(browser, { viewport: { width: 320, height: 720 } });
  const small = await mobile.newPage();
  for (const locale of locales) {
    await small.goto(new URL("?lang=" + locale, server.url).href);
    await small.addStyleTag({ content: "html { font-size: 150%; }" });
    const card = small.getByTestId("pill-install-guide");
    await expect(card).toHaveAttribute("data-install-status", "missing");
    const fits = () => small.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    expect(await fits(), locale + " install width").toBe(true);
    await small.evaluate(() =>
      document.documentElement.setAttribute("data-lianki-userscript-version", "2.10.0"),
    );
    await expect(card).toHaveAttribute("data-install-status", "ready");
    await expect(small.getByTestId("pill-try-site")).toBeVisible();
    expect(await fits(), locale + " trial width").toBe(true);
  }
  console.log("PASS sixteen locales at 320px / 150%: installation and trial layouts");
  await mobile.close();
} finally {
  await browser.close();
  server.stop(true);
}

#!/usr/bin/env bun
/** Local controlled pages only. Native Chromium checks frame reuse and sandbox restrictions;
 * the request/DNS/auth contracts are exercised in unit/review-preview*.test.ts.
 *   bun scripts/qa/qa-review-previews.ts
 */
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { headersAllowPreview } from "../../lib/review-preview";

const built = await Bun.build({
  entrypoints: [`${import.meta.dir}/review-previews-fixture.tsx`],
  target: "browser",
  format: "esm",
});
if (!built.success) throw new Error(built.logs.map(String).join("\n"));
const code = await built.outputs[0]!.text();
const counts = new Map<string, number>();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (url.pathname === "/fixture.js")
      return new Response(code, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/")
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Preview fixture</title><div id="root"></div><script type="module" src="/fixture.js"></script>',
        { headers: { "content-type": "text/html" } },
      );
    if (url.pathname === "/escape.js")
      return new Response(
        "document.documentElement.dataset.scriptRan='yes'; new Image().src='/executed'; top.location.href='/escaped'",
        {
          headers: { "content-type": "text/javascript" },
        },
      );
    const headers = new Headers({ "content-type": "text/html" });
    if (url.pathname === "/blocked-xfo") headers.set("x-frame-options", "DENY");
    if (url.pathname === "/blocked-csp")
      headers.set("content-security-policy", "frame-ancestors 'none'");
    return new Response(
      request.method === "HEAD"
        ? null
        : `<h1>${url.pathname}</h1><script src="/escape.js"></script>`,
      { headers },
    );
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const browser = await launchSilent(chromium);
try {
  const context = await newSilentContext(browser);
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => typeof (globalThis as any).renderReviewPreviews === "function");
  const render = async (current: string, next: string | null, preview = true, enabled = true) =>
    page.evaluate(
      ({ origin, current, next, preview, enabled }) => {
        (globalThis as any).renderReviewPreviews(
          { id: current, url: origin + current, title: current, due: null },
          next
            ? { url: origin + next, title: next, previewUrl: preview ? origin + next : null }
            : null,
          enabled,
        );
      },
      { origin, current, next, preview, enabled },
    );
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
  };

  await render("/a", "/b");
  const b = page.locator('iframe[src$="/b"]');
  await b.waitFor();
  await b.contentFrame().locator("h1").waitFor();
  check((await b.getAttribute("sandbox")) === "", "sandbox must have no permission tokens");
  check((await b.getAttribute("allow"))?.includes("autoplay 'none'"), "autoplay must be denied");
  const bHandle = await b.elementHandle();
  const bFrame = await bHandle!.contentFrame();
  await bFrame!.waitForLoadState("load");
  check(
    (await bFrame!.evaluate(() => document.documentElement.dataset.scriptRan ?? null)) === null,
    "sandbox allowed page script execution",
  );
  await render("/b", "/c");
  const c = page.locator('iframe[src$="/c"]');
  await c.contentFrame().locator("h1").waitFor();
  const promotedB = await b.elementHandle();
  check(
    await bHandle!.evaluate((node, other) => node === other, promotedB),
    "warmed iframe DOM was replaced",
  );
  check((await promotedB!.contentFrame()) === bFrame, "warmed browsing context was replaced");
  check(counts.get("GET /b") === 1, "promoting B reloaded it");
  check((await page.locator("iframe").count()) === 2, "must retain at most current plus next");
  await render("/c", null);
  await page.waitForFunction(() => document.querySelectorAll("iframe").length === 1);
  check(counts.get("GET /c") === 1, "promoting C reloaded it");
  check(!counts.has("GET /executed"), "sandbox allowed the page's script to execute");
  check(page.url() === origin + "/", "framed page navigated the top level");

  for (const blocked of ["/blocked-xfo", "/blocked-csp"]) {
    const response = await fetch(origin + blocked, { method: "HEAD" });
    check(
      !headersAllowPreview(response.headers, origin + blocked, origin),
      "blocked fixture was misclassified",
    );
    await render("/a", blocked, false);
    await page.locator('[data-testid="review-preview-fallback"]').waitFor();
    check((await page.locator("iframe").count()) === 0, "blocked preview left an empty iframe");
    check(
      (await page.locator("a").getAttribute("href")) === origin + blocked,
      "fallback lost the real link",
    );
    check(!counts.has(`GET ${blocked}`), "blocked page was downloaded");
  }
  await render("/a", "/d", true, false);
  await page.waitForFunction(() => !document.querySelector('[data-testid="review-page-previews"]'));
  check(!counts.has("GET /d"), "disabled preview made a request");
  console.log(
    JSON.stringify({
      passed: true,
      proof: "controlled local Chromium fixture",
      silentInstrumentation: true,
      bRequests: counts.get("GET /b"),
      cRequests: counts.get("GET /c"),
      scriptDownloads: counts.get("GET /escape.js") ?? 0,
      scriptExecutions: counts.get("GET /executed") ?? 0,
      blockedGets: 0,
    }),
  );
  await context.close();
} finally {
  await browser.close();
  server.stop(true);
}

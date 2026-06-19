/**
 * Userscript Redirect-Detection Tests (checkRedirect)
 *
 * Drives the REAL compiled userscript headlessly and exercises checkRedirect():
 * the logic that, after Lianki navigates to a card, detects whether the site
 * landed on a different URL and offers to update the card's stored URL.
 *
 * Why this exists: ?theme=dark (and other display-preference params) used to
 * normalize to a *different* URL, so visiting a card with the theme toggled
 * fired a spurious "Update the card to point to the new URL?" prompt and
 * ping-ponged the stored url. normalizeUrl now strips `theme`; these tests pin
 * that behavior end-to-end through the userscript's own normalizeUrl copy.
 *
 * Technique (same as userscript-guest.spec.ts):
 * - page.route serves minimal HTML for any URL so location.href can be a real
 *   https:// origin offline (checkRedirect compares normalizeUrl(location.href)
 *   against the stored intended URL).
 * - GM_* shimmed via addInitScript; lk:nav_intended seeded BEFORE the script
 *   loads so the on-load checkRedirect() fires against it.
 * - window.confirm overridden to auto-accept and record calls.
 * - GM_xmlhttpRequest mocked: records any PATCH /api/fsrs/update-url, returns
 *   {ok:true}; everything else (addNote 401 guest flow, etc.) returns 401.
 */

import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "fs";
import { join } from "path";

const SCRIPT_CONTENT = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");
const WRAPPED_CONTENT = `(function() {\n${SCRIPT_CONTENT}\n})();`;

const ZHIHU = "https://www.zhihu.com/question/23857983";

/**
 * Load the userscript on `actualUrl` with `intendedUrl` pre-stored as the
 * navigation target. Returns the recorded confirm() prompts and update-url
 * PATCH payloads, plus the final lk:nav_intended value.
 */
async function runRedirect(page: Page, intendedUrl: string, actualUrl: string) {
  // Serve any URL with a tiny HTML doc so navigation works without network.
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>t</title>" }),
  );

  await page.addInitScript((intended: string) => {
    const w = window as any;
    w.__gm = {} as Record<string, string>;
    // Seed the intended URL with a fresh (non-stale) timestamp.
    w.__gm["lk:nav_intended"] = JSON.stringify({ url: intended, ts: Date.now() });
    w.GM_getValue = (k: string, d: unknown = "") => w.__gm[k] ?? d;
    w.GM_setValue = (k: string, v: unknown) => {
      w.__gm[k] = v;
    };
    w.GM_deleteValue = (k: string) => {
      delete w.__gm[k];
    };
    w.GM_info = {
      script: { version: "0.0.0", downloadURL: "https://www.lianki.com/lianki.user.js" },
    };

    // Record confirm() prompts; auto-accept.
    w.__confirms = [] as string[];
    w.confirm = (msg: string) => {
      w.__confirms.push(msg);
      return true;
    };

    // Mock the API: capture update-url PATCH bodies, 401 everything else.
    w.__patches = [] as unknown[];
    w.GM_xmlhttpRequest = ({ url, method, data, onload }: any) => {
      const u = String(url ?? "");
      const isUpdateUrl = u.includes("/api/fsrs/update-url") && method === "PATCH";
      if (isUpdateUrl) w.__patches.push(JSON.parse(data));
      setTimeout(
        () =>
          onload({
            status: isUpdateUrl ? 200 : 401,
            responseText: isUpdateUrl ? JSON.stringify({ ok: true }) : "Unauthorized",
            responseHeaders: "content-type: application/json\r\n",
          }),
        10,
      );
    };
  }, intendedUrl);

  await page.goto(actualUrl);
  await page.addScriptTag({ content: WRAPPED_CONTENT });
  // checkRedirect runs on load; give the mocked async PATCH time to resolve.
  await page.waitForTimeout(400);

  return page.evaluate(() => {
    const w = window as any;
    return {
      confirms: w.__confirms as string[],
      patches: w.__patches as { oldUrl: string; newUrl: string }[],
      navIntended: w.__gm["lk:nav_intended"] as string,
    };
  });
}

test.describe("checkRedirect — theme param", () => {
  test("?theme=dark does NOT trigger an update prompt (fix)", async ({ page }) => {
    const r = await runRedirect(page, ZHIHU, `${ZHIHU}?theme=dark`);
    expect(r.confirms).toHaveLength(0); // normalizeUrl strips theme → URLs equal
    expect(r.patches).toHaveLength(0); // no card-URL rewrite
    expect(r.navIntended).toBe(""); // cleared as "no redirect"
  });
});

test.describe("checkRedirect — genuine redirect still works", () => {
  test("different path prompts and PATCHes update-url with old/new", async ({ page }) => {
    const newUrl = "https://www.zhihu.com/question/99999999";
    const r = await runRedirect(page, ZHIHU, newUrl);
    expect(r.confirms).toHaveLength(1);
    expect(r.confirms[0]).toContain("Update the card to point to the new URL?");
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0].oldUrl).toBe(ZHIHU);
    expect(r.patches[0].newUrl).toBe(newUrl);
  });
});

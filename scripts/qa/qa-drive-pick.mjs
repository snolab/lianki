// "Choose docs from Google Drive" on /reader (docs/connections.md, "Picking
// docs"): silent, iPhone and desktop, light and dark screenshots. Google's
// Picker is Google's UI, so it is mocked here: `window.gapi` and
// `google.picker` are stubbed before the page loads (the stub "picks" two
// docs and records how it was built), and the picker and import routes are
// answered by the test. Nothing reaches Google.
//
//   QA_BASE=http://localhost:3417 bun scripts/qa/qa-drive-pick.mjs [outDir]
//
// Against qa:all's wrangler dev (--keep) with the connections.google flag on
// in its local D1:
//   bunx wrangler d1 execute lianki --local --command "INSERT OR REPLACE INTO
//   feature_flags (key, enabled, updated_at, updated_by) VALUES
//   ('connections.google', 1, datetime('now'), 'qa')"
// (delete the row after; the other read suites expect it off).
//
// Checks: the button and the three-step how-to show next to "Import Google
// Doc"; a tap opens the Picker with multi-select on and no preselected doc;
// both picked docs import through Drive; the result line says 2; not
// connected (409) goes to Google's consent with return /reader?pick=drive; back
// with ?pick=drive&google=connected the Picker opens with no tap and the URL
// is clean; ?pick=drive&google=denied opens nothing.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/drive-pick";
const PW = "qa-test-pass-1234";
const A = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
const B = "1BbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

// The Picker stub: records what the app built, answers PICKED with A and B.
const PICKER_STUB = `(() => {
  window.__picker = { built: 0, multi: false, fileIds: null, token: null };
  const P = {
    ViewId: { DOCUMENTS: "docs" },
    DocsViewMode: { LIST: "list" },
    Feature: { MULTISELECT_ENABLED: "multi" },
    Action: { PICKED: "picked", CANCEL: "cancel" },
    Response: { ACTION: "action", DOCUMENTS: "docs" },
    Document: { ID: "id", MIME_TYPE: "mimeType" },
    DocsView: class {
      setFileIds(ids) { window.__picker.fileIds = ids; }
      setMimeTypes() {} setMode() {} setIncludeFolders() {}
    },
    PickerBuilder: class {
      addView() {} setDeveloperKey() {} setAppId() {} setOrigin() {}
      setOAuthToken(t) { window.__picker.token = t; }
      enableFeature(f) { if (f === "multi") window.__picker.multi = true; }
      setCallback(cb) { this.cb = cb; }
      build() {
        window.__picker.built++;
        const cb = this.cb;
        return {
          setVisible() {
            setTimeout(() => cb({ action: "picked", docs: [{ id: "${A}" }, { id: "${B}" }] }), 50);
          },
          dispose() {},
        };
      }
    },
  };
  window.gapi = { load(_n, o) { window.google = { picker: P }; o.callback(); } };
})();`;

const browser = await launchSilent(chromium);

async function account(device, tag) {
  const ctx = await newSilentContext(browser, { ...device, baseURL: BASE });
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+${tag}${Date.now()}@lianki.test`, password: PW, name: "QA Drive" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up ${tag} (${r.status()})`);
  await ctx.addInitScript(PICKER_STUB);
  return ctx;
}

/** Answer the picker and import routes; `connected` false → 409 not-connected. */
async function mockRoutes(ctx, state) {
  await ctx.route("**/api/connections/google/picker", (r) =>
    state.connected
      ? r.fulfill({ json: { accessToken: "qa-token", apiKey: "qa-key", appId: "1" } })
      : r.fulfill({ status: 409, json: { error: "not-connected" } }),
  );
  await ctx.route("**/api/connections/google/start", (r) => {
    state.startBody = r.request().postDataJSON();
    return r.fulfill({ json: { url: "https://accounts.google.com/o/oauth2/v2/auth?qa=1" } });
  });
  await ctx.route("https://accounts.google.com/**", (r) => {
    state.wentToGoogle = true;
    return r.fulfill({ contentType: "text/html", body: "<p>consent</p>" });
  });
  await ctx.route("**/api/read/gdoc", (r) => {
    const b = r.request().postDataJSON();
    state.imports.push(b);
    return r.fulfill({ json: { id: `qa-${state.imports.length}`, title: "QA", updated: false } });
  });
  await ctx.route("https://apis.google.com/**", (r) => r.fulfill({ body: "" }));
}

for (const [name, device] of [
  ["iphone", devices["iPhone 13"]],
  ["desktop", { viewport: { width: 1280, height: 860 } }],
]) {
  const ctx = await account(device, `drive-${name}`);
  const state = { connected: true, imports: [], startBody: null, wentToGoogle: false };
  await mockRoutes(ctx, state);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));

  await page.goto("/reader", { waitUntil: "networkidle" });
  const btn = page.locator('[data-testid="drive-pick-read"] [data-testid="drive-pick"]');
  check(await btn.isVisible(), `${name}: the Drive button shows on /reader`);
  check(
    await page.locator('[data-testid="read-import-gdoc"]').isVisible(),
    `${name}: paste-link import still there`,
  );
  check(
    (await page.locator('[data-testid="drive-pick-howto"] li').count()) === 3,
    `${name}: three-step how-to`,
  );
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: join(OUT, `read-${name}-${scheme}.png`), fullPage: false });
  }
  await page.emulateMedia({ colorScheme: "light" });

  await btn.click();
  await page.locator('[data-testid="drive-pick-msg"]').waitFor({ timeout: 8000 });
  // Done when the line stops being a progress line ("…").
  await page
    .waitForFunction(
      () => {
        const t = document.querySelector('[data-testid="drive-pick-msg"]')?.textContent ?? "";
        return t && !t.includes("…");
      },
      null,
      { timeout: 8000 },
    )
    .catch(() => {});
  const pk = await page.evaluate(() => window.__picker);
  check(pk.built === 1 && pk.multi && pk.fileIds === null, `${name}: Picker multi-select, no link`);
  check(pk.token === "qa-token", `${name}: Picker gets the Drive token`);
  check(
    state.imports.length === 2 &&
      state.imports.every((b) => b.via === "drive") &&
      state.imports[0].url.includes(A) &&
      state.imports[1].url.includes(B),
    `${name}: both picked docs import through Drive (${state.imports.length})`,
  );
  const msg = await page.locator('[data-testid="drive-pick-msg"]').innerText();
  check(/2/.test(msg), `${name}: result line counts 2 (${msg})`);
  await page.screenshot({ path: join(OUT, `read-${name}-imported.png`) });

  // Not connected: to Google's consent, coming back to /reader?pick=drive.
  state.connected = false;
  await page.goto("/reader", { waitUntil: "networkidle" });
  await btn.click();
  await page.waitForURL(/accounts\.google\.com/, { timeout: 8000 }).catch(() => {});
  check(
    state.wentToGoogle && state.startBody?.return === "/reader?pick=drive",
    `${name}: not connected → consent, return /reader?pick=drive`,
  );

  // Back from consent: the Picker opens by itself, the URL is clean.
  state.connected = true;
  state.imports = [];
  await page.goto("/reader?pick=drive&google=connected", { waitUntil: "networkidle" });
  await page
    .waitForFunction(() => window.__picker?.built === 1, null, { timeout: 8000 })
    .catch(() => {});
  check(
    (await page.evaluate(() => window.__picker.built)) === 1,
    `${name}: Picker opens with no tap after connecting`,
  );
  check(new URL(page.url()).search === "", `${name}: pick words left the URL`);

  // A denial opens nothing.
  await page.goto("/reader?pick=drive&google=denied", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  check((await page.evaluate(() => window.__picker.built)) === 0, `${name}: denied → no Picker`);

  check(errs.length === 0, `${name}: no page errors (${errs.join("; ")})`);
  await ctx.close();
}

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);

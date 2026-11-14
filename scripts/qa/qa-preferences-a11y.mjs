// Keyboard and focus regression check for the preference editor and real token form.
// Other settings widgets are omitted: this harness exercises these two editors
// without credentials, a database, or access to the system clipboard.
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import AxeBuilder from "@axe-core/playwright";
import prefs from "../../app/(app)/my/preferences/page.content.ts";
import tokens from "../../app/components/api-tokens.content.ts";
import guide from "../../lib/agent-guide.content.ts";
import seals from "../../app/components/seal-switch.content.ts";
import readPolish from "../../app/(app)/reader/read-polish.content.ts";

const dictionaries = Object.fromEntries(
  [prefs, tokens, guide, seals, readPolish].map((d) => [d.key, d.content]),
);
const omitted = [
  "PaperSkinPicker",
  "TextSizeControls",
  "ByokSettings",
  "TitleRulesSettings",
  "ExternalLinkSettings",
  "AutoUpdateSettings",
  "DontAskReview",
  "AppBadgeSettings",
  "MailSettings",
  "LanguageSettings",
  "PreferredLangsSettings",
];
const out = await mkdtemp(join(tmpdir(), "lianki-prefs-a11y-"));
let browser, context, server;
try {
  const built = await Bun.build({
    entrypoints: ["a11y-entry"],
    outdir: out,
    target: "browser",
    plugins: [
      {
        name: "isolated-preference-editors",
        setup(build) {
          build.onResolve({ filter: /^a11y-entry$/ }, () => ({ path: "entry", namespace: "a11y" }));
          build.onLoad({ filter: /.*/, namespace: "a11y" }, () => ({
            loader: "tsx",
            resolveDir: process.cwd(),
            contents: `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import Preferences from ${JSON.stringify(resolve("app/(app)/my/preferences/PreferencesClient.tsx"))};
        createRoot(document.getElementById('root')).render(<Preferences/>);
      `,
          }));
          build.onResolve({ filter: /^next-intlayer$/ }, () => ({
            path: "intlayer",
            namespace: "a11y-dictionary",
          }));
          build.onLoad({ filter: /.*/, namespace: "a11y-dictionary" }, () => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents: `
        import React from 'react'; const dictionaries=${JSON.stringify(dictionaries)};
        function wrap(v) {
          if(v && v.translation) {const text=v.translation.en; return {...React.createElement('span',null,text),value:text};}
          if(Array.isArray(v)) return v.map(wrap);
          if(v && typeof v==='object') return Object.fromEntries(Object.entries(v).map(([k,v])=>[k,wrap(v)]));
          return v;
        }
        export const useIntlayer=(key)=>wrap(dictionaries[key]||new Proxy({}, {get:(_,key)=>String(key)}));
        export const useLocale=()=>({locale:'en'});
      `,
          }));
          build.onResolve({ filter: new RegExp("/(" + omitted.join("|") + ")$") }, (args) => ({
            path: args.path.split("/").at(-1),
            namespace: "a11y-omitted",
          }));
          build.onLoad({ filter: /.*/, namespace: "a11y-omitted" }, (args) => ({
            loader: "js",
            contents: `export const ${args.path}=()=>null;`,
          }));
        },
      },
    ],
  });
  assert.equal(built.success, true, built.logs.map(String).join("\n"));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/entry.js") return new Response(built.outputs[0]);
      return new Response(`<div id="root"></div><script type="module" src="/entry.js"></script>`, {
        headers: { "content-type": "text/html" },
      });
    },
  });
  browser = await launchSilent(chromium);
  context = await newSilentContext(browser);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.route("**/api/preferences", (route) =>
    route.fulfill({
      json: { mobileExcludePatterns: [], reviewOrder: "newest", watchTracking: true },
    }),
  );
  let createdScopes;
  await page.route("**/api/token", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      createdScopes = body.scopes;
      return route.fulfill({
        json: {
          token: "fixture-not-a-live-token",
          name: body.name,
          scopes: body.scopes,
          expiresAt: "2027-01-01",
        },
      });
    }
    return route.fulfill({ json: { account: "test account", tokens: [] } });
  });
  await page.goto(server.url.toString());
  const pattern = page.locator("#filter-pattern");
  await pattern.waitFor();
  const labelled = await pattern.evaluate((el) => el.labels.length > 0);
  assert.equal(labelled, true, "filter input has an associated label");
  await pattern.fill("[");
  await page.locator('[aria-labelledby="pattern-regex-label"]').click();
  await pattern.press("Enter");
  assert.equal(await pattern.getAttribute("aria-invalid"), "true");
  assert.equal(
    await pattern.evaluate((el) => el === document.activeElement),
    true,
    "invalid regex keeps input focus",
  );
  await pattern.fill("example.com");
  await pattern.press("Enter");
  assert.equal(await pattern.inputValue(), "");
  await page.getByRole("button", { name: "Remove: example.com", exact: true }).click();
  assert.equal(
    await pattern.evaluate((el) => el === document.activeElement),
    true,
    "removal restores input focus",
  );
  await page.getByRole("radio").last().check();
  await page.locator("[data-dirty-save]").click();
  await page.getByRole("status").filter({ hasText: "saved" }).waitFor();
  const audit = await new AxeBuilder({ page })
    .withRules(["label", "button-name", "aria-valid-attr-value", "aria-input-field-name"])
    .analyze();
  assert.deepEqual(
    audit.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
    [],
  );
  const name = page.getByTestId("token-name");
  await name.fill("assistant");
  await name.press("Enter");
  assert.equal(
    await page
      .locator('[data-token-picker="permissions"] input')
      .first()
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByTestId("token-chat-only").click();
  await name.press("Enter");
  assert.equal(
    await page
      .locator('[data-token-picker="expiry"] button')
      .first()
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.locator('[data-token-picker="expiry"] button').first().click();
  await name.press("Enter");
  await page.getByTestId("token-share-copy").waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-testid") === "token-share-copy",
  );
  assert.deepEqual(createdScopes, ["chat:read", "chat:write", "chat:ask"]);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await name.evaluate((el) => el === document.activeElement), true);
  assert.deepEqual(pageErrors, []);
  console.log(
    "PASS: associated labels, Enter validation, regex error, removal focus, token scope/expiry focus, creation and Done focus.",
  );
} finally {
  await context?.close();
  await browser?.close();
  server?.stop(true);
  await rm(out, { recursive: true, force: true });
}

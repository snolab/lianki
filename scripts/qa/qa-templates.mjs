// The mail template editor at /dev/templates (docs/mail-templates.md, "Editor").
// Silent; desktop (1280) and phone (360), light and dark, with screenshots.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-templates.mjs [outDir]
//
// In qa:all (suite templates), or against any local server on local D1. A
// throwaway account is granted `dev` in the LOCAL account_permission (as
// qa-pregrant does with admin); the grant is removed at the end and every
// template it touched is rolled back to the built-in. Versions stay in local
// D1 (the table is append-only by design). The test send is the local stub: a
// server on localhost never mails. Fake addresses at lianki.test only.
//
// - a non-developer gets 404 from /api/dev/templates;
// - pick a template + language → the editor holds the built-in, the preview
//   renders it (subject and frame);
// - edit the subject → the preview follows live;
// - break the HTML (an onclick) → the error list shows, Save is disabled;
// - fix it → Save → "saved", the new version is active;
// - Send test to me → "sent" (stub);
// - Diff on the built-in row shows the change; roll back to the built-in →
//   it is active again;
// - no sideways scroll at 360 px; the editor and preview stack on a phone and
//   sit side by side on a desktop.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/templates";
const PW = "qa-test-pass-1234";
const RUN = Date.now();
const DEV = `qa+tpldev${RUN}@lianki.test`;
const PLAIN = `qa+tplplain${RUN}@lianki.test`;
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const d1 = (command) => {
  const r = spawnSync(
    "bunx",
    ["wrangler", "d1", "execute", "lianki", "--local", "--command", command],
    {
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(`local D1: ${r.stderr}`);
};

const LAYOUTS = {
  phone: { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 900 } },
};

const newCtx = (browser, layout, scheme) =>
  newSilentContext(browser, {
    baseURL: BASE,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    ...LAYOUTS[layout],
  });

async function signUp(ctx, email) {
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email, password: PW, name: "QA Templates" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up ${email.split("@")[0]} (${r.status()})`);
}
async function signIn(ctx, email) {
  const r = await ctx.request.post("/api/auth/sign-in/email", {
    data: { email, password: PW },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-in ${email.split("@")[0]} (${r.status()})`);
}

/** The permission snapshot refreshes within ~20 s: wait for the editor, reloading. */
async function openEditor(page) {
  for (let i = 0; i < 12; i++) {
    await page.goto("/dev/templates");
    if (await page.locator("[data-testid=tpl-subject]").count()) return true;
    await page.waitForTimeout(3000);
  }
  return false;
}

const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// One template + language per run: the four passes do not see each other's versions.
const PASSES = [
  { layout: "desktop", scheme: "light", id: "signin-code", locale: "ja" },
  { layout: "desktop", scheme: "dark", id: "login-notice", locale: "zh-Hant" },
  { layout: "phone", scheme: "light", id: "email-changed", locale: "ar" },
  { layout: "phone", scheme: "dark", id: "invite", locale: "de" },
];

const browser = await launchSilent(chromium);
try {
  {
    const ctx = await newCtx(browser, "phone", "light");
    await signUp(ctx, PLAIN);
    const r = await ctx.request.get("/api/dev/templates");
    check(r.status() === 404, `non-developer GET /api/dev/templates is 404 (${r.status()})`);
    await ctx.close();
  }

  const signup = await newCtx(browser, "phone", "light");
  await signUp(signup, DEV);
  await signup.close();
  d1(
    `INSERT OR REPLACE INTO account_permission (email, permission, granted_by, granted_at) VALUES ('${DEV}', 'dev', 'qa', ${Date.now()})`,
  );

  for (const p of PASSES) {
    const tag = `${p.layout}-${p.scheme}`;
    const ctx = await newCtx(browser, p.layout, p.scheme);
    await signIn(ctx, DEV);
    const page = await ctx.newPage();
    check(await openEditor(page), `${tag}: the editor shows for a developer`);
    await page.locator("[data-testid=tpl-id]").selectOption(p.id);
    await page.locator("[data-testid=tpl-locale]").selectOption(p.locale);
    await page.waitForTimeout(800);
    const subject = page.locator("[data-testid=tpl-subject]");
    const builtinSubject = await subject.inputValue();
    check(builtinSubject.length > 0, `${tag}: ${p.id}/${p.locale} loads the built-in`);
    const shown = await page.locator("[data-testid=tpl-preview-subject]").innerText();
    check(shown.length > 0 && !/\{\w+\}/.test(shown), `${tag}: the preview fills the variables`);

    // The mail itself renders inside the sandboxed frame.
    const frame = await page.locator("[data-testid=tpl-preview]").elementHandle();
    const body = await (
      await frame.contentFrame()
    )
      ?.locator("body")
      .innerText()
      .catch(() => "");
    check(
      (body ?? "").trim().length > 20,
      `${tag}: the preview frame shows the mail (${(body ?? "").length} chars)`,
    );

    // Live preview follows the edit.
    await subject.fill(`QA ${RUN} ${builtinSubject}`);
    await page.waitForFunction(
      (run) =>
        document
          .querySelector("[data-testid=tpl-preview-subject]")
          ?.textContent?.startsWith(`QA ${run}`),
      RUN,
    );
    check(true, `${tag}: the preview follows the subject live`);

    // Broken HTML: errors, Save off.
    const html = page.locator("[data-testid=tpl-html]");
    const goodHtml = await html.inputValue();
    await html.fill(goodHtml.replace("<p", '<p onclick="x()"'));
    await page.locator("[data-testid=tpl-errors]").waitFor();
    check(
      await page.locator("[data-testid=tpl-save]").isDisabled(),
      `${tag}: Save is off while the HTML is unsafe`,
    );
    await html.fill(goodHtml);
    check(
      !(await page.locator("[data-testid=tpl-errors]").count()),
      `${tag}: the errors clear once fixed`,
    );

    if (p.layout === "desktop") {
      const [a, b] = await Promise.all([
        page.locator("[data-testid=tpl-html]").boundingBox(),
        page.locator("[data-testid=tpl-preview]").boundingBox(),
      ]);
      check(a && b && b.x > a.x + a.width - 1, `${tag}: editor and preview side by side`);
    } else {
      const [a, b] = await Promise.all([
        page.locator("[data-testid=tpl-text]").boundingBox(),
        page.locator("[data-testid=tpl-preview]").boundingBox(),
      ]);
      check(a && b && b.y > a.y, `${tag}: editor and preview stacked`);
    }
    await page
      .locator(p.scheme === "dark" ? "[data-testid=tpl-dark]" : "[data-testid=tpl-light]")
      .click();
    await page.screenshot({ path: join(OUT, `${tag}-edit.png`), fullPage: true });

    // Save → active.
    await page.locator("[data-testid=tpl-save]").click();
    await page.locator("[data-testid=tpl-msg]").waitFor();
    // The list reloads after the answer: wait for the built-in row to offer itself.
    await page
      .locator("[data-testid=tpl-activate-0]")
      .waitFor({ timeout: 10_000 })
      .catch(() => {});
    const top = page.locator("[data-testid=tpl-versions] li").first();
    check((await top.innerText()).includes(`v`), `${tag}: the saved version is listed`);
    check(
      (await page.locator("[data-testid=tpl-activate-0]").count()) === 1,
      `${tag}: the new version is active (the built-in offers to be sent again)`,
    );

    // Test send (stub on a local server).
    await page.locator("[data-testid=tpl-test]").click();
    await page.waitForFunction(() =>
      document.querySelector("[data-testid=tpl-msg]")?.className.includes("150"),
    );
    check(true, `${tag}: Send test to me answers sent`);

    // Diff vs the built-in, then roll back to it.
    await page.locator("[data-testid=tpl-version-0] button", { hasText: /./ }).first().click();
    await page.locator("[data-testid=tpl-diff]").waitFor();
    check(
      (await page.locator("[data-testid=tpl-diff]").innerText()).includes(`QA ${RUN}`),
      `${tag}: the diff shows the edit`,
    );
    await page.screenshot({ path: join(OUT, `${tag}-diff.png`), fullPage: true });
    await page.locator("[data-testid=tpl-activate-0]").click();
    await page.waitForFunction(() => !document.querySelector("[data-testid=tpl-activate-0]"));
    const rolled = await page
      .waitForFunction(
        (want) => document.querySelector("[data-testid=tpl-subject]")?.value === want,
        builtinSubject,
        { timeout: 10_000 },
      )
      .then(() => true)
      .catch(() => false);
    check(rolled, `${tag}: rolled back to the built-in`);
    check(await noSideScroll(page), `${tag}: no sideways scroll`);
    await ctx.close();
  }
} finally {
  try {
    d1(`DELETE FROM account_permission WHERE email = '${DEV}'`);
    for (const p of PASSES)
      d1(`DELETE FROM mail_template_active WHERE template = '${p.id}' AND locale = '${p.locale}'`);
  } catch (e) {
    console.log(`cleanup: ${e.message}`);
  }
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);

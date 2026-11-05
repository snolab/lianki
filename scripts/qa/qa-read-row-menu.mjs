// /read list: the "⋯" menu on each row (Rename, Delete). Silent; iPhone and
// desktop, light and dark screenshots.
//
//   QA_BASE=http://localhost:3417 bun scripts/qa/qa-read-row-menu.mjs [outDir]
//
// Signs up a throwaway account, adds two text materials through the API,
// and checks: no trash button on the row any more, the menu button is a
// labelled 44 px menu button; keyboard: ↓ opens on Rename, ↓ moves to
// Delete, Esc closes and focus returns to the button; Rename turns the
// title into a field, Esc keeps the old title, Enter saves (and it survives
// a reload); Delete asks (dismissing keeps the row), accepting removes it.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/read-row-menu";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const browser = await launchSilent(chromium);

for (const [name, device] of [
  ["iphone", devices["iPhone 13"]],
  ["desktop", { viewport: { width: 1280, height: 860 } }],
]) {
  const ctx = await newSilentContext(browser, { ...device, baseURL: BASE });
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+rowmenu${name}${Date.now()}@lianki.test`, password: PW, name: "QA Row" },
    headers: { origin: BASE },
  });
  check(r.ok(), `${name}: sign-up (${r.status()})`);
  for (const title of ["First text", "Second text"]) {
    const a = await ctx.request.post("/api/read", {
      data: { title, content: "One line.\nAnother line." },
      headers: { origin: BASE },
    });
    check(a.ok(), `${name}: add "${title}" (${a.status()})`);
  }
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("/read", { waitUntil: "networkidle" });

  const row = page.locator('[data-testid="read-row"]', { hasText: "First text" });
  const btn = row.locator('[data-testid="read-row-menu"]');
  check((await row.locator('button[title="Delete"]').count()) === 0, `${name}: no trash button`);
  check((await btn.getAttribute("aria-haspopup")) === "menu", `${name}: menu button`);
  check(/First text/.test((await btn.getAttribute("aria-label")) ?? ""), `${name}: labelled`);
  const box = await btn.boundingBox();
  check(box && box.width >= 44 && box.height >= 44, `${name}: 44 px target (${box?.width})`);

  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await btn.click();
    await page.locator('[role="menu"]').waitFor();
    await page.screenshot({ path: join(OUT, `menu-${name}-${scheme}.png`) });
    await page.keyboard.press("Escape");
  }
  await page.emulateMedia({ colorScheme: "light" });

  // The last row's menu is not hidden under the bottom bar: both items are
  // the topmost element at their centre.
  await row.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await btn.click();
  await page.locator('[role="menu"]').waitFor();
  const onTop = await page.evaluate(() =>
    [...document.querySelectorAll("[role=menuitem]")].every((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && el.contains(hit);
    }),
  );
  check(onTop, `${name}: the last row's menu is on top, not under the bottom bar`);
  await page.screenshot({ path: join(OUT, `menu-${name}-last-row.png`) });
  await page.keyboard.press("Escape");

  // Keyboard.
  await btn.focus();
  await page.keyboard.press("ArrowDown");
  await page.locator('[role="menu"]').waitFor();
  const focused = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
  await page.waitForTimeout(50);
  check((await focused()) === "read-row-rename", `${name}: ↓ opens on Rename`);
  await page.keyboard.press("ArrowDown");
  check((await focused()) === "read-row-delete", `${name}: ↓ moves to Delete`);
  await page.keyboard.press("Escape");
  check((await page.locator('[role="menu"]').count()) === 0, `${name}: Esc closes`);
  check((await focused()) === "read-row-menu", `${name}: focus back on the button`);

  // Rename: Esc cancels, Enter saves.
  await btn.click();
  await page.locator('[data-testid="read-row-rename"]').click();
  const input = page.locator('[data-testid="read-row-title-input"]');
  await input.fill("Not this");
  await input.press("Escape");
  check(
    (await page.locator('[data-testid="read-row-title"]', { hasText: "First text" }).count()) === 1,
    `${name}: Esc keeps the old title`,
  );
  await page.waitForTimeout(50);
  check((await focused()) === "read-row-menu", `${name}: focus back after Esc`);
  await btn.click();
  await page.locator('[data-testid="read-row-rename"]').click();
  await page.screenshot({ path: join(OUT, `rename-${name}.png`) });
  await input.fill("  My   renamed text ");
  await input.press("Enter");
  await page.locator('[data-testid="read-row-title"]', { hasText: "My renamed text" }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  check(
    (await page
      .locator('[data-testid="read-row-title"]', { hasText: "My renamed text" })
      .count()) === 1,
    `${name}: the new title survives a reload`,
  );

  // Delete: dismiss keeps it, accept removes it.
  const renamed = page.locator('[data-testid="read-row"]', { hasText: "My renamed text" });
  page.once("dialog", (d) => d.dismiss());
  await renamed.locator('[data-testid="read-row-menu"]').click();
  await page.locator('[data-testid="read-row-delete"]').click();
  await page.waitForTimeout(200);
  check((await renamed.count()) === 1, `${name}: dismissing the confirmation keeps it`);
  let msg = "";
  page.once("dialog", (d) => ((msg = d.message()), d.accept()));
  await renamed.locator('[data-testid="read-row-menu"]').click();
  await page.locator('[data-testid="read-row-delete"]').click();
  await renamed.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  check((await renamed.count()) === 0, `${name}: Delete removes it`);
  check(msg.includes("My renamed text"), `${name}: the confirmation names it`);
  await page.reload({ waitUntil: "networkidle" });
  check(
    (await page.locator('[data-testid="read-row"]').count()) === 1,
    `${name}: gone after reload, the other stays`,
  );

  check(errs.length === 0, `${name}: no page errors (${errs.join("; ")})`);
  await ctx.close();
}

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);

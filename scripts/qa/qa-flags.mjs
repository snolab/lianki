// /dev/flags QA (docs/feature-flags.md, "The page"): silent, phone and desktop,
// light and dark. Against a local `wrangler dev` on LOCAL D1 only: it refuses any
// other host, and every flag it changes is in the local database.
//
//   QA_BASE=http://localhost:<port> bun scripts/qa/qa-flags.mjs [outDir]
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { budget } from "./load-budget.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/flags";
if (!["localhost", "127.0.0.1"].includes(new URL(BASE).hostname))
  throw new Error(`qa-flags flips flags: local servers only, not ${BASE}`);
mkdirSync(OUT, { recursive: true });

const EMAIL = `qa+flags-${Date.now()}@lianki.test`;
const PW = "qa-test-pass-1234";

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const sql = (command) => {
  const r = spawnSync(
    "bunx",
    ["wrangler", "d1", "execute", "lianki", "--local", "--command", command],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`local d1: ${r.stderr}`);
};

const browser = await launchSilent(chromium, { channel: "chromium" });

const VIEWS = [
  ["phone", { ...devices["iPhone 13"] }],
  ["small", { ...devices["iPhone SE"], viewport: { width: 320, height: 568 } }],
  ["desktop", { viewport: { width: 1280, height: 800 } }],
];

/** Scroll settled: the row is on screen, and not under the top of the page. */
const inView = (page, key) =>
  page.evaluate(
    (id) =>
      new Promise((done) => {
        const el = document.getElementById(id);
        if (!el) return done(false);
        let last = NaN;
        const settle = () => {
          const y = window.scrollY;
          if (y === last) {
            const r = el.getBoundingClientRect();
            return done(r.top >= 0 && r.top < window.innerHeight);
          }
          last = y;
          setTimeout(settle, 150);
        };
        setTimeout(settle, 150);
      }),
    key,
  );

const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function loadRows(page, path = "/dev/flags") {
  await page.goto(`${BASE}${path}`);
  await page.waitForSelector("[data-flag-group]", { timeout: 30_000 });
}

async function run(name, device, colorScheme) {
  const tag = `${name}-${colorScheme}`;
  const ctx = await newSilentContext(browser, { ...device, colorScheme });
  const page = await ctx.newPage();
  const res = await page.request.post(`${BASE}/api/auth/sign-in/email`, {
    headers: { origin: BASE, "content-type": "application/json" },
    data: { email: EMAIL, password: PW },
  });
  check(res.ok(), `${tag}: signed in as the local owner`);
  const hidden = async (key) => (await page.locator(`[id="${key}"]`).count()) === 0;

  // Sections, the shipped view folded, compact rows.
  await loadRows(page);
  check(await noSideScroll(page), `${tag}: no sideways scroll`);
  check(await hidden("books.catalogue"), `${tag}: a shipped flag starts in a folded section`);
  check(
    (await page.locator('[data-flag-group="shipped"] button[aria-expanded="false"]').count()) === 1,
    `${tag}: the shipped section is folded`,
  );
  check(
    (await page.locator('[id="levels"] [data-flag-state]').count()) === 1 &&
      (await page.locator('[id="levels"] [role="switch"]').count()) === 1,
    `${tag}: the row has its state and its switch`,
  );
  const sizes = await page.evaluate(() => {
    const groups = [...document.querySelectorAll("[data-flag-group]")];
    return {
      list: groups.at(-1).getBoundingClientRect().bottom + window.scrollY,
      top: groups[0].getBoundingClientRect().top + window.scrollY,
      groups: groups.length,
      screen: window.innerHeight,
    };
  });
  console.log(
    `  ${tag}: sections from ${Math.round(sizes.top)}px to ${Math.round(sizes.list)}px, screen ${sizes.screen}px, ${sizes.groups} sections`,
  );
  await page.screenshot({ path: join(OUT, `${tag}-list.png`), fullPage: true });

  // A link into the folded section opens it, unfolds the row, scrolls and marks it.
  await loadRows(page, "/dev/flags#books.catalogue");
  await page.waitForSelector('[id="books.catalogue"][data-highlighted]');
  check(true, `${tag}: #books.catalogue opens the folded section and highlights the row`);
  check(await inView(page, "books.catalogue"), `${tag}: and it is scrolled into view`);
  check(
    (await page.locator('[id="details-books.catalogue"]').count()) === 1,
    `${tag}: the row is unfolded`,
  );
  await page.screenshot({ path: join(OUT, `${tag}-link.png`) });
  const prefs = await page.evaluate(() => localStorage.getItem("lk:pref:flags-view"));
  check(!prefs?.includes("shipped"), `${tag}: a link does not change the device's folded sections`);

  // An old key lands on the new one.
  await loadRows(page, "/dev/flags#live.custom-frontend");
  await page.waitForSelector('[id="my-box"][data-highlighted]');
  check(await inView(page, "my-box"), `${tag}: #live.custom-frontend lands on my-box`);

  // A filter that would hide the target does not, and stays set.
  await loadRows(page);
  await page.getByRole("button", { name: "关着" }).click();
  check(await hidden("my-box"), `${tag}: 关着 hides a flag that is on`);
  await loadRows(page);
  check(
    (await page.getByRole("button", { name: "关着" }).getAttribute("aria-pressed")) === "true",
    `${tag}: the filter survives a reload (this device)`,
  );
  check(await hidden("my-box"), `${tag}: and still applies`);
  await loadRows(page, "/dev/flags#my-box");
  await page.waitForSelector('[id="my-box"][data-highlighted]');
  check(await inView(page, "my-box"), `${tag}: a link gets past the filter`);
  check(
    (await page.getByRole("button", { name: "关着" }).getAttribute("aria-pressed")) === "true",
    `${tag}: and the filter is still set`,
  );
  await page.evaluate(() => {
    location.hash = "";
  });
  await page.getByRole("button", { name: "清除筛选" }).click();

  // A search that would hide the target does not: the link arrives while typed.
  await loadRows(page);
  const search = page.getByRole("searchbox", { name: "搜索开关" });
  await search.fill("stripe");
  check(
    (await page.getByTestId("flags-count").textContent()).trim().startsWith("1 /"),
    `${tag}: a search narrows to its match`,
  );
  check(await hidden("levels"), `${tag}: and hides the rest`);
  await page.evaluate(() => {
    location.hash = "levels";
  });
  await page.waitForSelector('[id="levels"][data-highlighted]');
  check(await inView(page, "levels"), `${tag}: a link gets past the search`);
  await search.fill("对话模式");
  check(
    (await page.locator('[id="read.vibe"]').count()) === 1,
    `${tag}: the description is searched too`,
  );
  await page.screenshot({ path: join(OUT, `${tag}-search.png`), fullPage: true });
  await search.fill("custom-frontend");
  check((await page.locator('[id="my-box"]').count()) === 1, `${tag}: and an old key`);
  await search.fill("no-such-flag-anywhere");
  check((await page.getByText("没有符合的开关").count()) === 1, `${tag}: an empty answer says so`);
  await page.evaluate(() => {
    location.hash = "";
  });
  await search.fill("");

  // Folding a section is remembered on this device; a search opens it for the answer.
  await loadRows(page);
  const stt = page.locator('[data-flag-group="stt"] h2 button');
  await stt.click();
  check(await hidden("stt.merge"), `${tag}: a section folds`);
  await loadRows(page);
  check(await hidden("stt.merge"), `${tag}: and stays folded after a reload`);
  await page.getByRole("searchbox", { name: "搜索开关" }).fill("stt.merge");
  check(!(await hidden("stt.merge")), `${tag}: a search opens it for the answer`);
  await page.getByRole("searchbox", { name: "搜索开关" }).fill("");
  await page.locator('[data-flag-group="stt"] h2 button').click();

  // One tap; the row stays under the finger; a payment flag still asks.
  await loadRows(page);
  await page.getByRole("button", { name: "关着" }).click();
  const before = await page.request.get(`${BASE}/api/dev/flags`).then((r) => r.json());
  const levels = before.flags.find((f) => f.key === "levels");
  check(levels.enabled === false, `${tag}: levels starts off`);
  const sw = page.locator('[id="levels"] [role="switch"]');
  await sw.click();
  // The toast says what was saved, when it takes effect and for whom.
  const toast = page.locator('[data-dev-toast="ok"]');
  await toast.waitFor({ timeout: budget(10000) });
  const said = await toast.innerText();
  check(
    said.includes("levels") && /\d/.test(said),
    `${tag}: a toast says it is saved, with its delay (${said.replace(/\s+/g, " ")})`,
  );
  check(
    (await page.locator("[data-flags-cache-note]").count()) === 1,
    `${tag}: the cache note sits above the list`,
  );
  check(
    (await page.locator('[id="levels"] [data-seal-check="on"]').count()) === 1,
    `${tag}: an on switch is stamped with the seal`,
  );
  await page.screenshot({ path: join(OUT, `${tag}-toast.png`) });
  check(
    (await page.locator('[id="levels"] [role="switch"]').getAttribute("aria-checked")) === "true",
    `${tag}: one tap turns it on`,
  );
  check(!(await hidden("levels")), `${tag}: the filter does not take it from under the finger`);
  await sw.click();
  await page.waitForFunction(
    () =>
      document.querySelector('[id="levels"] [role="switch"]')?.getAttribute("aria-checked") ===
      "false",
  );
  check(true, `${tag}: one tap turns it off again`);
  await page.getByRole("button", { name: "全部" }).click();

  // Locally a payment switch is greyed (no live key), with its reason in the folded row.
  await loadRows(page);
  const pay = page.locator('[id="payments.stripe.live"] [role="switch"]');
  check(await pay.isDisabled(), `${tag}: a payment switch with no live key is greyed`);
  check(
    (await page.locator('[id="payments.stripe.live"] [data-reason]').count()) > 0,
    `${tag}: and the folded row says why`,
  );
  // With the check answered as passing (in this page only), it asks before anything is sent.
  await page.route("**/api/dev/flags", async (route) => {
    if (route.request().method() !== "GET") return route.abort();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), prereqs: {} } });
  });
  const posts = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/dev/flags")) posts.push(r.postData());
  });
  let asked = null;
  page.once("dialog", (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await loadRows(page);
  await pay.click();
  check(asked?.includes("payments.stripe.live"), `${tag}: a payment flag still asks, once`);
  check(posts.length === 0, `${tag}: and declining sends nothing`);
  check((await pay.getAttribute("aria-checked")) === "false", `${tag}: and it stays off`);
  await page.unroute("**/api/dev/flags");
  await page.evaluate(() => localStorage.removeItem("lk:pref:flags-view"));
  await ctx.close();
}

try {
  const signup = await newSilentContext(browser, {});
  const su = await signup.request.post(`${BASE}/api/auth/sign-up/email`, {
    headers: { origin: BASE, "content-type": "application/json" },
    data: { email: EMAIL, password: PW, name: "QA" },
  });
  check(su.ok(), "the QA account signs up");
  await signup.close();
  const at = Date.now();
  sql(
    `INSERT OR REPLACE INTO account_permission (email, permission, granted_by, granted_at) VALUES ('${EMAIL}', 'admin', 'qa', ${at}), ('${EMAIL}', 'dev', 'qa', ${at})`,
  );
  // One flag on for everyone, and a renamed flag on under its old key only.
  sql("DELETE FROM feature_flags");
  sql(
    "INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('books.catalogue', 1, datetime('now'), 'qa'), ('live.custom-frontend', 1, datetime('now'), 'qa')",
  );
  for (const [name, device] of VIEWS) {
    await run(name, device, "light");
    await run(name, device, "dark");
  }
} finally {
  sql("DELETE FROM feature_flags");
  sql(`DELETE FROM account_permission WHERE email = '${EMAIL}'`);
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);

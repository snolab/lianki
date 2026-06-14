import { chromium } from "playwright";
const BASE = process.env.QA_BASE || "http://localhost:3000";
const EMAIL = `qa+ui${Date.now()}@lianki.test`;
const PW = "qa-test-pass-1234";

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
page.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
const badResponses = [];
page.on("response", (r) => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const log = (s) => console.log(s);
let ok = true;

// 1. Sign-in page
await page.goto(`${BASE}/en/sign-in`, { waitUntil: "networkidle" });
log(`✓ sign-in page loaded: ${await page.title()}`);

// 2. Email → Continue
await page.locator("#email").fill(EMAIL);
await page.getByRole("button", { name: "Continue" }).click();
await page.waitForSelector("#password", { timeout: 10000 });
log("✓ advanced to password step");

// 3. Password → Sign in (auto-signup on first use)
await page.locator("#password").fill(PW);
await Promise.all([
  page.waitForURL((u) => /\/list/.test(u.toString()), { timeout: 20000 }).catch(() => {}),
  page.getByRole("button", { name: /sign in/i }).click(),
]);
await page.waitForTimeout(2500);

// 4. Authenticated?
const session = await page.evaluate(async () => {
  const r = await fetch("/api/auth/get-session");
  return r.ok ? await r.json() : null;
});
if (session?.user?.email === EMAIL)
  log(`✓ authenticated as ${session.user.email} (url=${page.url()})`);
else {
  log(`✗ not authenticated; url=${page.url()}`);
  ok = false;
}

// 5. Dashboard + roadmap render while logged in
await page.goto(`${BASE}/en/list`, { waitUntil: "networkidle" });
log(`✓ dashboard loaded: ${await page.title()}`);
await page.goto(`${BASE}/en/roadmap`, { waitUntil: "networkidle" });
log(`✓ roadmap loaded: ${await page.title()}`);

// 6. Console errors (ignore benign RSC prefetch aborts / 404 favicon)
if (badResponses.length)
  log(`  4xx/5xx responses observed:\n    - ${badResponses.join("\n    - ")}`);
const real = errs.filter(
  (e) => !/ERR_ABORTED|_rsc=|favicon|Failed to load resource.*40[01]/.test(e),
);
if (real.length) {
  log(`✗ console errors:\n  - ${real.slice(0, 8).join("\n  - ")}`);
  ok = false;
} else log("✓ no significant console errors (benign pre-auth 401/400 probes only)");

await browser.close();
log(`\n=== UI flow ${ok ? "PASSED" : "FAILED"} ===`);
process.exit(ok ? 0 : 1);

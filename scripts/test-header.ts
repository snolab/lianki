#!/usr/bin/env bun
/**
 * Test unified header across different pages
 */
import { chromium } from "playwright";

const BASE_URL = "https://www.lianki.com";

const PAGES_TO_TEST = [
  { path: "/en", name: "Landing Page" },
  { path: "/en/blog", name: "Blog Index" },
  { path: "/en/blog/2025-01-01-introduction", name: "Blog Post" },
  { path: "/en/learn", name: "Learn Page" },
  { path: "/en/list", name: "Dashboard (requires auth)" },
  { path: "/en/profile", name: "Profile (requires auth)" },
  { path: "/en/membership", name: "Membership (requires auth)" },
  { path: "/en/preferences", name: "Preferences (requires auth)" },
  { path: "/en/polyglot", name: "Polyglot (requires auth)" },
  { path: "/en/self-intro", name: "Self-intro (requires auth)" },
  { path: "/en/sign-in", name: "Sign In" },
];

async function testPage(page: any, url: string, name: string) {
  console.log(`\n🔍 Testing: ${name}`);
  console.log(`   URL: ${url}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    // Wait a bit for any client-side rendering
    await page.waitForTimeout(1000);

    // Check if header exists
    const header = await page.$("header");
    if (!header) {
      console.log("   ❌ No header found");
      return false;
    }
    console.log("   ✅ Header exists");

    // Check for app name/logo link
    const logoLink = await page.$('header a[href*="/en"]');
    if (logoLink) {
      const logoText = await logoLink.textContent();
      console.log(`   ✅ Logo/App Name: "${logoText?.trim()}"`);
    } else {
      console.log("   ⚠️  No logo link found");
    }

    // Check for Learn button
    const learnLink = await page.$('header a[href*="/learn"]');
    if (learnLink) {
      const learnText = await learnLink.textContent();
      console.log(`   ✅ Learn button: "${learnText?.trim()}"`);
    } else {
      console.log("   ⚠️  No Learn link found");
    }

    // Check for Blog button
    const blogLink = await page.$('header a[href*="/blog"]');
    if (blogLink) {
      const blogText = await blogLink.textContent();
      console.log(`   ✅ Blog button: "${blogText?.trim()}"`);
    } else {
      console.log("   ⚠️  No Blog link found");
    }

    // Check for language switcher
    const langButton = await page.$("header button");
    if (langButton) {
      const langText = await langButton.textContent();
      console.log(`   ✅ Language switcher found: "${langText?.trim().substring(0, 20)}..."`);
    }

    // Check for sign in link or profile dropdown
    const signInLink = await page.$('header a[href*="/sign-in"]');
    const profileButton = await page.$("header button");

    if (signInLink) {
      const signInText = await signInLink.textContent();
      console.log(`   ✅ Sign in link: "${signInText?.trim()}"`);
    } else if (profileButton) {
      console.log("   ✅ Profile dropdown found (user logged in)");
    }

    // Take screenshot
    const screenshotPath = `./screenshots/${name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`   📸 Screenshot saved: ${screenshotPath}`);

    return true;
  } catch (error: any) {
    console.log(`   ❌ Error: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log("🚀 Starting header review with headless browser\n");
  console.log(`Testing ${PAGES_TO_TEST.length} pages on ${BASE_URL}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Create screenshots directory
  try {
    await import("fs").then((fs) => fs.mkdirSync("screenshots", { recursive: true }));
  } catch {
    // Directory already exists
  }

  let passed = 0;
  let failed = 0;

  for (const pageInfo of PAGES_TO_TEST) {
    const url = `${BASE_URL}${pageInfo.path}`;
    const result = await testPage(page, url, pageInfo.name);
    if (result) {
      passed++;
    } else {
      failed++;
    }
  }

  await browser.close();

  console.log("\n" + "=".repeat(60));
  console.log(`\n📊 Test Summary:`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📁 Screenshots saved in ./screenshots/\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();

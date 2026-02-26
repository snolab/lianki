/**
 * Opens the manual test page in a browser for visual inspection
 */
import { chromium } from "playwright";

async function runManualTest() {
  console.log("🧪 Opening manual test page...\n");

  const browser = await chromium.launch({
    headless: false, // Keep browser open
    slowMo: 100,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  // Collect console logs
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[Lianki]") || text.includes("===")) {
      console.log("  📝", text);
    }
  });

  page.on("pageerror", (err) => {
    console.error("  ❌ Page Error:", err.message);
  });

  // Open the manual test page
  const testPageUrl = "http://localhost:3000/tests/manual-test.html";
  console.log(`Opening: ${testPageUrl}`);

  try {
    await page.goto(testPageUrl, { waitUntil: "networkidle" });
    console.log("✓ Test page loaded\n");

    console.log("Manual test page is open in browser.");
    console.log("Click the buttons to test offline-first functionality.");
    console.log("\nPress Ctrl+C to close browser and exit.\n");

    // Keep the browser open
    await new Promise(() => {}); // Never resolves
  } catch (error) {
    console.error("❌ Failed to load test page:", error.message);
    await browser.close();
    process.exit(1);
  }
}

runManualTest().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});

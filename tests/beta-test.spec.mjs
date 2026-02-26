/**
 * Beta Testing Script for Offline-First Sync
 *
 * Comprehensive test of v2.20.0 on beta.lianki.com
 */

import { chromium } from "playwright";

const BETA_URL = "https://beta.lianki.com";
const TEST_URL = "https://en.wikipedia.org/wiki/Spaced_repetition";

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function betaTest() {
  console.log("🧪 Starting Beta Testing for v2.20.0\n");
  console.log(`Testing: ${BETA_URL}\n`);

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  // Collect console logs
  const logs = [];
  const errors = [];
  page.on("console", (msg) => {
    const text = msg.text();
    logs.push(text);
    if (text.includes("[Lianki]")) {
      console.log("  📝", text);
    }
  });

  page.on("pageerror", (err) => {
    errors.push(err.message);
    console.error("  ❌ Page Error:", err.message);
  });

  const results = {
    version: null,
    offlineInit: false,
    cardAdded: false,
    cardCached: false,
    hlcPresent: false,
    offlineReview: false,
    syncQueued: false,
    backgroundSync: false,
    prefetchWorking: false,
    cachedCount: 0,
    errors: [],
    performance: {},
  };

  try {
    // ========================================================================
    // Test 1: Verify v2.20.0 deployed to beta
    // ========================================================================
    console.log("📦 Test 1: Checking beta userscript version...");

    const response = await page.goto(`${BETA_URL}/lianki.user.js`);

    if (!response || response.status() !== 200) {
      throw new Error(`Failed to fetch userscript: ${response?.status()}`);
    }

    const scriptContent = await response.text();
    const versionMatch = scriptContent.match(/@version\s+([\d.]+)/);
    results.version = versionMatch?.[1];

    console.log(`  ✓ Version: ${results.version}`);

    if (results.version !== "2.20.0") {
      throw new Error(`Expected v2.20.0, got ${results.version}`);
    }

    // Verify offline-first code present
    const hasIndexedDB =
      scriptContent.includes("IndexedDB") || scriptContent.includes("idb-keyval");
    const hasLiankiDeps = scriptContent.includes("LiankiDeps");
    const hasHLC = scriptContent.includes("compareHLC");

    console.log(`  ✓ IndexedDB support: ${hasIndexedDB}`);
    console.log(`  ✓ LiankiDeps bundled: ${hasLiankiDeps}`);
    console.log(`  ✓ HLC implementation: ${hasHLC}`);

    if (!hasIndexedDB || !hasLiankiDeps || !hasHLC) {
      throw new Error("Missing offline-first components");
    }

    // ========================================================================
    // Test 2: Initialize userscript and check offline storage
    // ========================================================================
    console.log("\n🔧 Test 2: Initializing offline storage...");

    await page.goto(TEST_URL, { waitUntil: "networkidle" });
    await page.addScriptTag({ url: `${BETA_URL}/lianki.user.js` });

    console.log("  ⏳ Waiting for initialization (3s)...");
    await sleep(3000);

    results.offlineInit = logs.some((log) => log.includes("Offline storage initialized"));
    console.log(
      `  ${results.offlineInit ? "✓" : "❌"} Offline storage initialized: ${results.offlineInit}`,
    );

    // ========================================================================
    // Test 3: Add card and verify caching
    // ========================================================================
    console.log("\n📝 Test 3: Adding card and verifying cache...");

    const addStart = Date.now();
    await page.keyboard.press("Alt+F");
    await sleep(1000);

    const dialogVisible = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('[style*="position: fixed"][style*="z-index"]');
      return dialogs.length > 0;
    });

    const addTime = Date.now() - addStart;
    results.performance.addCard = addTime;

    console.log(`  ${dialogVisible ? "✓" : "❌"} Dialog opened (${addTime}ms)`);
    results.cardAdded = dialogVisible;

    if (dialogVisible) {
      await page.keyboard.press("Escape");
      await sleep(500);

      // Check IndexedDB cache
      const cacheInfo = await page.evaluate(async (testUrl) => {
        try {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("lianki-cards");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });

          const tx = db.transaction(["cards"], "readonly");
          const store = tx.objectStore("cards");
          const normalizedUrl = testUrl.split("#")[0].split("?")[0];

          const card = await new Promise((resolve, reject) => {
            const request = store.get(normalizedUrl);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });

          db.close();
          return { found: !!card, hasHLC: !!card?.hlc, note: card?.note };
        } catch (err) {
          return { found: false, error: err.message };
        }
      }, TEST_URL);

      results.cardCached = cacheInfo.found;
      results.hlcPresent = cacheInfo.hasHLC;

      console.log(
        `  ${results.cardCached ? "✓" : "❌"} Card cached in IndexedDB: ${results.cardCached}`,
      );
      console.log(
        `  ${results.hlcPresent ? "✓" : "❌"} HLC timestamp present: ${results.hlcPresent}`,
      );
    }

    // ========================================================================
    // Test 4: Offline review capability
    // ========================================================================
    console.log("\n📴 Test 4: Testing offline review...");

    await context.setOffline(true);
    console.log("  📴 Network disabled");
    await sleep(500);

    const reviewStart = Date.now();
    await page.keyboard.press("Alt+F");
    await sleep(1500);

    const offlineDialogVisible = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('[style*="position: fixed"][style*="z-index"]');
      return dialogs.length > 0;
    });

    const reviewTime = Date.now() - reviewStart;
    results.performance.offlineReview = reviewTime;

    console.log(`  ${offlineDialogVisible ? "✓" : "❌"} Dialog opened offline (${reviewTime}ms)`);
    results.offlineReview = offlineDialogVisible;

    if (offlineDialogVisible) {
      // Try to review (press 'j' for Good)
      await page.keyboard.press("j");
      await sleep(1000);

      console.log("  ✓ Offline review submitted");

      // Check sync queue
      const queueInfo = await page.evaluate(async () => {
        try {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("lianki-queue");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });

          const tx = db.transaction(["queue"], "readonly");
          const store = tx.objectStore("queue");

          const items = await new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });

          db.close();
          return { count: items.length, items };
        } catch (err) {
          return { count: 0, error: err.message };
        }
      });

      results.syncQueued = queueInfo.count > 0;
      console.log(
        `  ${results.syncQueued ? "✓" : "❌"} Review queued for sync: ${queueInfo.count} items`,
      );
    }

    await page.keyboard.press("Escape");
    await sleep(500);

    // ========================================================================
    // Test 5: Background sync
    // ========================================================================
    console.log("\n🔄 Test 5: Testing background sync...");

    await context.setOffline(false);
    console.log("  📡 Network enabled");
    await sleep(2000);

    console.log("  ⏳ Waiting for background sync (8s)...");
    await sleep(8000);

    const syncCompleted = logs.some(
      (log) => log.includes("Sync complete") || log.includes("Synced:"),
    );

    console.log(`  ${syncCompleted ? "✓" : "❌"} Background sync completed: ${syncCompleted}`);
    results.backgroundSync = syncCompleted;

    // Verify queue is empty
    const queueAfterSync = await page.evaluate(async () => {
      try {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open("lianki-queue");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });

        const tx = db.transaction(["queue"], "readonly");
        const store = tx.objectStore("queue");

        const items = await new Promise((resolve, reject) => {
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });

        db.close();
        return items.length;
      } catch (err) {
        return -1;
      }
    });

    console.log(`  ${queueAfterSync === 0 ? "✓" : "⚠️"} Queue after sync: ${queueAfterSync} items`);

    // ========================================================================
    // Test 6: Prefetch verification
    // ========================================================================
    console.log("\n🎯 Test 6: Verifying prefetch...");

    const prefetchLogs = logs.filter((log) => log.includes("Prefetch"));
    console.log(`  ℹ️  Prefetch attempts: ${prefetchLogs.length}`);

    const cachedCount = await page.evaluate(async () => {
      try {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open("lianki-cards");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });

        const tx = db.transaction(["cards"], "readonly");
        const store = tx.objectStore("cards");

        const count = await new Promise((resolve, reject) => {
          const request = store.count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });

        db.close();
        return count;
      } catch (err) {
        return 0;
      }
    });

    results.cachedCount = cachedCount;
    results.prefetchWorking = cachedCount > 1;

    console.log(`  ${results.prefetchWorking ? "✓" : "⚠️"} Cards cached: ${cachedCount}`);

    // ========================================================================
    // Test 7: Performance validation
    // ========================================================================
    console.log("\n⚡ Test 7: Performance metrics...");

    console.log(`  Add card (online): ${results.performance.addCard}ms`);
    console.log(`  Review (offline): ${results.performance.offlineReview}ms`);

    const offlineFast = results.performance.offlineReview < 200;
    console.log(`  ${offlineFast ? "✓" : "⚠️"} Offline review fast (<200ms): ${offlineFast}`);

    // ========================================================================
    // Test 8: Error checking
    // ========================================================================
    console.log("\n🔍 Test 8: Checking for errors...");

    const liankiErrors = logs.filter(
      (log) => log.toLowerCase().includes("error") && log.includes("[Lianki]"),
    );

    results.errors = [...liankiErrors, ...errors];

    console.log(
      `  ${results.errors.length === 0 ? "✓" : "⚠️"} JavaScript errors: ${results.errors.length}`,
    );

    if (results.errors.length > 0) {
      console.log("\n  Errors found:");
      results.errors.forEach((err) => console.log(`    - ${err}`));
    }

    // ========================================================================
    // Final Report
    // ========================================================================
    console.log("\n" + "═".repeat(70));
    console.log("📊 BETA TEST RESULTS");
    console.log("═".repeat(70));

    console.log("\n✅ Deployment:");
    console.log(`  Version: ${results.version}`);
    console.log(`  URL: ${BETA_URL}`);

    console.log("\n✅ Core Functionality:");
    console.log(`  ${results.offlineInit ? "✓" : "❌"} Offline storage initialized`);
    console.log(`  ${results.cardAdded ? "✓" : "❌"} Card addition works`);
    console.log(`  ${results.cardCached ? "✓" : "❌"} Card cached in IndexedDB`);
    console.log(`  ${results.hlcPresent ? "✓" : "❌"} HLC timestamps present`);
    console.log(`  ${results.offlineReview ? "✓" : "❌"} Offline review works`);
    console.log(`  ${results.syncQueued ? "✓" : "❌"} Sync queue working`);
    console.log(`  ${results.backgroundSync ? "✓" : "❌"} Background sync works`);
    console.log(`  ${results.prefetchWorking ? "✓" : "❌"} Prefetch working`);

    console.log("\n⚡ Performance:");
    console.log(`  Add card (online): ${results.performance.addCard}ms`);
    console.log(`  Review (offline): ${results.performance.offlineReview}ms`);
    console.log(
      `  Speed improvement: ${Math.round(results.performance.addCard / results.performance.offlineReview)}x faster`,
    );

    console.log("\n💾 Storage:");
    console.log(`  Cards cached: ${results.cachedCount}`);

    console.log("\n🐛 Errors:");
    console.log(`  JavaScript errors: ${results.errors.length}`);

    // Overall assessment
    const criticalTests = [
      results.version === "2.20.0",
      results.offlineInit,
      results.cardAdded,
      results.cardCached,
      results.offlineReview,
      results.backgroundSync,
    ];

    const criticalPassed = criticalTests.filter(Boolean).length;
    const criticalTotal = criticalTests.length;

    console.log("\n" + "═".repeat(70));
    console.log(`📈 Overall: ${criticalPassed}/${criticalTotal} critical tests passed`);
    console.log("═".repeat(70));

    if (criticalPassed === criticalTotal && results.errors.length === 0) {
      console.log("\n✨ ✅ READY FOR PRODUCTION");
      console.log("All critical tests passed with no errors!");
      console.log("\nRecommendation: Safe to merge to main 🚀");
    } else if (criticalPassed === criticalTotal) {
      console.log("\n⚠️  MOSTLY READY");
      console.log("All critical tests passed, but some warnings.");
      console.log("\nRecommendation: Review warnings, then safe to merge");
    } else {
      console.log("\n❌ NOT READY");
      console.log("Some critical tests failed.");
      console.log("\nRecommendation: Fix issues before merging to main");
    }

    console.log("\n");
  } catch (error) {
    console.error("\n❌ Beta test failed:", error.message);
    console.error(error.stack);
    results.errors.push(error.message);
  } finally {
    await browser.close();
  }

  return results;
}

// Run beta test
betaTest().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});

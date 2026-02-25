/**
 * Build offline-first lianki.user.js
 *
 * This script assembles:
 * 1. Original lianki.user.js header
 * 2. LiankiDeps bundle (ts-fsrs + idb-keyval)
 * 3. Offline core (HLC, storage, sync)
 * 4. Original main() function
 * 5. Offline-first review integration (modifies openDialog/doReview)
 */

import { readFileSync, writeFileSync } from "fs";

const BACKUP = "public/lianki.user.js.backup";
const DEPS_BUNDLE = "public/lianki-deps.bundle.js";
const OFFLINE_CORE = "scripts/offline-core.js";
const OFFLINE_INTEGRATION = "scripts/offline-integration.js";
const OUTPUT = "public/lianki.user.js";

// Read files
const original = readFileSync(BACKUP, "utf-8");
const depsBundle = readFileSync(DEPS_BUNDLE, "utf-8");
const offlineCore = readFileSync(OFFLINE_CORE, "utf-8");
const offlineIntegration = readFileSync(OFFLINE_INTEGRATION, "utf-8");

// Parse version from original
const versionMatch = original.match(/\/\/ @version\s+(\d+\.\d+\.\d+)/);
if (!versionMatch) throw new Error("Could not find version in original");

const [major, minor, patch] = versionMatch[1].split(".").map(Number);
const newVersion = `${major}.${minor + 1}.0`; // Bump minor for offline feature

console.log(`Building offline-first userscript v${newVersion}...`);

// Find insertion points
const mainFnStart = original.indexOf("function main() {");
const mainFnEnd = original.indexOf("  return () =>", mainFnStart);

if (mainFnStart === -1) throw new Error("Could not find main() function");
if (mainFnEnd === -1) throw new Error("Could not find main() return statement");

// Split original into parts
const header = original.slice(0, mainFnStart);
const mainFunction = original.slice(mainFnStart, mainFnEnd);
const cleanupAndReturn = original.slice(mainFnEnd);

// Update version in header
const updatedHeader = header
  .replace(/\/\/ @version\s+\d+\.\d+\.\d+/, `// @version     ${newVersion}`)
  .replace(
    /\/\/ @description .+/,
    `// @description Lianki spaced repetition — offline-first with IndexedDB sync. Press , or . (or media keys) to control video speed with difficulty markers.`,
  );

// Wrap deps bundle to expose as global
const wrappedDeps = `
// ============================================================================
// Bundled Dependencies (ts-fsrs + idb-keyval) — 21KB
// ============================================================================
${depsBundle}
// Expose LiankiDeps globally
if (typeof window !== 'undefined') {
  window.LiankiDeps = Y0;
}
`;

// Prepare offline core (remove module.exports)
const cleanedOfflineCore = offlineCore.replace(
  /\/\/ Export for use in main userscript[\s\S]*$/,
  "",
);

// Assemble final userscript
const assembled = `${updatedHeader}
${wrappedDeps}
${cleanedOfflineCore}
${mainFunction}

  // ──────────────────────────────────────────────────────────────────────────
  // Offline-First Integration
  // ──────────────────────────────────────────────────────────────────────────
${offlineIntegration}

${cleanupAndReturn}`;

// Write output
writeFileSync(OUTPUT, assembled, "utf-8");

console.log(`✅ Built ${OUTPUT} (${assembled.length} bytes, v${newVersion})`);
console.log(`   Original: ${original.length} bytes`);
console.log(`   Deps bundle: ${depsBundle.length} bytes`);
console.log(`   Offline core: ${offlineCore.length} bytes`);
console.log(`   Integration: ${offlineIntegration.length} bytes`);
console.log(
  `   Total increase: +${assembled.length - original.length} bytes (+${Math.round(((assembled.length - original.length) / original.length) * 100)}%)`,
);

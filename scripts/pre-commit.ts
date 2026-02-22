#!/usr/bin/env bun
/**
 * Pre-commit hook script
 * Handles linting, type checking, and userscript syncing
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const REPO_ROOT = process.cwd();
const PUBLIC_DIR = join(REPO_ROOT, "public");
const PARDON_DIR = join(REPO_ROOT, "packages/pardon-could-you-say-it-again");

function exec(cmd: string, options = {}) {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf-8", ...options });
}

function log(msg: string) {
  console.log(msg);
}

function error(msg: string) {
  console.error(msg);
  process.exit(1);
}

// Run linting and type checking
log("Running linters and type checking...");
try {
  // Get list of staged files before formatting
  const stagedBeforeFormat = exec("git diff --cached --name-only")
    .trim()
    .split("\n")
    .filter(Boolean);

  exec("bun fix");
  exec("bun run typecheck");

  // Auto-stage formatting changes for files that were already staged
  const modifiedFiles = exec("git diff --name-only").trim().split("\n").filter(Boolean);
  const filesToRestage = modifiedFiles.filter((f) => stagedBeforeFormat.includes(f));

  if (filesToRestage.length > 0) {
    exec(`git add ${filesToRestage.join(" ")}`);
    log(`Auto-staged formatting changes: ${filesToRestage.join(", ")}`);
  }
} catch (err) {
  error("Linting or type checking failed");
}

// Check if lianki.user.js has staged changes
const stagedFiles = exec("git diff --cached --name-only").trim();
if (!stagedFiles.includes("public/lianki.user.js")) {
  log("No changes to lianki.user.js, skipping sync");
  process.exit(0);
}

// Get version from staged and HEAD
function getVersion(gitRef: string): string | null {
  try {
    const content = exec(`git show ${gitRef}`);
    const match = content.match(/@version\s+([0-9]+\.[0-9]+\.[0-9]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const stagedVersion = getVersion(":public/lianki.user.js");
const headVersion = getVersion("HEAD:public/lianki.user.js");

if (stagedVersion === headVersion && headVersion !== null) {
  error(
    `ERROR: lianki.user.js was changed but @version (${stagedVersion}) was not bumped. Update @version before committing.`,
  );
}

log(`Detected version change: ${headVersion} → ${stagedVersion}`);

// Sync lianki.meta.js
log("Syncing lianki.meta.js...");
const userScriptContent = exec("git show :public/lianki.user.js");
const metaContent = userScriptContent
  .split("\n")
  .reduce(
    (acc, line) => {
      if (line === "// ==UserScript==") {
        return { inMeta: true, lines: [line] };
      }
      if (line === "// ==/UserScript==") {
        return {
          inMeta: false,
          lines: [
            ...acc.lines,
            line,
            "",
            "// This is a metadata-only file for Tampermonkey/Violentmonkey update checks.",
            "// See lianki.user.js for the full implementation.",
            "",
            "void 0; // Meta file - no executable code needed",
          ],
        };
      }
      if (acc.inMeta) {
        return { ...acc, lines: [...acc.lines, line] };
      }
      return acc;
    },
    { inMeta: false, lines: [] as string[] },
  )
  .lines.join("\n");

writeFileSync(join(PUBLIC_DIR, "lianki.meta.js"), metaContent);
exec("git add public/lianki.meta.js");
log("✓ lianki.meta.js synced and staged");

// Sync to pardon submodule
if (!existsSync(PARDON_DIR)) {
  log(`⚠ Warning: pardon submodule not found at ${PARDON_DIR}`);
  process.exit(0);
}

log("Syncing lianki.user.js to pardon submodule...");
const liankiUserJs = exec("git show :public/lianki.user.js");
writeFileSync(join(PARDON_DIR, "lianki.user.js"), liankiUserJs);

// Check if there are changes in submodule
try {
  const submoduleDiff = exec(`git -C ${PARDON_DIR} diff lianki.user.js`).trim();
  if (submoduleDiff) {
    exec(`git -C ${PARDON_DIR} add lianki.user.js`);
    try {
      exec(`git -C ${PARDON_DIR} commit -m "sync: update lianki.user.js to v${stagedVersion}"`);
      log(`✓ lianki.user.js synced to pardon submodule (v${stagedVersion})`);
    } catch {
      // Ignore commit errors (might be nothing to commit)
      log(`✓ lianki.user.js copied to pardon submodule (v${stagedVersion})`);
    }
  } else {
    log("✓ lianki.user.js already up to date in pardon submodule");
  }
} catch (err) {
  // If git operations fail in submodule (e.g., during commit), just log and continue
  log(`⚠ Warning: Could not commit to submodule, but file was copied (v${stagedVersion})`);
}

// Stage the submodule update in main repo
exec(`git add ${PARDON_DIR}`);

log("\n✅ Pre-commit checks passed!");

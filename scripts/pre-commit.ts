#!/usr/bin/env bun
import { execSync } from "child_process";
import { writeFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const run = (cmd: string) => execSync(cmd, { encoding: "utf-8" });
const die = (msg: string) => {
  console.error(msg);
  process.exit(1);
};

// ── Secrets scan (secretlint) ─────────────────────────────────────────────────
const stagedFiles = run("git diff --cached --name-only --diff-filter=ACM")
  .trim()
  .split("\n")
  .filter((f) => f && !/\.(png|jpg|gif|ico|woff|ttf|lock|lockb)$/.test(f));
if (stagedFiles.length) {
  try {
    run(`bunx secretlint ${stagedFiles.map((f) => `"${f}"`).join(" ")}`);
  } catch {
    die("🚨 Secrets detected — remove them before committing");
  }
}
console.log("✓ No secrets");

// ── Lint + format, re-stage auto-fixed files ──────────────────────────────────
const stagedBeforeFix = run("git diff --cached --name-only").trim();
try {
  run("bun fix");
} catch {
  die("Lint/format failed");
}
for (const file of stagedBeforeFix.split("\n").filter(Boolean)) {
  if (existsSync(file) && run("git diff --name-only").includes(file)) {
    run(`git add "${file}"`);
    console.log(`Auto-staged: ${file}`);
  }
}

// ── Type check ────────────────────────────────────────────────────────────────
try {
  run("bun run typecheck");
} catch {
  die("Type check failed");
}

// ── Build ─────────────────────────────────────────────────────────────────────
try {
  run("bun run build");
} catch {
  die("Build failed");
}

// ── Unit tests ────────────────────────────────────────────────────────────────
try {
  run("bun run test:unit");
} catch {
  die("Unit tests failed");
}

// ── Sync lianki.user.js → lianki.meta.js + pardon submodule ──────────────────
const staged = run("git diff --cached --name-only").trim();
if (!staged.includes("public/lianki.user.js")) {
  console.log("✅ Pre-commit passed!");
  process.exit(0);
}

const getVersion = (ref: string) =>
  run(`git show ${ref}`).match(/@version\s+([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null;

const stagedVersion = getVersion(":public/lianki.user.js");
const headVersion = getVersion("HEAD:public/lianki.user.js");
if (stagedVersion === headVersion)
  die(`lianki.user.js changed but @version (${stagedVersion}) not bumped`);
console.log(`Version: ${headVersion} → ${stagedVersion}`);

const userScript = run("git show :public/lianki.user.js");
const metaLines: string[] = [];
let inMeta = false;
for (const line of userScript.split("\n")) {
  if (line === "// ==UserScript==") {
    inMeta = true;
    metaLines.push(line);
    continue;
  }
  if (line === "// ==/UserScript==") {
    metaLines.push(
      line,
      "",
      "// Metadata-only file for Tampermonkey/Violentmonkey update checks.",
      "void 0;",
    );
    inMeta = false;
    continue;
  }
  if (inMeta) metaLines.push(line);
}
writeFileSync(join(ROOT, "public/lianki.meta.js"), metaLines.join("\n"));
run("git add public/lianki.meta.js");
console.log("✓ lianki.meta.js synced");

const PARDON = join(ROOT, "packages/pardon-could-you-say-it-again");
if (existsSync(PARDON)) {
  writeFileSync(join(PARDON, "lianki.user.js"), userScript);
  try {
    if (run(`git -C ${PARDON} diff lianki.user.js`).trim()) {
      run(`git -C ${PARDON} add lianki.user.js`);
      run(`git -C ${PARDON} commit -m "sync: lianki.user.js v${stagedVersion}"`);
    }
  } catch {
    /* ignore submodule commit errors */
  }
  run(`git add ${PARDON}`);
  console.log(`✓ pardon submodule synced`);
}

console.log("✅ Pre-commit passed!");

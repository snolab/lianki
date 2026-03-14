#!/usr/bin/env bun
import { execSync } from "child_process";
import { writeFileSync, existsSync } from "fs";
import { join } from "path";

const run = (cmd: string) => execSync(cmd, { encoding: "utf-8" });
const DIE = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

// Only runs when lianki.user.js is staged
const staged = run("git diff --cached --name-only").trim();
if (!staged.includes("public/lianki.user.js")) process.exit(0);

const getVersion = (ref: string) =>
  run(`git show ${ref}`).match(/@version\s+([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null;

const stagedVersion = getVersion(":public/lianki.user.js");
const headVersion = getVersion("HEAD:public/lianki.user.js");
if (stagedVersion === headVersion)
  DIE(`lianki.user.js changed but @version (${stagedVersion}) not bumped`);
console.log(`Version: ${headVersion} → ${stagedVersion}`);

const userScript = run("git show :public/lianki.user.js");
const metaBlock = userScript.match(/(\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==)/)?.[1] ?? "";
writeFileSync(
  "public/lianki.meta.js",
  `${metaBlock}\n\n// Metadata-only file for Tampermonkey/Violentmonkey update checks.\nvoid 0;\n`,
);
run("git add public/lianki.meta.js");
console.log("✓ lianki.meta.js synced");

const PARDON = join(process.cwd(), "packages/pardon-could-you-say-it-again");
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
  console.log("✓ pardon submodule synced");
}

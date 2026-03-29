#!/usr/bin/env bun
import { execSync } from "child_process";
import { writeFileSync, existsSync } from "fs";
import { join } from "path";

const run = (cmd: string) => execSync(cmd, { encoding: "utf-8" });
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const staged = () => run("git diff --cached --name-only").trim();

// Build userscript from TS source if staged
if (staged().includes("src/lianki.user.ts")) {
  execSync("bun run build:userscript", { stdio: "inherit" });
  execSync("oxfmt public/lianki.user.js", { stdio: "inherit" });
  run("git add public/lianki.user.js");
}
if (!staged().includes("public/lianki.user.js")) process.exit(0);

// Version bump check
const ver = (ref: string) => run(`git show ${ref}`).match(/@version\s+([\d.]+)/)?.[1] ?? null;
const [sv, hv] = [ver(":public/lianki.user.js"), ver("HEAD:public/lianki.user.js")];
if (sv === hv) die(`lianki.user.js changed but @version (${sv}) not bumped`);
console.log(`Version: ${hv} → ${sv}`);

// Sync meta.js
const userScript = run("git show :public/lianki.user.js");
const metaBlock = userScript.match(/(\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==)/)?.[1] ?? "";
writeFileSync(
  "public/lianki.meta.js",
  `${metaBlock}\n\n// Metadata-only file for Tampermonkey/Violentmonkey update checks.\nvoid 0;\n`,
);
run("git add public/lianki.meta.js");

// Sync pardon submodule
const PARDON = join(process.cwd(), "packages/pardon-could-you-say-it-again");
if (existsSync(PARDON)) {
  writeFileSync(join(PARDON, "lianki.user.js"), userScript);
  try {
    if (run(`git -C ${PARDON} diff lianki.user.js`).trim()) {
      run(`git -C ${PARDON} add lianki.user.js`);
      run(`git -C ${PARDON} commit -m "sync: lianki.user.js v${sv}"`);
    }
  } catch {}
  run(`git add ${PARDON}`);
}

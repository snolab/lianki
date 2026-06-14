#!/usr/bin/env node
/**
 * qa:all — local "test everything" against the **deployed D1/Workers path**.
 *
 * Builds the OpenNext Worker, applies the D1 migrations to the local
 * (Miniflare-backed) D1 database, boots `wrangler dev` on :3000, then runs the
 * four integration layers against that live Worker and tears it down:
 *
 *   1. API        — scripts/qa/qa-api.mjs        (authed FSRS/roadmap/prefs/...)
 *   2. UI         — scripts/qa/qa-ui.mjs         (Playwright sign-in → dashboard)
 *   3. SYNC       — tests/db-sync-matrix.spec.ts (GM storage ↔ IndexedDB ↔ API)
 *   4. USERSCRIPT — tests/userscript-guest.spec.ts
 *
 * This exercises the *real* backend we ship (better-auth + app data both on D1),
 * so no MongoDB is involved on this path.
 *
 *   bun run qa:all              # full: build + migrate + serve + 4 suites
 *   bun run qa:all -- --no-build   # reuse the last .open-next build (fast iterate)
 *   bun run qa:all -- --keep       # leave wrangler dev running after the suites
 *
 * Exits non-zero if any suite fails. Designed to be the pre-push gate and the
 * single command CI calls.
 *
 * Prereqs: a Cloudflare-capable wrangler (devDependency), Playwright chromium
 * (`bunx playwright install chromium`), and Node ≥ 22.12 (older Node mis-handles
 * node:sqlite null rows — see the test-stack notes).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.QA_PORT || 3000);
const BASE = `http://localhost:${PORT}`;
const flags = new Set(process.argv.slice(2));
const NO_BUILD = flags.has("--no-build");
const KEEP = flags.has("--keep");

const log = (s) => console.log(`\n\x1b[36m▶ ${s}\x1b[0m`);
const err = (s) => console.error(`\x1b[31m✗ ${s}\x1b[0m`);

// ── .dev.vars: wrangler dev reads this for local Worker vars/secrets ──────────
// The OpenNext build is a *production* Next build, so process.env.NODE_ENV is
// "production" at runtime — which would disable the dev email+password gate in
// auth.ts. We set NODE_ENV=development here so the QA flow can sign in without
// OAuth/SMTP. These are local-only (.dev.vars is gitignored); the deployed
// Worker never sees them, so production stays passwordless and safe.
if (!existsSync(".dev.vars")) {
  writeFileSync(
    ".dev.vars",
    [
      "# Auto-created by qa:all — local-only dev secrets for `wrangler dev`.",
      "NODE_ENV=development",
      "DB_BACKEND=d1",
      "DEV_EMAIL_PASSWORD_AUTH=1",
      "AUTH_SECRET=dev-qa-secret-not-for-production",
      `BETTER_AUTH_BASE_URL=${BASE}`,
      "",
    ].join("\n"),
  );
  log(".dev.vars created (local-only QA secrets)");
}

function step(name, cmd, args, env = {}) {
  log(`${name}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${name} failed (exit ${r.status ?? r.signal})`);
}

// ── 1. Build the OpenNext Worker (mirrors the deployed build) ─────────────────
if (!NO_BUILD) {
  step("OpenNext build (CF_BUILD=1 DB_BACKEND=d1)", "bunx", ["opennextjs-cloudflare", "build"], {
    CF_BUILD: "1",
    DB_BACKEND: "d1",
  });
} else if (!existsSync(".open-next/worker.js")) {
  throw new Error(
    "--no-build given but .open-next/worker.js is missing — run once without --no-build first",
  );
}

// ── 2. Apply D1 migrations to the local Miniflare database ────────────────────
// `--local` targets the same .wrangler/state DB that `wrangler dev` serves.
step("D1 migrate (local)", "bunx", ["wrangler", "d1", "migrations", "apply", "lianki", "--local"]);

// ── 3. Boot `wrangler dev` on :PORT (port 3000 matches auth.ts trustedOrigins) ─
log(`wrangler dev on :${PORT}`);
const server = spawn("bunx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, DB_BACKEND: "d1" },
});

let stopped = false;
const stopServer = () => {
  if (stopped) return;
  stopped = true;
  try {
    server.kill("SIGTERM");
  } catch {}
};
process.on("exit", () => {
  if (!KEEP) stopServer();
});
process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});
server.on("exit", (code) => {
  if (!stopped) err(`wrangler dev exited early (code ${code})`);
});

// ── 4. Wait for the Worker to answer ─────────────────────────────────────────
async function waitReady(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error("wrangler dev exited before becoming ready");
    try {
      const r = await fetch(`${BASE}/`, { redirect: "manual" });
      if (r.status > 0) return;
    } catch {}
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`server not ready on ${BASE} within ${timeoutMs}ms`);
}
await waitReady();
log("server ready");

// ── 5. Run every suite; keep going on failure, report at the end ──────────────
const suites = [
  ["API  (qa-api)", "node", ["scripts/qa/qa-api.mjs"], { QA_BASE: BASE }],
  ["UI   (qa-ui)", "node", ["scripts/qa/qa-ui.mjs"], { QA_BASE: BASE }],
  [
    "SYNC (db-sync-matrix)",
    "bunx",
    ["playwright", "test", "tests/db-sync-matrix.spec.ts"],
    { LIANKI_URL: BASE },
  ],
  [
    "USERSCRIPT (guest)",
    "bunx",
    ["playwright", "test", "tests/userscript-guest.spec.ts"],
    { LIANKI_URL: BASE },
  ],
];

const results = [];
for (const [name, cmd, args, env] of suites) {
  log(`SUITE — ${name}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  results.push([name, r.status === 0]);
}

// ── 6. Teardown + summary ─────────────────────────────────────────────────────
if (!KEEP) stopServer();
console.log("\n=== qa:all summary ===");
for (const [name, ok] of results) console.log(`  ${ok ? "✓" : "✗"} ${name}`);

const failed = results.filter(([, ok]) => !ok);
if (failed.length) {
  err(`${failed.length}/${results.length} suites failed`);
  process.exit(1);
}
console.log(`\n\x1b[32m✓ all ${results.length} suites passed\x1b[0m`);
process.exit(0);

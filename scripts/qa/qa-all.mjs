#!/usr/bin/env node
/**
 * qa:all — local "test everything" against the **deployed D1/Workers path**.
 *
 * Builds the OpenNext Worker, applies the D1 migrations to the local
 * (Miniflare-backed) D1 database, boots `wrangler dev` on a free port, then runs the
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

/**
 * Ask the OS for a free port.
 *
 * Ephemeral by DEFAULT, not merely overridable. This gate used to pin :3000, so
 * two agents (or two shells) on one host could not gate a push at the same
 * time: the second `wrangler dev` lost the bind, and the suites failed with
 * ERR_CONNECTION_REFUSED — which reads as a flaky test, not as contention. It
 * cost three pushes and two wrong-cause investigations before that was spotted.
 *
 * Nothing depends on the number any more: BETTER_AUTH_BASE_URL is derived from
 * it and lib/trusted-origins.ts accepts any localhost origin.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    // Port 0 = let the kernel choose. There is a small window between closing
    // this listener and wrangler binding, but the kernel does not hand out the
    // same ephemeral port twice in quick succession, so it is not worth holding
    // the socket open and passing an fd around.
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// QA_PORT still pins it, for when you want a predictable URL to poke at.
const PORT = Number(process.env.QA_PORT) || (await freePort());
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
} else {
  // The port changes every run now, and wrangler dev reads the base URL from
  // here — a stale value means better-auth trusts a port nothing is listening
  // on and rejects every write, which is the same failure the fixed port
  // caused. Rewrite ONLY this line: the file is gitignored and unrecoverable,
  // and may hold secrets nothing else knows.
  const prev = readFileSync(".dev.vars", "utf8");
  const line = `BETTER_AUTH_BASE_URL=${BASE}`;
  const next = /^BETTER_AUTH_BASE_URL=.*$/m.test(prev)
    ? prev.replace(/^BETTER_AUTH_BASE_URL=.*$/m, line)
    : `${prev.replace(/\n*$/, "\n")}${line}\n`;
  if (next !== prev) writeFileSync(".dev.vars", next);
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

// ── 3. Boot `wrangler dev` on :PORT (ephemeral by default; auth.ts trusts any
//       localhost origin via BETTER_AUTH_BASE_URL — see lib/trusted-origins.ts) ─
log(`wrangler dev on :${PORT}`);
let stopped = false;
const server = spawn("bunx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
  stdio: ["ignore", "inherit", "pipe"],
  env: { ...process.env, DB_BACKEND: "d1" },
});

// Forward wrangler's stderr, but once we've asked it to stop, drop the workerd
// shutdown noise (broken pipe / connection reset on SIGTERM) so a clean run
// doesn't end in a wall of scary-looking-but-harmless errors.
const TEARDOWN_NOISE =
  /Broken pipe|Connection reset|Network connection lost|getCaughtExceptionAsKj/;
server.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  if (stopped && TEARDOWN_NOISE.test(text)) return;
  process.stderr.write(text);
});

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
  [
    "USERSCRIPT (redirect)",
    "bunx",
    ["playwright", "test", "tests/userscript-redirect.spec.ts"],
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

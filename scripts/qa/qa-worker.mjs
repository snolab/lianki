#!/usr/bin/env node
/**
 * Phase 4 QA: compare a deployed Worker against a known-good baseline.
 *
 * Written because the Workers cutover's first real defect was *silent*: the
 * blog returned 200 with the page shell and no content, because `fs` reads
 * return empty on a runtime with no filesystem. Nothing about the status code,
 * and nothing runnable locally, would have shown it — a local dev server has a
 * filesystem, so the bug only exists in the deployed artifact.
 *
 * So the check is differential rather than absolute: same route, two origins,
 * and a body materially smaller on the Worker is treated as a failure even when
 * both return 200.
 *
 *   bun scripts/qa/qa-worker.mjs https://lianki.snomiao.workers.dev
 *   bun scripts/qa/qa-worker.mjs <worker> --baseline https://lianki.com
 *
 * Exits non-zero if any check fails, so it can gate a cutover.
 */

const args = process.argv.slice(2);
const WORKER = (args.find((a) => a.startsWith("http")) ?? "").replace(/\/+$/, "");
const bi = args.indexOf("--baseline");
const BASELINE = (bi === -1 ? "https://lianki.com" : args[bi + 1]).replace(/\/+$/, "");
const TIMEOUT_MS = 30_000;

if (!WORKER) {
  console.error("usage: bun scripts/qa/qa-worker.mjs <worker-url> [--baseline <url>]");
  process.exit(2);
}

/** Below this fraction of the baseline body, a 200 is considered hollow. */
const SIZE_FLOOR = 0.6;

const PAGES = [
  "/list",
  "/sign-in",
  "/ai-vocab",
  "/ai-vocab/zh?lang=ja",
  "/en/blog",
  "/data",
  "/read",
  "/self-intro",
];

/** Served from the build output; any drift here means the asset pipeline broke. */
const EXACT = ["/lianki.user.js", "/lianki.meta.js"];

/** Reachability only — 401 is a pass: it proves the handler ran and hit auth. */
const APIS = [
  { path: "/api/auth/get-session", ok: [200] },
  { path: "/api/fsrs/due", ok: [401, 200] },
  { path: "/api/fsrs/next-url", ok: [401, 200] },
];

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "manual" });
    const body = await res.text();
    return { status: res.status, body, size: body.length };
  } catch (err) {
    return { status: 0, body: "", size: 0, err: String(err?.message ?? err) };
  } finally {
    clearTimeout(t);
  }
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log(`worker:   ${WORKER}`);
console.log(`baseline: ${BASELINE}\n`);

console.log("pages (differential — a hollow 200 fails):");
for (const p of PAGES) {
  const [w, v] = await Promise.all([get(WORKER + p), get(BASELINE + p)]);
  if (w.status !== v.status) {
    record(p, false, `status ${w.status} vs baseline ${v.status}`);
    continue;
  }
  if (v.size > 0 && w.size < v.size * SIZE_FLOOR) {
    const pct = Math.round((w.size / v.size) * 100);
    record(
      p,
      false,
      `body is ${pct}% of baseline (${w.size} vs ${v.size} bytes) — likely rendering empty`,
    );
    continue;
  }
  record(p, true, `${w.status}, ${w.size}b`);
}

console.log("\nassets (must be byte-identical):");
for (const p of EXACT) {
  const [w, v] = await Promise.all([get(WORKER + p), get(BASELINE + p)]);
  const same = w.size === v.size && w.body === v.body;
  record(p, same, same ? `${w.size}b` : `${w.size}b vs ${v.size}b`);
}

console.log("\napi reachability (401 passes — the handler ran):");
for (const { path, ok } of APIS) {
  const w = await get(WORKER + path);
  record(path, ok.includes(w.status), `http ${w.status}${w.err ? ` (${w.err})` : ""}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  ${f.name} — ${f.detail}`);
  process.exit(1);
}
console.log("worker matches baseline");

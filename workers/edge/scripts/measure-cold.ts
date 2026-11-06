#!/usr/bin/env bun
/**
 * Cold time to first byte on Cloudflare, on the bindings-free deployment
 * (wrangler.cold.jsonc). A deploy replaces the isolates, so each sample uploads a
 * new version, waits for it to be served, and takes the first answer it gets;
 * x-spike-isolate-requests: 1 proves that answer came from a new isolate.
 *
 *   SPIKE_CONFIG=./wrangler.cold.jsonc bunx --bun vite build
 *   CLOUDFLARE_ACCOUNT_ID=… bun scripts/measure-cold.ts [samples per kind]
 *
 * Kinds: `guest` never loads better-auth. `cookie` sends a forged session cookie,
 * so it loads better-auth, builds it and runs up to its first D1 query, where it
 * answers 500: no D1 is bound. So this is the code's cold cost without D1's time.
 *
 * COLD_CONFIG and COLD_NAME measure another Worker the same way. That is the
 * control in docs/framework-migration.md: the OpenNext bundle, also with no
 * bindings. It sends no x-spike-* headers, so its isolates cannot be verified.
 */
import { spawnSync } from "node:child_process";
import { EDGE_DIR } from "./local";

const samples = Number(process.argv[2] ?? 6);
const CONFIG = process.env.COLD_CONFIG ?? "dist/lianki_edge_spike/wrangler.json";
const NAME = process.env.COLD_NAME ?? "lianki-edge-spike";
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
let url = "";

function deploy(sample: string) {
  const r = spawnSync(
    "bunx",
    ["wrangler", "deploy", "-c", CONFIG, "--var", `SPIKE_SAMPLE:${sample}`],
    {
      cwd: EDGE_DIR,
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(`deploy refused: ${r.stdout}\n${r.stderr}`);
  url = r.stdout.match(new RegExp(`https://${NAME}\\.[^\\s]+`))?.[0] ?? url;
  return Number(r.stdout.match(/Worker Startup Time: (\d+) ms/)?.[1] ?? NaN);
}

/** curl with a new connection each time: seconds to TLS done and to first byte. */
function curl(extra: string[] = []) {
  const r = spawnSync(
    "curl",
    [
      "-s",
      "-o",
      "/dev/null",
      "-D",
      "-",
      "-m",
      "30",
      "-w",
      "\ntiming %{http_code} %{time_appconnect} %{time_starttransfer}\n",
      ...extra,
      `${url}/api/preferences`,
    ],
    { encoding: "utf8" },
  );
  const [, status, tls, ttfb] = r.stdout.match(/timing (\d+) ([\d.]+) ([\d.]+)/) ?? [];
  const header = (name: string) =>
    r.stdout.match(new RegExp(`^${name}: (.*?)\\r?$`, "mi"))?.[1] ?? "";
  return {
    status: Number(status),
    tlsMs: Number(tls) * 1000,
    ttfbMs: Number(ttfb) * 1000,
    sample: header("x-spike-sample"),
    isolateRequests: Number(header("x-spike-isolate-requests")),
  };
}

const FORGED = ["-H", "cookie: better-auth.session_token=forged.AAAA"];
const kinds: Record<string, string[]> = { guest: [], cookie: FORGED };
const out: Record<string, { cold: number[]; tls: number[]; warm: number[]; startup: number[] }> =
  {};
let n = Date.now();

for (let round = 0; round < samples; round++) {
  for (const [kind, extra] of Object.entries(kinds)) {
    const stats = (out[kind] ??= { cold: [], tls: [], warm: [], startup: [] });
    const sample = String(++n);
    stats.startup.push(deploy(sample));
    // The first answer of the new version is the sample, so the version is
    // waited for by time, not by asking it.
    await new Promise((r) => setTimeout(r, 20_000));
    const first = curl(extra);
    const verifiable = first.sample !== "";
    const isNew = !verifiable || (first.sample === sample && first.isolateRequests === 1);
    // Requests can land on another new isolate at any time: "warm" takes only the
    // ones that prove they did not, where the Worker can say.
    const later = Array.from({ length: 10 }, () => curl(extra));
    const warm = later.filter((r) => !verifiable || r.isolateRequests > 1).map((r) => r.ttfbMs);
    if (!warm.length) warm.push(NaN);
    console.log(
      `${kind} ${first.status} ttfb ${Math.round(first.ttfbMs)} ms, tls ${Math.round(first.tlsMs)} ms, warm ${Math.round(median(warm))} ms (${warm.length}/10), new isolate: ${verifiable ? isNew : "unverified"}`,
    );
    if (!isNew) continue;
    stats.cold.push(first.ttfbMs);
    stats.tls.push(first.tlsMs);
    stats.warm.push(median(warm));
  }
}

for (const [kind, s] of Object.entries(out)) {
  const list = (xs: number[]) => xs.map((x) => Math.round(x)).join(", ");
  console.log(`\n${kind}: ${s.cold.length} cold samples
  first byte, new isolate: median ${Math.round(median(s.cold))} ms (${list(s.cold)})
  of that, TLS done at:    median ${Math.round(median(s.tls))} ms (${list(s.tls)})
  warm, same conditions:   median ${Math.round(median(s.warm))} ms (${list(s.warm)})
  wrangler's startup time: ${list(s.startup)} ms`);
}
process.exit(0);

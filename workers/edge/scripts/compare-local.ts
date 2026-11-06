#!/usr/bin/env bun
/**
 * The differential check of docs/framework-migration.md, section 7: GET
 * /api/preferences on the Hono port against the Next route, on two local Workers
 * sharing one local D1 and one AUTH_SECRET. Every session is made by the main
 * Worker, so a pass also proves a Next session is valid on the new Worker.
 * Then scripts/qa/qa-worker.mjs runs with the edge in front of the main Worker
 * as baseline, which tests MAIN.
 *
 *   CF_BUILD=1 DB_BACKEND=d1 bunx opennextjs-cloudflare build   # at the repo root, once
 *   bun scripts/compare-local.ts              # against `vite dev`
 *   bun scripts/compare-local.ts --preview    # against the production build (vite build first)
 */
import { spawnSync } from "node:child_process";
import { ROOT, freePort, ready, stage, startEdge, startMain } from "./local";

const mode = process.argv.includes("--preview") ? "preview" : "dev";
const mainPort = await freePort();
const edgePort = await freePort();
const MAIN = `http://localhost:${mainPort}`;
const EDGE = `http://localhost:${edgePort}`;

const s = stage();
s.devVars(MAIN);
startMain(s, mainPort);
await ready(MAIN);
startEdge(s, edgePort, mode);
await ready(EDGE);
console.log(`main ${MAIN} (OpenNext), edge ${EDGE} (vite ${mode})\n`);

async function signUp(name: string) {
  const res = await fetch(`${MAIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: MAIN },
    body: JSON.stringify({
      email: `edge-${name}-${Date.now()}@lianki.test`,
      password: "qa-test-pass-1234",
      name,
    }),
  });
  if (res.status !== 200) throw new Error(`sign-up: ${res.status} ${await res.text()}`);
  const { user } = (await res.json()) as { user: { id: string } };
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { id: user.id, cookie };
}

/** Headers either server may send with no contract behind them. */
const TRANSPORT = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);
const headersOf = (res: Response) =>
  Object.fromEntries([...res.headers].filter(([k]) => !TRANSPORT.has(k)).sort());

/**
 * Set-Cookie by meaning: attribute order and SameSite's case differ between
 * Next's cookies() and better-auth's own serializer, and Next adds Expires,
 * which Max-Age overrides in every browser. `maskValue` for per-user tokens.
 */
const cookiesOf = (res: Response, maskValue = false) =>
  res.headers
    .getSetCookie()
    .map((line) => {
      const [pair, ...attrs] = line.split(/;\s*/);
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      return [
        `${name}=${maskValue && value ? "<token>" : value}`,
        ...attrs
          .map((a) => a.toLowerCase())
          .filter((a) => !a.startsWith("expires="))
          .sort(),
      ].join("; ");
    })
    .sort()
    .join(" | ");

let failed = 0;
const headerNotes = new Map<string, string>();

async function same(name: string, path: string, init: RequestInit = {}) {
  const fetchFrom = async (origin: string) => {
    const res = await fetch(origin + path, { redirect: "manual", ...init });
    const headers = headersOf(res);
    return { status: res.status, body: await res.text(), headers, cookies: cookiesOf(res) };
  };
  const [next, edge] = [await fetchFrom(MAIN), await fetchFrom(EDGE)];
  const ok =
    next.status === edge.status && next.body === edge.body && next.cookies === edge.cookies;
  if (!ok) failed++;
  console.log(
    `${ok ? "✓" : "✗"} ${name}: ${next.status} ${next.body.slice(0, 100)} ${next.cookies}`,
  );
  if (!ok) console.log(`    edge: ${edge.status} ${edge.body.slice(0, 200)} ${edge.cookies}`);
  for (const k of new Set([...Object.keys(next.headers), ...Object.keys(edge.headers)])) {
    if (k !== "set-cookie" && next.headers[k] !== edge.headers[k]) {
      headerNotes.set(
        k,
        `next ${next.headers[k] ?? "(none)"} | edge ${edge.headers[k] ?? "(none)"}`,
      );
    }
  }
}

const A = await signUp("a");
const B = await signUp("b");
const as = (cookie: string) => ({ headers: { cookie } });

await same("guest", "/api/preferences");
await same("guest, HEAD", "/api/preferences", { method: "HEAD" });
await same("guest, query string", "/api/preferences?x=1");
await same("guest, trailing slash", "/api/preferences/");
await same("forged cookie", "/api/preferences", as("better-auth.session_token=forged.AAAA"));
await same("signed in, no preferences row", "/api/preferences", as(A.cookie));

// A write through the edge falls through to the Next POST, on the one D1.
const saved = await fetch(`${EDGE}/api/preferences`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: MAIN, cookie: A.cookie },
  body: JSON.stringify({
    mobileExcludePatterns: [
      {
        id: "1",
        type: "domain",
        pattern: "例え.example.com",
        isRegex: false,
        enabled: true,
        createdAt: "2026-11-05T00:00:00.000Z",
      },
    ],
    reviewOrder: "oldest",
    watchTracking: false,
  }),
});
console.log(
  `${saved.status === 200 ? "✓" : "✗"} POST through the edge reached Next: ${saved.status}`,
);
if (saved.status !== 200) failed++;
await same("signed in, saved preferences", "/api/preferences", as(A.cookie));
await same("another user sees only their own", "/api/preferences", as(B.cookie));

s.sql(`UPDATE preferences SET mobile_exclude_patterns='{bad' WHERE user_id='${A.id}'`);
await same("corrupt row, 500 with the parse error", "/api/preferences", as(A.cookie));

/**
 * For states one request changes (an expired session is deleted, a refresh
 * rolls the row): one new user per origin, set up the same way. Tokens differ
 * between them, so Set-Cookie is compared with the value masked.
 */
async function sameFresh(name: string, setup: (userId: string) => string) {
  const answer = async (origin: string) => {
    const user = await signUp(`fresh-${origin.slice(-5)}`);
    s.sql(setup(user.id));
    const res = await fetch(`${origin}/api/preferences`, as(user.cookie));
    return [res.status, await res.text(), cookiesOf(res, true)].join(" ");
  };
  const [next, edge] = [await answer(MAIN), await answer(EDGE)];
  if (next !== edge) failed++;
  console.log(`${next === edge ? "✓" : "✗"} ${name}: ${next}`);
  if (next !== edge) console.log(`    edge: ${edge}`);
}

await sameFresh(
  "expired session",
  (id) => `UPDATE session SET expiresAt='2020-01-01T00:00:00.000Z' WHERE userId='${id}'`,
);
const refreshDue = new Date(Date.now() + 2 * 86_400_000).toISOString();
await sameFresh(
  "session due for a refresh rolls the cookie",
  (id) => `UPDATE session SET expiresAt='${refreshDue}' WHERE userId='${id}'`,
);

console.log("\nheaders that differ on those requests (not in the pass or fail):");
for (const [k, v] of headerNotes) console.log(`  ${k}: ${v}`);

console.log("\nqa-worker.mjs, edge in front of main (the fallback through MAIN):");
const qa = spawnSync("bun", ["scripts/qa/qa-worker.mjs", EDGE, "--baseline", MAIN], {
  cwd: ROOT,
  stdio: "inherit",
});
if (qa.status !== 0) failed++;

s.cleanup();
console.log(failed ? `\n${failed} failed` : "\nall matched");
process.exit(failed ? 1 : 0);

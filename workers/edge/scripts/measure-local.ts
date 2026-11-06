#!/usr/bin/env bun
/**
 * The local numbers of docs/framework-migration.md, section 8. On this machine,
 * in local workerd, so they compare the two Workers with each other and say
 * nothing absolute about Cloudflare.
 *
 *   bun scripts/measure-local.ts [rounds]    # after `vite build` and an OpenNext build
 *
 * For each round: start the Worker fresh and time (a) spawn to the first answer
 * to a guest, then (b) the first signed-in request, which is what loads
 * better-auth, then (c) the median of 20 signed-in requests after it.
 */
import { freePort, ready, stage, start, startEdge, startMain, stop, EDGE_DIR } from "./local";
import { join } from "node:path";
import { rmSync } from "node:fs";

const rounds = Number(process.argv[2] ?? 5);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const fmt = (xs: number[]) =>
  `median ${Math.round(median(xs))} ms (${xs.map((x) => Math.round(x)).join(", ")})`;

async function timed(url: string, cookie?: string) {
  const t = performance.now();
  const res = await fetch(url, cookie ? { headers: { cookie } } : {});
  const ms = performance.now() - t;
  await res.arrayBuffer();
  if (res.status !== 200) throw new Error(`${url}: ${res.status}`);
  return ms;
}

const s = stage();
const mainPort = await freePort();
const edgePort = await freePort();
const MAIN = `http://localhost:${mainPort}`;
const EDGE = `http://localhost:${edgePort}`;
s.devVars(MAIN);

// One session, made once on the main Worker, for both.
const first = startMain(s, mainPort);
await ready(MAIN);
const signUp = await fetch(`${MAIN}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: MAIN },
  body: JSON.stringify({
    email: `measure-${Date.now()}@lianki.test`,
    password: "qa-test-pass-1234",
    name: "m",
  }),
});
const cookie = signUp.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");
stop(first);
await new Promise((r) => setTimeout(r, 1000));

async function round(name: string, origin: string, launch: () => ReturnType<typeof start>) {
  const toGuest: number[] = [];
  const toSession: number[] = [];
  const warm: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const from = performance.now();
    const child = launch();
    toGuest.push(await ready(origin, "/api/preferences", from));
    toSession.push(await timed(`${origin}/api/preferences`, cookie));
    const samples = [];
    for (let n = 0; n < 20; n++) samples.push(await timed(`${origin}/api/preferences`, cookie));
    warm.push(median(samples));
    stop(child);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`${name}
  spawn to first guest answer: ${fmt(toGuest)}
  first signed-in request:     ${fmt(toSession)}
  warm signed-in request:      ${fmt(warm)}`);
}

// Same runner for both production builds: wrangler dev.
const bundle = join(EDGE_DIR, "dist/lianki_edge/wrangler.json");
const wranglerDev = (config: string, port: number) =>
  start(
    "bunx",
    [
      "wrangler",
      "dev",
      "--local",
      "--port",
      `${port}`,
      "--persist-to",
      s.env.EDGE_PERSIST,
      "-c",
      config,
    ],
    EDGE_DIR,
    s.env,
  );

await round("lianki-edge, production build, wrangler dev", EDGE, () =>
  wranglerDev(bundle, edgePort),
);
await round("lianki, OpenNext production build, wrangler dev", MAIN, () => startMain(s, mainPort));

// The dev servers. Vite for real (session and all); `next dev` for a guest only,
// on its own local D1. CF_BUILD=1 stubs the mongodb driver as the Worker build
// does: unstubbed, the route answers 500 here with `node` linked to Bun.
await round("lianki-edge, vite dev", EDGE, () => startEdge(s, edgePort, "dev"));

const nextDev: number[] = [];
const nextPort = await freePort();
const root = join(EDGE_DIR, "../..");
for (let i = 0; i < rounds; i++) {
  // A first start has no Turbopack cache; later ones keep it, like a developer's.
  if (i === 0) rmSync(join(root, ".next/dev"), { recursive: true, force: true });
  const from = performance.now();
  const child = start("bunx", ["next", "dev", "--port", `${nextPort}`], root, {
    NEXT_TELEMETRY_DISABLED: "1",
    CF_BUILD: "1",
    DB_BACKEND: "d1",
  });
  nextDev.push(await ready(`http://localhost:${nextPort}`, "/api/preferences", from));
  stop(child);
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`next dev (first run: no Turbopack cache)
  spawn to first guest answer: ${fmt(nextDev)}`);

s.cleanup();
process.exit(0);

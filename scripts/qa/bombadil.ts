#!/usr/bin/env bun
// Bombadil exploration of the local app (docs/bombadil.md).
//
//   bun scripts/qa/bombadil.ts                 # 3 minutes on a fresh local server
//   bun scripts/qa/bombadil.ts --time 10m      # longer
//   bun scripts/qa/bombadil.ts --exit-on-violation
//   bun scripts/qa/bombadil.ts --build         # rebuild .open-next first
//   bun scripts/qa/bombadil.ts --base http://localhost:3210   # a server you started, on a local DB
//
// What it does, all on this machine:
//   1. serves the OpenNext Worker with `wrangler dev --local` on a port of its
//      own and an empty local D1 in a temp dir (building .open-next first if it
//      is missing, or with --build), with an env built from scratch: no cloud
//      token, no secret; it refuses to start when .dev.vars or an .env file
//      holds anything but the local dev keys;
//   2. launches Chromium through the silent-QA layer (scripts/qa/silent.mjs:
//      headless, --mute-audio, fake mic, the init script that mutes media and
//      stubs speechSynthesis), with remote debugging on a loopback port, DNS
//      for every other host mapped to nothing, and a request filter that drops
//      anything not on loopback;
//   3. proves the page is silent (and that a tab opened behind Playwright's
//      back is too) before Bombadil acts;
//   4. signs up a throwaway qa+bombadil…@lianki.test account, adds one catalog
//      list, opens /words on it, and runs `bombadil browser test-external`
//      against that tab with qa/bombadil/spec.ts and a time limit;
//   5. tears everything down.
//
// Exit codes: 0 clean, 2 property violation (Bombadil's own code), 3 a request
// or navigation tried to leave localhost, or a page was not silent, 1 any other error.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { launchPersistentSilent } from "./silent.mjs";

const ROOT = resolve(import.meta.dir, "../..");
const SPEC = join(ROOT, "qa/bombadil/spec.ts");

// ── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
if (flag("help")) {
  console.log(
    readFileSync(import.meta.path, "utf8")
      .split("\n")
      .slice(1, 9)
      .join("\n"),
  );
  process.exit(0);
}
const TIME = opt("time", process.env.BOMBADIL_TIME ?? "3m");
const PORT = Number(opt("port", process.env.BOMBADIL_PORT ?? "3210"));
const BUILD = flag("build");
const CDP_PORT = Number(opt("cdp-port", "9333"));
const BASE_ARG = opt("base", "");
const EXIT_ON_VIOLATION = flag("exit-on-violation");
const OUT = resolve(
  opt("out", join(ROOT, "tmp/bombadil", new Date().toISOString().replace(/[:.]/g, "-"))),
);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const BASE = BASE_ARG || `http://localhost:${PORT}`;
if (!LOOPBACK.has(new URL(BASE).hostname)) {
  console.error(`✗ --base must be a loopback URL (localhost / 127.0.0.1), not ${BASE}`);
  process.exit(1);
}

// ── The bombadil binary ─────────────────────────────────────────────────────

function findBombadil(): string {
  const candidates = [
    process.env.BOMBADIL_BIN,
    join(homedir(), ".local/bin/bombadil"),
    ...(process.env.PATH ?? "").split(":").map((d) => join(d, "bombadil")),
  ].filter(Boolean) as string[];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) {
    console.error(
      "✗ bombadil not found. Install it from https://github.com/antithesishq/bombadil/releases\n" +
        "  (bombadil-aarch64-darwin → ~/.local/bin/bombadil, chmod +x), or set BOMBADIL_BIN.",
    );
    process.exit(1);
  }
  return hit;
}
const BOMBADIL = findBombadil();

// ── Children, torn down together ────────────────────────────────────────────

const children: ChildProcess[] = [];
let ctx: BrowserContext | null = null;
let profileDir = "";
let tornDown = false;
async function teardown() {
  if (tornDown) return;
  tornDown = true;
  await ctx?.close().catch(() => {});
  for (const c of children.reverse()) {
    if (c.exitCode !== null || !c.pid) continue;
    try {
      process.kill(-c.pid, "SIGTERM"); // its whole group: wrangler forks workerd
    } catch {}
  }
  for (const d of [profileDir, d1Dir]) if (d) rmSync(d, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => void teardown().then(() => process.exit(130)));

/** Starts a child in its own process group and resolves when a line matches `ready`. */
function start(
  name: string,
  cmd: string[],
  env: Record<string, string>,
  ready: RegExp,
  ms: number,
) {
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    env: env as NodeJS.ProcessEnv,
    detached: true,
    stdio: "pipe",
  });
  children.push(child);
  return new Promise<ChildProcess>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`${name}: not ready after ${ms / 1000}s`)), ms);
    const onData = (b: Buffer) => {
      const s = b.toString();
      if (process.env.BOMBADIL_VERBOSE) process.stderr.write(`[${name}] ${s}`);
      if (ready.test(s)) {
        clearTimeout(timer);
        ok(child);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`${name} exited (${code}) before it was ready`));
    });
  });
}

// ── The local server, isolated ──────────────────────────────────────────────
//
// The deployed path, as qa:all runs it (DEVELOPMENT.md): the OpenNext Worker
// under `wrangler dev --local` (remote bindings off) on a local D1. Here the
// D1 state lives in a fresh temp dir (--persist-to), so each run starts empty
// and the worktree's .wrangler/state is never touched. Vars come in by --var;
// nothing is written to .dev.vars.

/** Keys an env file may hold for this run; anything else (cloud tokens, mail keys) stops it. */
const SAFE_ENV_KEYS = new Set([
  "NODE_ENV",
  "DB_BACKEND",
  "MONGODB_URI",
  "AUTH_SECRET",
  "BETTER_AUTH_BASE_URL",
  "DEV_EMAIL_PASSWORD_AUTH",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
]);
function checkEnvFiles() {
  const bad: string[] = [];
  for (const f of [".dev.vars", ".env", ".env.local", ".env.production", ".env.production.local"]) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m && !SAFE_ENV_KEYS.has(m[1])) bad.push(`${f}:${m[1]}`);
    }
  }
  if (bad.length) {
    console.error(
      `✗ ${bad.length} key(s) in env files the build or wrangler dev would load (names only):\n  ` +
        bad.join("\n  ") +
        "\n  Run from a worktree without them (git worktree add …), or pass --base.",
    );
    process.exit(1);
  }
}

/** The environment children get: built from scratch, so no cloud token or secret leaks in. */
const CLEAN_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: homedir(),
  TMPDIR: tmpdir(),
  LANG: process.env.LANG ?? "en_US.UTF-8",
  NEXT_TELEMETRY_DISABLED: "1",
  WRANGLER_SEND_METRICS: "false",
};

function run(name: string, cmd: string[], env: Record<string, string>) {
  console.log(`… ${name}`);
  return new Promise<void>((ok, fail) => {
    const p = spawn(cmd[0], cmd.slice(1), {
      cwd: ROOT,
      env: env as NodeJS.ProcessEnv,
      stdio: process.env.BOMBADIL_VERBOSE ? "inherit" : "ignore",
    });
    p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${name}: exit ${code}`))));
  });
}

let d1Dir = "";
async function startServer() {
  checkEnvFiles();
  if (BUILD || !existsSync(join(ROOT, ".open-next/worker.js")))
    await run(
      "OpenNext build (CF_BUILD=1 DB_BACKEND=d1), a few minutes",
      ["bunx", "opennextjs-cloudflare", "build"],
      {
        ...CLEAN_ENV,
        CF_BUILD: "1",
        DB_BACKEND: "d1",
      },
    );
  d1Dir = mkdtempSync(join(tmpdir(), "lianki-bombadil-d1-"));
  await run(
    `D1 migrations into an empty local D1 (${d1Dir})`,
    ["bunx", "wrangler", "d1", "migrations", "apply", "lianki", "--local", "--persist-to", d1Dir],
    { ...CLEAN_ENV, CI: "1" },
  );
  const vars = {
    NODE_ENV: "development", // the dev email+password gate (auth.ts); never on the deployed Worker
    DB_BACKEND: "d1",
    DEV_EMAIL_PASSWORD_AUTH: "1",
    AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    BETTER_AUTH_BASE_URL: BASE,
  };
  console.log(`… wrangler dev --local on ${BASE}`);
  await start(
    "wrangler",
    [
      "bunx",
      "wrangler",
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(PORT),
      "--persist-to",
      d1Dir,
      ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
    ],
    { ...CLEAN_ENV, DB_BACKEND: "d1" },
    /Ready on/,
    180_000,
  );
}

// ── The browser: silent, loopback only ──────────────────────────────────────

/** Runs in a page: is every sound path the silent layer's stub, not the browser's own? */
const SILENT_PROBE = () => {
  const native = (f: unknown) => typeof f === "function" && /\[native code\]/.test(String(f));
  const a = new Audio();
  return {
    mediaMuted: a.muted && a.volume === 0,
    playStubbed: !native(HTMLMediaElement.prototype.play),
    webAudioRouted: !window.AudioNode || !native(AudioNode.prototype.connect),
    speechStubbed: !window.SpeechSynthesis || !native(SpeechSynthesis.prototype.speak),
  };
};
async function assertSilent(page: Page, what: string) {
  const r = await page.evaluate(SILENT_PROBE);
  const off = Object.entries(r).filter(([, v]) => !v);
  if (off.length)
    throw new SilenceError(`${what} is not silent: ${off.map(([k]) => k).join(", ")}`);
  return r;
}
class SilenceError extends Error {}

const boundary: string[] = [];
const blocked = new Map<string, number>();
const isLoopback = (u: string) => {
  try {
    const url = new URL(u);
    return (
      url.protocol === "data:" ||
      url.protocol === "blob:" ||
      url.protocol === "about:" ||
      LOOPBACK.has(url.hostname)
    );
  } catch {
    return false;
  }
};

async function launchBrowser() {
  profileDir = mkdtempSync(join(tmpdir(), "lianki-bombadil-"));
  ctx = await launchPersistentSilent(chromium, profileDir, {
    args: [
      `--remote-debugging-port=${CDP_PORT}`,
      "--remote-debugging-address=127.0.0.1",
      "--use-fake-ui-for-media-stream",
      // Every host but loopback resolves to nothing: the network itself ends at localhost.
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    ],
    viewport: { width: 390, height: 844 },
  });
  // And per request: anything not on loopback is dropped and counted; a page
  // navigation that tries to leave is a boundary violation.
  await ctx.route("**/*", (route) => {
    const req = route.request();
    if (isLoopback(req.url())) return route.continue();
    const host = new URL(req.url()).host;
    blocked.set(host, (blocked.get(host) ?? 0) + 1);
    if (req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame())
      boundary.push(`navigation to ${req.url()}`);
    return route.abort("blockedbyclient");
  });
  // Word audio (registered last, so it is matched first): a silent stub, as
  // qa-words does. Locally the route has no voice behind it and answers 503;
  // and nothing should fetch real speech in a run anyway.
  await ctx.route("**/api/words/tts?*", (r) =>
    r.fulfill({ contentType: "audio/wav", body: Buffer.from("RIFF0000WAVE") }),
  );
  // A signed-up user has answered the first-run question; the /words walkthrough
  // is marked seen by the silent layer already.
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("lk:first-run", "account");
    } catch {}
  });
  return ctx;
}

// ── Main ────────────────────────────────────────────────────────────────────

let exitCode = 1;
let bombadil: ChildProcess | null = null;
try {
  const version = await new Promise<string>((ok) => {
    const p = spawn(BOMBADIL, ["--version"]);
    let s = "";
    p.stdout.on("data", (b) => (s += b));
    p.on("exit", () => ok(s.trim()));
  });
  console.log(`▶ ${version} (${BOMBADIL}), ${TIME}, base ${BASE}`);
  if (!BASE_ARG) await startServer();
  await launchBrowser();
  const c = ctx!;

  // Silent before anything acts: the tab Bombadil will drive…
  const page = c.pages()[0] ?? (await c.newPage());
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  console.log(
    "✓ silent: Playwright's tab",
    JSON.stringify(await assertSilent(page, "the test tab")),
  );
  // …and a tab opened over raw CDP, as Bombadil would open one.
  const opened = c.waitForEvent("page", { timeout: 30_000 });
  await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
  const extra = await opened;
  await extra.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  console.log(
    "✓ silent: a tab opened over CDP",
    JSON.stringify(await assertSilent(extra, "a CDP tab")),
  );
  await extra.close();
  // Any later page is checked as it loads; a loud one stops the run.
  c.on("page", (p) =>
    p
      .waitForLoadState("domcontentloaded")
      .then(() => assertSilent(p, `page ${p.url()}`))
      .catch((e) => {
        if (e instanceof SilenceError) {
          boundary.push(e.message);
          bombadil?.kill("SIGTERM");
        }
      }),
  );

  // A throwaway account with one catalog list, signed in in this browser.
  const email = `qa+bombadil${Date.now()}@lianki.test`;
  const headers = { origin: BASE };
  const up = await c.request.post(`${BASE}/api/auth/sign-up/email`, {
    data: { email, password: "qa-test-pass-1234", name: "QA Bombadil" },
    headers,
  });
  if (!up.ok()) throw new Error(`sign-up: HTTP ${up.status()}`);
  const index = await (await c.request.get(`${BASE}/words/index.json`)).json();
  const first = index.lists?.[0];
  let startUrl = `${BASE}/words`;
  if (first) {
    const made = await c.request.post(`${BASE}/api/words/lists`, {
      data: { name: first.name, lang: first.lang, source: first.id },
      headers,
    });
    if (made.ok()) startUrl = `${BASE}/words?list=${(await made.json()).list.id}`;
    else console.warn(`! could not add list ${first.id}: HTTP ${made.status()}`);
  }
  console.log(`✓ signed up ${email}; start ${startUrl}`);
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 300_000 });

  mkdirSync(OUT, { recursive: true });
  const args = [
    "browser",
    "test-external",
    "--remote-debugger",
    `http://127.0.0.1:${CDP_PORT}`,
    "--allow-url",
    `${new URL(BASE).origin}/*`,
    "--width",
    "390",
    "--height",
    "844",
    "--time-limit",
    TIME,
    "--output-path",
    OUT,
    "--output-path-overwrite",
    ...(EXIT_ON_VIOLATION ? ["--exit-on-violation"] : []),
    startUrl,
    SPEC,
  ];
  console.log(`▶ ${BOMBADIL} ${args.join(" ")}`);
  const code = await new Promise<number>((ok) => {
    bombadil = spawn(BOMBADIL, args, { cwd: ROOT, stdio: "inherit" });
    bombadil.on("exit", (c) => ok(c ?? 1));
  });
  console.log(`\n── bombadil exited ${code} (0 clean, 2 property violation, 1 error)`);
  summarize(OUT);
  if (blocked.size)
    console.log(
      `  blocked off-localhost requests: ${[...blocked].map(([h, n]) => `${h}×${n}`).join(", ")}`,
    );
  if (boundary.length) console.log(`✗ boundary:\n  ${boundary.join("\n  ")}`);
  exitCode = code !== 0 ? code : boundary.length ? 3 : 0;
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  exitCode = e instanceof SilenceError ? 3 : 1;
} finally {
  await teardown();
}
process.exit(exitCode);

/** Violations per property, from the trace Bombadil wrote: how many states, and each distinct value. */
function summarize(dir: string) {
  const trace = join(dir, "trace.jsonl");
  if (!existsSync(trace)) {
    console.log(
      `  no trace in ${dir} (${existsSync(dir) ? readdirSync(dir).join(", ") : "missing"})`,
    );
    return;
  }
  const lines = readFileSync(trace, "utf8").trim().split("\n");
  const byProp = new Map<string, { states: number; values: Map<string, string> }>();
  for (const l of lines) {
    let entry: { state?: { url?: string }; violations?: { name: string; violation: unknown }[] };
    try {
      entry = JSON.parse(l);
    } catch {
      continue;
    }
    for (const v of entry.violations ?? []) {
      const p = byProp.get(v.name) ?? { states: 0, values: new Map() };
      p.states++;
      // The snapshots a violation carries: the cells its condition read.
      const found: string[] = [];
      JSON.stringify(v.violation, (k, val) => {
        if (val && typeof val === "object" && "name" in val && "value" in val && val.name)
          found.push(`${val.name}=${JSON.stringify(val.value)}`);
        return val;
      });
      for (const f of found.length ? found : ["(no snapshot)"]) {
        // Word audio and list ids differ per row; keep one line per kind.
        const key = f
          .replace(/text=[^"&]*/g, "text=…")
          .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>");
        if (!p.values.has(key)) p.values.set(key, entry.state?.url ?? "");
      }
      byProp.set(v.name, p);
    }
  }
  console.log(`  ${lines.length} states in ${trace}`);
  for (const [name, p] of byProp) {
    console.log(`  ✗ ${name}: ${p.states} state(s)`);
    for (const [value, url] of [...p.values].slice(0, 6))
      console.log(`      ${value.slice(0, 400)}\n        at ${url}`);
  }
  console.log(`  inspect: ${BOMBADIL} browser inspect ${dir}`);
}

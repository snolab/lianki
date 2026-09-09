#!/usr/bin/env bun
/**
 * Live-reload dev environment for the Tampermonkey userscript.
 *
 *   bun run dev:userscript                  # loader mode, localhost
 *   bun run dev:userscript:tunnel           # loader mode + public https URL
 *   bun run dev:userscript -- --monkey      # vite-plugin-monkey HMR instead
 *
 * Two modes, because no single one covers both cases:
 *
 *   loader (default) — a tiny installed shim pulls the bundle over
 *     GM_xmlhttpRequest and evals it in the userscript sandbox. Immune to page
 *     CSP, so it works on YouTube; sees the real GM_* APIs, so dev matches prod.
 *     Reload granularity is the whole script, which is the right unit here since
 *     it already self-unloads via globalThis.unload_Lianki.
 *
 *   --monkey — vite-plugin-monkey, with real per-module HMR and Vite's dev
 *     pipeline. Nicer feedback loop, but it injects a <script src> into the page,
 *     so any site with a strict script-src blocks it. YouTube does exactly that
 *     (host allowlist, no wildcard, plus 'strict-dynamic'), so this mode is for
 *     ordinary sites.
 *
 * Ordering matters and is why this wrapper exists at all: the public hostname has
 * to be known *before* the server boots (Vite bakes the HMR client's host/port in
 * at serve time, and the loader bakes the origin into the shim it hands out).
 * cloudflared happily points at a port nothing is listening on yet, so the tunnel
 * goes up first and its assigned hostname is parsed off the banner.
 */
import { spawn, type ChildProcess } from "child_process";
import { bin as cloudflaredBin, install as installCloudflared } from "cloudflared";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "fs";
import { startLoaderServer } from "./dev-userscript-loader";

const PORT = Number(process.env.LIANKI_DEV_PORT ?? 5173);
const TUNNEL = process.argv.includes("--tunnel");
const MONKEY = process.argv.includes("--monkey");
const NEW_TUNNEL = process.argv.includes("--new-tunnel");
const TUNNEL_TIMEOUT_MS = 60_000;

// The tunnel outlives this process on purpose. It used to be a child, so every
// server restart killed it, minted a brand-new random hostname, and forced the
// userscript to be reinstalled — the single most annoying thing about this
// setup. Detached + a state file means the URL survives restarts.
const TUNNEL_STATE = "tmp/dev-tunnel.json";
const TUNNEL_LOG = "tmp/dev-tunnel.log";

/**
 * Set both to use a *named* tunnel with a permanent hostname instead of a random
 * trycloudflare one. Provisioning needs an API token with
 * `Account → Cloudflare Tunnel → Edit` and `Zone → DNS → Edit`; the token in this
 * environment has neither (zone read + Workers only), so it must be created once
 * by hand. After that this path needs no further setup.
 */
const NAMED_TOKEN = process.env.LIANKI_TUNNEL_TOKEN;
const NAMED_HOSTNAME = process.env.LIANKI_DEV_HOSTNAME;

/** vite-plugin-monkey serves its dev shim from a fixed internal route. */
const MONKEY_INSTALL_PATH = "/__vite-plugin-monkey.install.user.js";

const children: ChildProcess[] = [];
const shutdown = (code = 0) => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(code);
};
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => shutdown(0));

/**
 * Whether a pid is a *running* process — not a zombie.
 *
 * process.kill(pid, 0) succeeds for defunct processes too: the pid entry lives
 * on until the parent reaps it. Trusting it meant "reusing" a dead tunnel and
 * never spawning a replacement, which surfaced as a 530 from Cloudflare with a
 * cheerful "Reusing the running tunnel" in the log. Read the actual state field
 * from /proc and reject Z.
 */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // /proc/<pid>/stat: "pid (comm) STATE ..." — comm can contain spaces and
    // parens, so split on the LAST ')' rather than tokenizing from the left.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim()[0] !== "Z";
  } catch {
    return true; // no procfs (macOS) — fall back to the kill() result
  }
};

/**
 * A tunnel left running by a previous invocation, if it is genuinely still
 * serving. The pid check alone is not enough: cloudflared can be alive but
 * disconnected, so confirm the public URL actually answers.
 */
async function reusableTunnel(): Promise<string | null> {
  if (NEW_TUNNEL) return null;
  try {
    const { pid, url } = JSON.parse(readFileSync(TUNNEL_STATE, "utf8"));
    if (!pid || !url || !alive(pid)) return null;
    const res = await fetch(`${url}/rev`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    return res?.ok ? url : null;
  } catch {
    return null;
  }
}

function ensureCloudflared() {
  if (existsSync(cloudflaredBin)) return;
  console.log("Downloading the cloudflared binary (first run only)…");
  installCloudflared(cloudflaredBin);
}

/** Spawn cloudflared detached, with output to a log file we can read back. */
function spawnDetached(args: string[]) {
  mkdirSync("tmp", { recursive: true });
  writeFileSync(TUNNEL_LOG, "");
  const fd = openSync(TUNNEL_LOG, "a");
  const proc = spawn(cloudflaredBin, args, { detached: true, stdio: ["ignore", fd, fd] });
  proc.unref(); // survives this process exiting — that is the whole point
  return proc;
}

/**
 * Existing tunnel if one is up, else a new one. Named tunnel when configured,
 * otherwise a quick tunnel whose hostname is parsed off cloudflared's banner.
 */
async function startTunnel(): Promise<string> {
  const existing = await reusableTunnel();
  if (existing) {
    console.log(`Reusing the running tunnel — no reinstall needed: ${existing}`);
    return existing;
  }
  ensureCloudflared();

  if (NAMED_TOKEN && NAMED_HOSTNAME) {
    const proc = spawnDetached(["tunnel", "run", "--token", NAMED_TOKEN]);
    const url = `https://${NAMED_HOSTNAME}`;
    writeFileSync(TUNNEL_STATE, JSON.stringify({ pid: proc.pid, url, named: true }));
    return url;
  }

  const proc = spawnDetached(["tunnel", "--url", `http://localhost:${PORT}`]);
  // The banner lands in the log a moment after boot. Poll with golden-ratio
  // backoff rather than a fixed tick: usually one short wait is enough, and a
  // slow start degrades gracefully instead of spinning.
  const deadline = Date.now() + TUNNEL_TIMEOUT_MS;
  for (let wait = 250; Date.now() < deadline; wait = Math.min(wait * 1.618, 4000)) {
    const url = readFileSync(TUNNEL_LOG, "utf8").match(
      /https:\/\/[-\w.]+\.trycloudflare\.com/,
    )?.[0];
    if (url) {
      writeFileSync(TUNNEL_STATE, JSON.stringify({ pid: proc.pid, url, named: false }));
      return url;
    }
    if (!alive(proc.pid!)) throw new Error(`cloudflared exited early — see ${TUNNEL_LOG}`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error(`cloudflared reported no URL within ${TUNNEL_TIMEOUT_MS} ms`);
}

function startVite(origin?: string) {
  const proc = spawn(
    "bunx",
    ["vite", "--config", "vite.userscript.config.ts", "--port", String(PORT), "--strictPort"],
    { stdio: "inherit", env: { ...process.env, ...(origin && { LIANKI_DEV_ORIGIN: origin }) } },
  );
  children.push(proc);
  proc.on("exit", (code) => shutdown(code ?? 0));
}

const origin = TUNNEL ? await startTunnel() : `http://localhost:${PORT}`;

if (MONKEY) startVite(TUNNEL ? origin : undefined);
else await startLoaderServer(PORT, origin);

const installUrl = MONKEY ? `${origin}${MONKEY_INSTALL_PATH}` : `${origin}/loader.user.js`;
const mode = MONKEY ? "vite-plugin-monkey (HMR)" : "sandbox loader (CSP-proof)";

// Deferred so it lands below Vite's own banner rather than being scrolled away.
setTimeout(
  () => {
    console.log(
      [
        "",
        `  ┌─ Lianki userscript dev — ${mode}`,
        "  │",
        "  │  Install once in Tampermonkey:",
        `  │    ${installUrl}`,
        "  │",
        '  │  Installs as "[dev] Lianki" beside the released script — DISABLE the',
        "  │  released one first, or both run and fight over the same GM storage.",
        "  │  Edits to src/ or packages/core/src/ reload automatically.",
        MONKEY
          ? "  │  NOTE: blocked by CSP on YouTube. Drop --monkey to test there."
          : "  │  Works on YouTube: the bundle never enters the page's script context.",
        TUNNEL
          ? "  │  Tunnel is PUBLIC while this runs. Ctrl-C tears it down."
          : "  │  Local only. Add --tunnel for a public https URL.",
        `  └${"─".repeat(68)}`,
        "",
      ].join("\n"),
    );
  },
  MONKEY ? 1500 : 0,
);

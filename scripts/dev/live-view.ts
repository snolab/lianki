#!/usr/bin/env bun
/**
 * Live view from this Mac (docs/live-view.md): sign a pointer to the dev
 * servers' JS with this machine's Ed25519 key and publish it to lianki.com,
 * or clear it.
 *
 *   bun scripts/dev/live-view.ts keygen     # once: the key pair; prints the public key
 *   bun scripts/dev/live-view.ts on         # widget + islands on this Mac's tailnet name (those that answer)
 *   bun scripts/dev/live-view.ts on --no-islands --hours 4
 *   bun scripts/dev/live-view.ts on --widget /lianki-widget-drag   # another serve path
 *   bun scripts/dev/live-view.ts on --widget https://dev-mac.lianki.com/debug-chat.js
 *   bun scripts/dev/live-view.ts off        # stop: the row is cleared
 *   bun scripts/dev/live-view.ts status
 *   bun scripts/dev/live-view.ts pubkey     # the public key again (lib/live-view/keys.ts)
 *
 * Flags: --widget <url or /serve-path> | --no-widget, --islands <url or
 * /serve-path> | --no-islands,
 * --hours N (≤ 12, default 12), --branch, --sha (default: this checkout's),
 * --base <origin> (default LIANKI_URL or https://lianki.com).
 *
 * The private key is `~/.config/lianki/live-view-key.json` (0600;
 * LIANKI_LIVE_VIEW_KEY overrides the path). It never leaves this machine:
 * only signed pointers go out. Serials only grow (the last one is kept next
 * to the key), so lianki.com refuses a replay of an older pointer.
 *
 * The owner then flips "Live view" in his account menu, once per device.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  LIVE_VIEW_MAX_S,
  LIVE_VIEW_REQ_MAX_S,
  importLiveViewPrivateKey,
  liveLabel,
  liveSourceOk,
  signLiveView,
  type LiveViewClaim,
} from "../../lib/live-view/rules";
import { tailnetHost } from "./tailnet";

const args = process.argv.slice(2);
const cmd = args[0] ?? "status";
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const KEY =
  process.env.LIANKI_LIVE_VIEW_KEY ?? join(homedir(), ".config/lianki/live-view-key.json");
const STATE = join(dirname(KEY), "live-view-state.json");
const BASE = (opt("base") ?? process.env.LIANKI_URL ?? "https://lianki.com").replace(/\/$/, "");

function die(msg: string, code = 1): never {
  console.error(`live-view: ${msg}`);
  process.exit(code);
}

async function keygen() {
  if (existsSync(KEY)) die(`${KEY} exists; move it away first to rotate`);
  mkdirSync(dirname(KEY), { recursive: true, mode: 0o700 });
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  writeFileSync(KEY, JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x }) + "\n", {
    mode: 0o600,
  });
  chmodSync(KEY, 0o600);
  console.log(await pubkey());
  console.error(`private key: ${KEY} (0600). Put the public key above in lib/live-view/keys.ts.`);
}

function readKey(): JsonWebKey {
  if (!existsSync(KEY)) die(`no key at ${KEY}; run: bun scripts/dev/live-view.ts keygen`);
  const st = statSync(KEY);
  if (st.mode & 0o077)
    die(`${KEY} is readable by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
  return JSON.parse(readFileSync(KEY, "utf8")) as JsonWebKey;
}

async function pubkey(): Promise<string> {
  const k = readKey();
  if (!k.x) die("the key file has no public part (x)");
  return k.x; // the raw public key, base64url — the same form keys.ts keeps
}

/** Strictly above every serial this Mac has used, and roughly the time. */
function nextSerial(): number {
  let last = 0;
  try {
    last = Number(JSON.parse(readFileSync(STATE, "utf8")).serial) || 0;
  } catch {}
  const s = Math.max(Date.now(), last + 1);
  writeFileSync(STATE, JSON.stringify({ serial: s }) + "\n", { mode: 0o600 });
  return s;
}

function git(...a: string[]): string {
  const r = spawnSync("git", a, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** Does the module answer? (A warning only: the dev server may start later.) */
async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function send(token: string) {
  const r = await fetch(`${BASE}/api/live-view`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) die(`${BASE} answered ${r.status}: ${String(body.error ?? "")}`);
  return body;
}

async function sign(claim: Omit<LiveViewClaim, "aud" | "serial" | "iat">) {
  const key = await importLiveViewPrivateKey(readKey());
  const iat = Math.floor(Date.now() / 1000);
  return signLiveView(key, { ...claim, serial: nextSerial(), iat });
}

async function on() {
  const hours = Number(opt("hours") ?? 12);
  if (!(hours > 0) || hours * 3600 > LIVE_VIEW_MAX_S) die("--hours must be in (0, 12]");
  let host = "";
  const tailnet = () => (host ||= tailnetHost());
  // A bare path is a `tailscale serve` path on this Mac: /lianki-widget-drag.
  const src = (v: string | undefined, path: string, file: string) =>
    !v || v.startsWith("/") ? `https://${tailnet()}${(v ?? path).replace(/\/$/, "")}/${file}` : v;
  // Named sources only; with none named, both defaults, minus any that do not answer.
  const named = opt("widget") !== undefined || opt("islands") !== undefined;
  let widget =
    flag("no-widget") || (named && opt("widget") === undefined)
      ? undefined
      : src(opt("widget"), "/lianki-widget", "debug-chat.js");
  let islands =
    flag("no-islands") || (named && opt("islands") === undefined)
      ? undefined
      : src(opt("islands"), "/lianki-islands", "islands.js");
  for (const u of [widget, islands])
    if (u && !liveSourceOk(u))
      die(`${u}: not one of the owner's origins (lib/live-view/origins.ts)`);
  for (const u of [widget, islands]) {
    if (!u || (await reachable(u))) continue;
    if (named)
      console.error(`live-view: warning: ${u} does not answer yet (is its dev server running?)`);
    else {
      console.error(`live-view: ${u} does not answer; left out`);
      if (u === widget) widget = undefined;
      else islands = undefined;
    }
  }
  if (!widget && !islands)
    die("nothing to point at: start a dev server, or name --widget / --islands");
  const branch = opt("branch") ?? (git("rev-parse", "--abbrev-ref", "HEAD") || "detached");
  const sha = opt("sha") ?? git("rev-parse", "HEAD");
  if (!/^[0-9a-f]{7,40}$/.test(sha))
    die("no commit sha (run it in the dev server's checkout, or --sha)");
  const exp = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
  const token = await sign({ op: "on", exp, widget, islands, branch, sha });
  await send(token);
  const until = new Date(exp * 1000).toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
  console.log(`live view on: ${liveLabel({ branch, sha })} until ${until} JST`);
  if (widget) console.log(`  widget  ${widget}`);
  if (islands) console.log(`  islands ${islands}`);
  console.log(`Account menu → "Live view" on each device that should load it.`);
}

async function req(op: "off" | "status") {
  const exp = Math.floor(Date.now() / 1000) + LIVE_VIEW_REQ_MAX_S;
  return send(await sign({ op, exp }));
}

switch (cmd) {
  case "keygen":
    await keygen();
    break;
  case "pubkey":
    console.log(await pubkey());
    break;
  case "on":
    await on();
    break;
  case "off":
    await req("off");
    console.log("live view off: every page is back to the built-in JS on its next load");
    break;
  case "status": {
    const s = (await req("status")) as { on?: boolean; claim?: LiveViewClaim };
    if (!s.on || !s.claim) console.log("live view: off");
    else {
      const until = new Date(s.claim.exp * 1000).toLocaleString("sv-SE", {
        timeZone: "Asia/Tokyo",
      });
      console.log(`live view: on · ${liveLabel(s.claim)} until ${until} JST`);
      if (s.claim.widget) console.log(`  widget  ${s.claim.widget}`);
      if (s.claim.islands) console.log(`  islands ${s.claim.islands}`);
    }
    break;
  }
  default:
    die(`unknown command ${cmd}: keygen | on | off | status | pubkey`, 2);
}

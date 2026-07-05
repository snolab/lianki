#!/usr/bin/env node
// lianki — command-line client for Lianki (https://lianki.com), designed for
// agents and scripts. Zero dependencies: uses Node's global fetch (Node >= 18).
//
// Auth: a Lianki API token (`lk_…`, minted in the web UI under Settings → API
// Tokens). Resolution order for every call:
//   --token FLAG  >  $LIANKI_TOKEN  >  ~/.config/lianki/config.json
// API base: --api FLAG > $LIANKI_API > $LIANKI_URL > https://www.lianki.com
//
// Output contract (agent-friendly): data commands print the server's JSON
// verbatim to stdout and exit 0. Any error (network, non-2xx, bad usage) prints
// a JSON object `{ "error": "…" }` to stderr and exits non-zero. `export` prints
// raw YAML instead of JSON.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const VERSION = "0.1.0";
const DEFAULT_API = "https://www.lianki.com";

// ── config file (token + optional api base) ──────────────────────────────────
function configPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "lianki", "config.json");
}
function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}
function writeConfig(cfg) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return p;
}

// ── tiny arg parser: positionals + --flag val / --flag=val / boolean --flag ───
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (a === "-h") {
      flags.help = true;
    } else if (a === "-v") {
      flags.version = true;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function fail(msg, code = 1) {
  process.stderr.write(JSON.stringify({ error: String(msg) }) + "\n");
  process.exit(code);
}

function resolveToken(flags) {
  return flags.token || process.env.LIANKI_TOKEN || readConfig().token || "";
}
function resolveApi(flags) {
  const raw =
    flags.api ||
    process.env.LIANKI_API ||
    process.env.LIANKI_URL ||
    readConfig().api ||
    DEFAULT_API;
  return String(raw).replace(/\/+$/, "");
}

// ── HTTP core ─────────────────────────────────────────────────────────────────
async function request(flags, { method = "GET", path, query, body, raw = false }) {
  const token = resolveToken(flags);
  if (!token) fail("no token — run `lianki login <lk_token>` or set $LIANKI_TOKEN", 2);
  const url = new URL(resolveApi(flags) + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers = { authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    if (typeof body === "string") {
      headers["content-type"] = "text/yaml";
      payload = body;
    } else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }
  let resp;
  try {
    resp = await fetch(url, { method, headers, body: payload });
  } catch (e) {
    fail(`network error: ${e?.message ?? e}`, 1);
  }
  const text = await resp.text();
  if (!resp.ok) {
    // Surface the server's own error body if it's JSON, else a short preview.
    let detail;
    try {
      detail = JSON.parse(text);
    } catch {
      detail = { error: text.slice(0, 200).replace(/\s+/g, " ").trim() || resp.statusText };
    }
    process.stderr.write(JSON.stringify({ status: resp.status, ...detail }) + "\n");
    process.exit(resp.status === 401 || resp.status === 403 ? 2 : 1);
  }
  if (raw) return text;
  return text ? JSON.parse(text) : {};
}

function print(value) {
  process.stdout.write(
    (typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n",
  );
}

// ── commands ──────────────────────────────────────────────────────────────────
const RATINGS = new Set(["again", "hard", "good", "easy", "1", "2", "3", "4"]);

const commands = {
  async login({ positionals, flags }) {
    // token from arg, else $LIANKI_TOKEN, else stdin
    let token = positionals[0] || process.env.LIANKI_TOKEN || "";
    if (!token && !process.stdin.isTTY) {
      token = readFileSync(0, "utf8").trim();
    }
    if (!token) fail("usage: lianki login <lk_token>  (or pipe it via stdin)");
    if (!token.startsWith("lk_")) fail("that doesn't look like a Lianki token (expected lk_…)");
    const cfg = readConfig();
    cfg.token = token;
    if (flags.api) cfg.api = String(flags.api).replace(/\/+$/, "");
    const p = writeConfig(cfg);
    print({ ok: true, saved: p, api: resolveApi(flags) });
  },

  async logout() {
    const p = configPath();
    if (existsSync(p)) rmSync(p);
    print({ ok: true, removed: p });
  },

  async whoami({ flags }) {
    // Cheapest authed probe: ask for zero due cards. 401 => bad/absent token.
    await request(flags, { path: "/api/fsrs/due", query: { limit: 0 } });
    print({ authenticated: true, api: resolveApi(flags) });
  },

  async add({ positionals, flags }) {
    const url = positionals[0];
    if (!url) fail("usage: lianki add <url> [--title <title>]");
    print(
      await request(flags, {
        method: "POST",
        path: "/api/fsrs/add",
        body: { url, ...(flags.title ? { title: String(flags.title) } : {}) },
      }),
    );
  },

  async due({ flags }) {
    print(
      await request(flags, {
        path: "/api/fsrs/due",
        query: { limit: flags.limit ?? 20, excludeDomains: flags["exclude-domains"] },
      }),
    );
  },

  async next({ flags }) {
    print(
      await request(flags, {
        path: "/api/fsrs/next-url",
        query: {
          excludeUrl: flags["exclude-url"],
          excludeDomains: flags["exclude-domains"],
        },
      }),
    );
  },

  async get({ positionals, flags }) {
    const url = positionals[0];
    if (!url) fail("usage: lianki get <url>");
    print(await request(flags, { path: "/api/fsrs/get", query: { url } }));
  },

  async review({ positionals, flags }) {
    const url = positionals[0];
    const rating = String(positionals[1] ?? "").toLowerCase();
    if (!url || !RATINGS.has(rating))
      fail("usage: lianki review <url> <again|hard|good|easy>");
    print(
      await request(flags, {
        method: "POST",
        path: `/api/fsrs/review/${rating}`,
        query: { url },
      }),
    );
  },

  async delete({ positionals, flags }) {
    const url = positionals[0];
    if (!url) fail("usage: lianki delete <url>");
    print(await request(flags, { path: "/api/fsrs/delete", query: { url } }));
  },

  async move({ positionals, flags }) {
    const [oldUrl, newUrl] = positionals;
    if (!oldUrl || !newUrl) fail("usage: lianki move <oldUrl> <newUrl>");
    print(
      await request(flags, {
        method: "PATCH",
        path: "/api/fsrs/update-url",
        body: { oldUrl, newUrl },
      }),
    );
  },

  async export({ flags }) {
    const yaml = await request(flags, { path: "/api/export/yaml", raw: true });
    if (flags.out) {
      writeFileSync(String(flags.out), yaml);
      print({ ok: true, out: String(flags.out), bytes: Buffer.byteLength(yaml) });
    } else {
      print(yaml.replace(/\n$/, ""));
    }
  },

  async import({ positionals, flags }) {
    const file = positionals[0];
    if (!file) fail("usage: lianki import <file.yaml>");
    const body = readFileSync(file, "utf8");
    print(await request(flags, { method: "POST", path: "/api/import/yaml", body }));
  },
};

const HELP = `lianki ${VERSION} — command-line client for Lianki (agent-friendly)

Usage:
  lianki <command> [args] [flags]

Auth:
  login [TOKEN]                 Save API token (arg | stdin | $LIANKI_TOKEN)
  logout                        Forget the saved token
  whoami                        Verify the current token

Cards:
  add <url> [--title T]         Add a card
  due [--limit N]               List due cards            [--exclude-domains a,b]
  next                          Next due card's url       [--exclude-url U] [--exclude-domains a,b]
  get <url>                     Fetch one card by url
  review <url> <again|hard|good|easy>   Grade a card
  delete <url>                  Delete a card
  move <oldUrl> <newUrl>        Change a card's url

Data:
  export [--out FILE]           Export everything as YAML (stdout, or to FILE)
  import <file.yaml>            Restore from a YAML export

Global flags:
  --api URL     API base (default $LIANKI_API / $LIANKI_URL / ${DEFAULT_API})
  --token TOK   Token for this call only
  -h, --help    Show this help
  -v, --version Print version

Environment:
  LIANKI_TOKEN  API token          LIANKI_API / LIANKI_URL  API base
  Config file:  ~/.config/lianki/config.json  ({ "token": "lk_…", "api": "…" })

Output: JSON to stdout on success (exit 0); {"error":…} to stderr on failure
(exit 2 for auth errors, 1 otherwise). \`export\` prints raw YAML.

Examples:
  export LIANKI_TOKEN=lk_xxx
  lianki add https://example.com --title "Read this"
  lianki due --limit 5
  url=$(lianki next | node -pe 'JSON.parse(require("fs").readFileSync(0)).url')
  lianki review "$url" good
`;

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.version) return print({ lianki: VERSION });
  const cmd = positionals.shift();
  if (!cmd || flags.help || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  const handler = commands[cmd];
  if (!handler) fail(`unknown command: ${cmd} (run \`lianki help\`)`);
  await handler({ positionals, flags });
}

main().catch((e) => fail(e?.message ?? e));

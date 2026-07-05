#!/usr/bin/env node
// lianki — command-line client for Lianki (https://lianki.com), for agents and
// scripts. Built on yargs. Talks to the token-authed FSRS/data API.
//
// Auth resolution (per call):  --token  >  $LIANKI_TOKEN  >  config file
// API base:  --api  >  $LIANKI_API  >  $LIANKI_URL  >  https://www.lianki.com
// Config file: ~/.config/lianki/config.json  ({ "token": "lk_…", "api": "…" })
//
// Output contract (agent-friendly): data commands print the server's JSON
// verbatim to stdout and exit 0. Any error (usage, network, non-2xx) prints a
// JSON object `{ "error": … }` to stderr and exits non-zero (2 for auth errors,
// 1 otherwise). `export` prints raw YAML.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

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

function fail(msg, code = 1) {
  process.stderr.write(JSON.stringify({ error: String(msg) }) + "\n");
  process.exit(code);
}

function resolveToken(argv) {
  return argv.token || process.env.LIANKI_TOKEN || readConfig().token || "";
}
function resolveApi(argv) {
  const raw =
    argv.api ||
    process.env.LIANKI_API ||
    process.env.LIANKI_URL ||
    readConfig().api ||
    DEFAULT_API;
  return String(raw).replace(/\/+$/, "");
}

// ── HTTP core ─────────────────────────────────────────────────────────────────
async function request(argv, { method = "GET", path, query, body, raw = false }) {
  const token = resolveToken(argv);
  if (!token) fail("no token — run `lianki login <lk_token>` or set $LIANKI_TOKEN", 2);
  const url = new URL(resolveApi(argv) + path);
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

// ── shared option builders ────────────────────────────────────────────────────
const excludeOpts = (y) =>
  y.option("exclude-domains", {
    type: "string",
    describe: "Comma-separated domains to skip",
  });

// ── CLI ───────────────────────────────────────────────────────────────────────
await yargs(hideBin(process.argv))
  .scriptName("lianki")
  .usage("$0 <command> [args]\n\nCommand-line client for Lianki (agent-friendly).")
  .option("api", {
    type: "string",
    describe: `API base (default $LIANKI_API / $LIANKI_URL / ${DEFAULT_API})`,
  })
  .option("token", { type: "string", describe: "API token for this call only" })

  .command(
    "login [token]",
    "Save an API token (arg | stdin | $LIANKI_TOKEN) to the config file",
    (y) => y.positional("token", { type: "string", describe: "lk_… API token" }),
    (argv) => {
      let token = argv.token || process.env.LIANKI_TOKEN || "";
      if (!token && !process.stdin.isTTY) token = readFileSync(0, "utf8").trim();
      if (!token) fail("usage: lianki login <lk_token>  (or pipe it via stdin)");
      if (!token.startsWith("lk_"))
        fail("that doesn't look like a Lianki token (expected lk_…)");
      const cfg = readConfig();
      cfg.token = token;
      if (argv.api) cfg.api = String(argv.api).replace(/\/+$/, "");
      const p = writeConfig(cfg);
      print({ ok: true, saved: p, api: resolveApi(argv) });
    },
  )

  .command("logout", "Forget the saved token", {}, () => {
    const p = configPath();
    if (existsSync(p)) rmSync(p);
    print({ ok: true, removed: p });
  })

  .command("whoami", "Verify the current token", {}, async (argv) => {
    await request(argv, { path: "/api/fsrs/due", query: { limit: 0 } });
    print({ authenticated: true, api: resolveApi(argv) });
  })

  .command(
    "add <url>",
    "Add a card",
    (y) =>
      y
        .positional("url", { type: "string", describe: "URL to add" })
        .option("title", { type: "string", describe: "Card title" }),
    (argv) =>
      request(argv, {
        method: "POST",
        path: "/api/fsrs/add",
        body: { url: argv.url, ...(argv.title ? { title: argv.title } : {}) },
      }).then(print),
  )

  .command(
    "due",
    "List due cards",
    (y) =>
      excludeOpts(y).option("limit", { type: "number", default: 20, describe: "Max cards" }),
    (argv) =>
      request(argv, {
        path: "/api/fsrs/due",
        query: { limit: argv.limit, excludeDomains: argv["exclude-domains"] },
      }).then(print),
  )

  .command(
    "next",
    "Print the next due card's url",
    (y) =>
      excludeOpts(y).option("exclude-url", { type: "string", describe: "URL to skip" }),
    (argv) =>
      request(argv, {
        path: "/api/fsrs/next-url",
        query: {
          excludeUrl: argv["exclude-url"],
          excludeDomains: argv["exclude-domains"],
        },
      }).then(print),
  )

  .command(
    "get <url>",
    "Fetch one card by url",
    (y) => y.positional("url", { type: "string", describe: "Card URL" }),
    (argv) => request(argv, { path: "/api/fsrs/get", query: { url: argv.url } }).then(print),
  )

  .command(
    "review <url> <rating>",
    "Grade a card",
    (y) =>
      y
        .positional("url", { type: "string", describe: "Card URL" })
        .positional("rating", {
          type: "string",
          choices: ["again", "hard", "good", "easy", "1", "2", "3", "4"],
          describe: "Grade",
        }),
    (argv) =>
      request(argv, {
        method: "POST",
        path: `/api/fsrs/review/${String(argv.rating).toLowerCase()}`,
        query: { url: argv.url },
      }).then(print),
  )

  .command(
    "delete <url>",
    "Delete a card",
    (y) => y.positional("url", { type: "string", describe: "Card URL" }),
    (argv) =>
      request(argv, { path: "/api/fsrs/delete", query: { url: argv.url } }).then(print),
  )

  .command(
    "move <oldUrl> <newUrl>",
    "Change a card's url",
    (y) =>
      y
        .positional("oldUrl", { type: "string", describe: "Current URL" })
        .positional("newUrl", { type: "string", describe: "New URL" }),
    (argv) =>
      request(argv, {
        method: "PATCH",
        path: "/api/fsrs/update-url",
        body: { oldUrl: argv.oldUrl, newUrl: argv.newUrl },
      }).then(print),
  )

  .command(
    "export",
    "Export everything as YAML (stdout, or to --out FILE)",
    (y) => y.option("out", { type: "string", describe: "Write YAML to this file" }),
    async (argv) => {
      const yaml = await request(argv, { path: "/api/export/yaml", raw: true });
      if (argv.out) {
        writeFileSync(String(argv.out), yaml);
        print({ ok: true, out: String(argv.out), bytes: Buffer.byteLength(yaml) });
      } else {
        print(yaml.replace(/\n$/, ""));
      }
    },
  )

  .command(
    "import <file>",
    "Restore from a YAML export",
    (y) => y.positional("file", { type: "string", describe: "YAML export file" }),
    (argv) =>
      request(argv, {
        method: "POST",
        path: "/api/import/yaml",
        body: readFileSync(argv.file, "utf8"),
      }).then(print),
  )

  .demandCommand(1, "")
  .strict()
  .fail((msg, err) => {
    if (err) throw err;
    fail(msg || "usage error", 1);
  })
  .alias("h", "help")
  .version(VERSION)
  .alias("v", "version")
  .wrap(Math.min(100, process.stdout.columns || 100))
  .epilogue(
    "Output: JSON to stdout on success (exit 0); {\"error\":…} to stderr on failure " +
      "(exit 2 for auth, 1 otherwise). `export` prints raw YAML.\n" +
      "Docs: https://github.com/snomiao/lianki/tree/main/packages/lianki-cli",
  )
  .parseAsync()
  .catch((e) => fail(e?.message ?? e));

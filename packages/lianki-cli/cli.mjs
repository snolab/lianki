// lianki CLI: commands, output and exit codes. The bin (lianki.mjs) calls run().
//
// Made for agents first (README.md, "For agents"):
//   - `lianki --help` is a short list; details live in `lianki <cmd> --help`.
//   - `--json` on every command: one envelope on stdout, schema `v: 1`.
//   - Errors go to stderr (as JSON with --json), with stable exit codes:
//     0 ok · 1 usage · 2 auth · 3 not found · 4 network/server · 5 refused.
//   - Never prompts when stdin is not a TTY: it fails and names the command
//     to run instead (`--yes`, `--token -`, LIANKI_TOKEN).
//   - The token is never printed, in any mode.

import yargs from "yargs";
import { DEVICE_RE, randomId, s256, TOKEN_RE } from "./auth.mjs";

export const SCHEMA_VERSION = 1;
export const DEFAULT_URL = "https://lianki.com";
export const EXIT = { ok: 0, usage: 1, auth: 2, notFound: 3, server: 4, refused: 5 };

/**
 * The settings that follow the account, as lib/prefs/schema.ts lists them
 * (unit/lianki-cli.test.ts keeps the two in step). The server checks every
 * value; this list is for `settings list` and for refusing a typo early.
 */
export const PREF_KEYS = [
  "words.showAll",
  "words.readAloud",
  "words.serverVoice",
  "words.speakOnSwipe",
  "words.gradeTones",
  "words.voiceMode",
  "swipe.variant",
  "swipe-feel.preset",
  "swipe-feel.tweaks",
  "motion.animations",
  "ui.paper",
  "text-size.ui",
  "text-size.chat",
  "text-size.cards",
  "ui.locale",
  "nav-pins.pinned",
  "home.lang",
  "home.pins",
  "lab.immersionLangs",
  "lab.immersionTranspose",
  "chat-voice.rate",
  "chat-voice.out",
  "chat-voice.speak",
];

const RATINGS = { again: 1, hard: 2, good: 3, easy: 4, 1: 1, 2: 2, 3: 3, 4: 4 };
const RATING_NAME = { 1: "again", 2: "hard", 3: "good", 4: "easy" };

export class CliError extends Error {
  constructor(code, exit, message, hint) {
    super(message);
    this.code = code;
    this.exit = exit;
    this.hint = hint;
  }
}
const usage = (msg, hint) => new CliError("usage", EXIT.usage, msg, hint);
const LOGIN_HINT = "lianki auth login   (agents: set LIANKI_TOKEN=lk_… or pass --token)";

// ── Context: where, who, how to print ─────────────────────────────────────

function context(argv, deps) {
  const base = String(
    argv.api || deps.env.LIANKI_URL || deps.env.LIANKI_API || DEFAULT_URL,
  ).replace(/\/+$/, "");
  let site;
  try {
    const u = new URL(base);
    if (u.protocol !== "https:" && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname))
      throw new Error("not https");
    site = u.host;
  } catch {
    throw usage(`--api must be an https:// address (got "${base}")`);
  }
  return { argv, deps, base, site, json: Boolean(argv.json) };
}

/** The token to use, and where it came from. Never printed. */
async function currentToken(c) {
  const { argv, deps } = c;
  const given = typeof argv.token === "string" ? argv.token.trim() : "";
  if (given) {
    if (given === "-") return { token: await stdinToken(deps), from: "stdin" };
    if (!TOKEN_RE.test(given)) throw usage("--token is not a Lianki API token (lk_ + 64 hex)");
    return { token: given, from: "flag" };
  }
  const env = deps.env.LIANKI_TOKEN?.trim();
  if (env) {
    if (!TOKEN_RE.test(env))
      throw new CliError("auth_invalid", EXIT.auth, "LIANKI_TOKEN is set but is not an lk_ token");
    return { token: env, from: "env" };
  }
  const meta = deps.config.read().sites[c.site];
  if (meta) {
    const token = await deps.store.get(c.site, meta);
    if (token) return { token, from: meta.storage, meta };
  }
  const legacy = deps.config.legacyToken?.();
  if (legacy) return { token: legacy, from: "legacy-file" };
  return { token: null, from: "none" };
}

async function needToken(c) {
  const t = await currentToken(c);
  if (!t.token)
    throw new CliError("auth_required", EXIT.auth, `not signed in to ${c.site}`, LOGIN_HINT);
  return t.token;
}

async function stdinToken(deps) {
  if (deps.stdinIsTTY)
    throw usage("--token - reads the token from stdin; pipe it in", "printf %s \"$TOKEN\" | lianki auth login --token -");
  const t = (await deps.readStdin()).trim();
  if (!TOKEN_RE.test(t)) throw usage("stdin is not a Lianki API token (lk_ + 64 hex)");
  return t;
}

// ── HTTP ──────────────────────────────────────────────────────────────────

async function call(c, token, { method = "GET", path, query, body }) {
  const url = new URL(path, c.base + "/");
  for (const [k, v] of Object.entries(query ?? {}))
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let r;
  try {
    r = await c.deps.fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
  } catch (e) {
    throw new CliError("network", EXIT.server, `cannot reach ${c.site}: ${e?.message ?? e}`);
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (r.status >= 200 && r.status < 300 && data !== null) return { status: r.status, data };
  const said = (data && typeof data.error === "string" && data.error) || text.slice(0, 200);
  const detail = said.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (r.status === 401 || r.status === 403)
    throw new CliError("auth_refused", EXIT.auth, `${c.site} refused the token (${r.status})`, LOGIN_HINT);
  // The FSRS router answers a missing card with a 500 "Error: note not found".
  if (r.status === 404 || /note not found/i.test(detail))
    throw new CliError("not_found", EXIT.notFound, detail && !/^404$/.test(detail) ? detail : "not found");
  if (r.status >= 300 && r.status < 400)
    throw new CliError("server", EXIT.server, `${c.site} redirected (${r.status}); check --api`);
  if (r.status >= 500 || data === null)
    throw new CliError("server", EXIT.server, `${c.site} failed (${r.status})${detail ? `: ${detail}` : ""}`);
  throw new CliError("refused", EXIT.refused, `${c.site} refused it (${r.status})${detail ? `: ${detail}` : ""}`);
}

// ── Output ────────────────────────────────────────────────────────────────

function emit(c, command, data, human) {
  if (c.json) c.deps.out(JSON.stringify({ v: SCHEMA_VERSION, ok: true, command, data }));
  else c.deps.out(human(data));
}

const cardLine = (x) => `${x.url}${x.title ? `  ${x.title}` : ""}`;
const nextOf = (d) => (d?.nextUrl ? { url: d.nextUrl, title: d.nextTitle ?? null } : null);

// ── Commands ──────────────────────────────────────────────────────────────

async function cmdAdd(c) {
  const token = await needToken(c);
  const { data } = await call(c, token, {
    method: "POST",
    path: "/api/fsrs/add",
    body: { url: c.argv.url, ...(c.argv.title ? { title: c.argv.title } : {}) },
  });
  const out = {
    url: data.url ?? c.argv.url,
    title: data.title ?? null,
    due: data.card?.due ?? null,
    options: (data.options ?? []).map((o) => ({
      rating: RATING_NAME[o.rating] ?? String(o.rating),
      interval: o.due,
    })),
  };
  emit(c, "add", out, (d) => `added ${cardLine(d)}`);
}

async function cmdDue(c) {
  const token = await needToken(c);
  const { data } = await call(c, token, {
    path: "/api/fsrs/due",
    query: { limit: c.argv.limit, excludeDomains: c.argv["exclude-domains"] },
  });
  const cards = (data.cards ?? []).map((x) => ({
    url: x.url,
    title: x.title ?? null,
    due: x.card?.due ?? null,
    state: x.card?.state ?? null,
    reps: x.card?.reps ?? null,
    lapses: x.card?.lapses ?? null,
  }));
  emit(c, "due", { cards }, (d) =>
    d.cards.length ? d.cards.map(cardLine).join("\n") : "nothing due",
  );
}

async function cmdNext(c) {
  const token = await needToken(c);
  const { data } = await call(c, token, {
    path: "/api/fsrs/next-url",
    query: { excludeUrl: c.argv["exclude-url"], excludeDomains: c.argv["exclude-domains"] },
  });
  const card = data.url ? { url: data.url, title: data.title ?? null } : null;
  emit(c, "next", { card }, (d) => (d.card ? cardLine(d.card) : "nothing due"));
}

async function cmdGet(c) {
  const token = await needToken(c);
  const { data } = await call(c, token, { path: "/api/fsrs/get", query: { url: c.argv.url } });
  emit(c, "get", { url: data.url, title: data.title ?? null }, cardLine);
}

async function cmdReview(c) {
  const rating = RATINGS[String(c.argv.rating).toLowerCase()];
  if (!rating) throw usage(`rating must be again, hard, good or easy (or 1–4)`);
  const token = await needToken(c);
  const { data } = await call(c, token, {
    method: "POST",
    path: `/api/fsrs/review/${rating}`,
    query: { url: c.argv.url },
  });
  const out = {
    url: c.argv.url,
    rating: RATING_NAME[rating],
    interval: data.due ?? null,
    due: data.card?.due ?? null,
    next: nextOf(data),
  };
  emit(c, "review", out, (d) =>
    [`${d.rating}: next review in ${d.interval}`, d.next ? `next: ${cardLine(d.next)}` : "nothing else due"].join("\n"),
  );
}

async function confirm(c, question, rerun) {
  if (c.argv.yes) return;
  if (!c.deps.stdinIsTTY || c.json)
    throw usage(`${question} needs confirmation; add --yes`, rerun);
  const answer = (await c.deps.ask(`${question} [y/N] `)).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") throw usage("cancelled", rerun);
}

async function cmdDelete(c) {
  await confirm(c, `delete ${c.argv.url}?`, `lianki delete ${JSON.stringify(c.argv.url)} --yes`);
  const token = await needToken(c);
  const { data } = await call(c, token, { path: "/api/fsrs/delete", query: { url: c.argv.url } });
  emit(c, "delete", { url: c.argv.url, deleted: true, next: nextOf(data) }, (d) => `deleted ${d.url}`);
}

async function cmdMove(c) {
  const token = await needToken(c);
  const { data } = await call(c, token, {
    method: "PATCH",
    path: "/api/fsrs/update-url",
    body: { oldUrl: c.argv.from, newUrl: c.argv.to },
  });
  if (!data.ok) throw new CliError("not_found", EXIT.notFound, `no card at ${c.argv.from}`);
  emit(c, "move", { from: c.argv.from, to: c.argv.to, moved: true }, (d) => `moved ${d.from} → ${d.to}`);
}

async function cmdStats(c) {
  const token = await needToken(c);
  const { data } = await call(c, token, { path: "/api/fsrs/stats" });
  emit(c, "stats", { cards: data.notes ?? 0, due: data.due ?? 0 }, (d) => `${d.cards} cards, ${d.due} due`);
}

// ── auth ──────────────────────────────────────────────────────────────────

async function whoIs(c, token) {
  const { data } = await call(c, token, { path: "/api/prefs" });
  return typeof data.user === "string" ? data.user : null;
}

async function saveLogin(c, token, info) {
  const { deps, site } = c;
  const storage = await deps.store.set(site, token);
  const cfg = deps.config.read();
  cfg.sites[site] = { storage, ...info, ...(storage === "file" ? { token } : {}) };
  deps.config.write(cfg);
  return storage;
}

const storedIn = (c, storage) =>
  storage === "keychain" ? "the macOS Keychain" : `${c.deps.config.path} (mode 0600)`;

async function cmdLogin(c) {
  const { argv, deps } = c;
  const given = typeof argv.token === "string" ? argv.token.trim() : deps.env.LIANKI_TOKEN?.trim();
  if (given) {
    const token = given === "-" ? await stdinToken(deps) : given;
    if (!TOKEN_RE.test(token)) throw usage("that is not a Lianki API token (lk_ + 64 hex)");
    const user = await whoIs(c, token);
    const storage = await saveLogin(c, token, { user });
    return emit(c, "auth login", { site: c.site, user, storage }, () =>
      `signed in to ${c.site}; token stored in ${storedIn(c, storage)}`,
    );
  }
  if (!deps.stdinIsTTY && !argv.browser)
    throw usage(
      "browser sign-in needs a person at this machine; stdin is not a terminal",
      "set LIANKI_TOKEN=lk_…, or: printf %s \"$TOKEN\" | lianki auth login --token -   (or add --browser to open it anyway)",
    );

  const verifier = randomId(48);
  const state = randomId(24);
  const l = await deps.listen(state, deps.timeoutMs);
  const url = new URL("/cli-login", c.base + "/");
  url.searchParams.set("redirect_uri", l.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("host", deps.hostname);
  deps.err(`Opening ${url.origin}/cli-login — approve there to sign in.`);
  deps.err(`If no browser opens, visit:\n  ${url}`);
  if (argv.open !== false) deps.openUrl(url.toString());

  const cb = await l.done;
  if (!cb.ok) throw new CliError("auth_failed", EXIT.auth, `sign-in ${cb.error}`, "lianki auth login");
  const { data } = await call(c, null, {
    method: "POST",
    path: "/api/cli-login/token",
    body: { code: cb.code, code_verifier: verifier, redirect_uri: l.redirectUri },
  });
  if (typeof data.token !== "string" || !TOKEN_RE.test(data.token))
    throw new CliError("server", EXIT.server, "the sign-in exchange returned no token");
  const info = { email: data.email, name: data.name, tokenId: data.id };
  const storage = await saveLogin(c, data.token, info);
  emit(c, "auth login", { site: c.site, email: data.email ?? null, tokenName: data.name ?? null, storage }, (d) =>
    `signed in to ${d.site} as ${d.email} — token "${d.tokenName}" stored in ${storedIn(c, storage)}`,
  );
}

async function cmdStatus(c) {
  const t = await currentToken(c);
  if (!t.token) {
    const d = { site: c.site, signedIn: false, source: null, account: null };
    if (c.json) c.deps.out(JSON.stringify({ v: SCHEMA_VERSION, ok: true, command: "auth status", data: d }));
    throw new CliError("auth_required", EXIT.auth, `not signed in to ${c.site}`, LOGIN_HINT);
  }
  const user = await whoIs(c, t.token);
  emit(
    c,
    "auth status",
    { site: c.site, signedIn: true, source: t.from, account: t.meta?.email ?? user, tokenName: t.meta?.name ?? null },
    (d) => `signed in to ${d.site} as ${d.account} (token from ${d.source})`,
  );
}

async function cmdLogout(c) {
  const { deps, site } = c;
  const cfg = deps.config.read();
  const meta = cfg.sites[site];
  const token = meta ? await deps.store.get(site, meta) : deps.config.legacyToken?.();
  if (!meta && !token) {
    const envNote = deps.env.LIANKI_TOKEN ? " (LIANKI_TOKEN is set: unset it, and delete that token in lianki.com/preferences → API Tokens)" : "";
    return emit(c, "auth logout", { site, revoked: false, forgotten: false }, () => `not signed in${envNote}`);
  }
  let revoked = false;
  if (token) {
    try {
      await call(c, token, { method: "DELETE", path: "/api/cli-login/token" });
      revoked = true;
    } catch (e) {
      revoked = e instanceof CliError && (e.code === "not_found" || e.code === "auth_refused");
    }
  }
  if (meta) {
    await deps.store.delete(site);
    delete cfg.sites[site];
    deps.config.write(cfg);
  }
  deps.config.dropLegacy?.();
  emit(c, "auth logout", { site, revoked, forgotten: true }, (d) =>
    d.revoked
      ? "signed out: the token is revoked and forgotten"
      : "signed out here, but the server could not revoke the token — delete it in lianki.com/preferences → API Tokens",
  );
  if (!revoked) return EXIT.server;
}

// ── settings ──────────────────────────────────────────────────────────────

function checkKey(key) {
  if (!PREF_KEYS.includes(key))
    throw usage(`unknown setting "${key}"`, "lianki settings list   (shows every key)");
}

async function readPrefs(c, token) {
  const { data } = await call(c, token, { path: "/api/prefs" });
  return data.prefs && typeof data.prefs === "object" ? data.prefs : {};
}

/** A command-line value: JSON when it parses (true, 1.25, ["/words"]), else the bare word. */
export function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function deviceId(c) {
  const cfg = c.deps.config.read();
  if (cfg.deviceId && DEVICE_RE.test(cfg.deviceId)) return cfg.deviceId;
  cfg.deviceId = `cli${randomId(12).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16).padEnd(8, "0")}`;
  c.deps.config.write(cfg);
  return cfg.deviceId;
}

/** A clock newer than the stored one, so this write wins (docs/prefs-sync.md). */
export function nextHlc(prev, id, now = Date.now()) {
  if (prev && prev.timestamp >= now) return { timestamp: prev.timestamp, counter: prev.counter + 1, deviceId: id };
  return { timestamp: now, counter: 0, deviceId: id };
}

async function cmdSettingsList(c) {
  const token = await needToken(c);
  const prefs = await readPrefs(c, token);
  const settings = Object.fromEntries(PREF_KEYS.map((k) => [k, k in prefs ? prefs[k].value : null]));
  emit(c, "settings list", { settings }, (d) =>
    Object.entries(d.settings).map(([k, v]) => `${k} = ${v === null ? "(not set)" : JSON.stringify(v)}`).join("\n"),
  );
}

async function cmdSettingsGet(c) {
  checkKey(c.argv.key);
  const token = await needToken(c);
  const prefs = await readPrefs(c, token);
  const value = c.argv.key in prefs ? prefs[c.argv.key].value : null;
  emit(c, "settings get", { key: c.argv.key, value }, (d) => (d.value === null ? "(not set)" : JSON.stringify(d.value)));
}

async function cmdSettingsSet(c) {
  checkKey(c.argv.key);
  const value = parseValue(String(c.argv.value));
  const token = await needToken(c);
  const prefs = await readPrefs(c, token);
  const op = { key: c.argv.key, value, hlc: nextHlc(prefs[c.argv.key]?.hlc, deviceId(c), c.deps.now()) };
  const { data } = await call(c, token, { method: "PATCH", path: "/api/prefs", body: { ops: [op] } });
  if (Array.isArray(data.rejected) && data.rejected.includes(c.argv.key))
    throw new CliError("refused", EXIT.refused, `${JSON.stringify(value)} is not a valid value for ${c.argv.key}`);
  const won = data.prefs?.[c.argv.key]?.value ?? value;
  emit(c, "settings set", { key: c.argv.key, value: won }, (d) => `${d.key} = ${JSON.stringify(d.value)}`);
}

// ── Parser ────────────────────────────────────────────────────────────────

const EPILOG =
  "Run `lianki <command> --help` for a command's options. Add --json for machine output.\n" +
  "Agents: LIANKI_TOKEN=lk_… (or --token) instead of signing in; --api or $LIANKI_URL for another site.\n" +
  "Exit codes: 0 ok, 1 usage, 2 auth, 3 not found, 4 network/server, 5 refused.";

function build(args, deps, box) {
  const act = (fn) => (argv) => {
    box.task = (async () => fn(context(argv, deps)))();
  };
  const examples = (y, list) => list.reduce((acc, [cmd, what]) => acc.example(cmd, what), y);
  const sub = (y) => y.demandCommand(1, "").strict();

  return yargs(args)
    .scriptName("lianki")
    .usage("lianki <command> — Lianki spaced repetition from the terminal")
    .option("json", { type: "boolean", describe: "Machine output: one JSON object (schema v1)", global: true })
    .option("token", { type: "string", describe: "API token for this call (or - for stdin)", global: true, hidden: true })
    .option("api", { type: "string", describe: "Lianki site (default https://lianki.com, or $LIANKI_URL)", global: true, hidden: true })
    .command("auth", "Sign in, check, sign out", (y) =>
      examples(
        sub(y)
          .usage("lianki auth <login|status|logout>")
          .command(
            "login",
            "Sign in (browser by default; --token for agents)",
            (y) =>
              examples(
                y
                  .option("browser", { type: "boolean", describe: "Open the browser even when stdin is not a terminal" })
                  .option("open", { type: "boolean", default: true, describe: "Open the browser (--no-open: only print the link)" })
                  .epilogue("Agents: skip the browser with LIANKI_TOKEN=lk_… (no login needed) or --token. --api or $LIANKI_URL picks another site."),
                [
                  ["lianki auth login", "approve in the browser; the token goes to the Keychain"],
                  ["lianki auth login --token - < token.txt", "store a token made in lianki.com/preferences → API Tokens"],
                ],
              ),
            act(cmdLogin),
          )
          .command("status", "Who am I signed in as?", (y) => examples(y, [["lianki auth status --json", "check before a script runs"]]), act(cmdStatus))
          .command("logout", "Revoke the token on the server and forget it", (y) => examples(y, [["lianki auth logout", ""]]), act(cmdLogout)),
        [["lianki auth login", "sign in through the browser"]],
      ),
    )
    .command(
      "next",
      "The next card to review",
      (y) =>
        examples(
          y
            .option("exclude-url", { type: "string", describe: "Skip this url" })
            .option("exclude-domains", { type: "string", describe: "Comma-separated domains to skip" }),
          [
            ["lianki next", "url and title of the next due card"],
            ["lianki next --json | jq -r .data.card.url", "just the url"],
          ],
        ),
      act(cmdNext),
    )
    .command(
      "review <url> <rating>",
      "Grade a card: again, hard, good, easy",
      (y) =>
        examples(
          y
            .positional("url", { type: "string", describe: "The card's url" })
            .positional("rating", { type: "string", describe: "again | hard | good | easy (or 1–4)" }),
          [["lianki review https://example.com/article good", "next review in a few days"]],
        ),
      act(cmdReview),
    )
    .command(
      "due",
      "List due cards",
      (y) =>
        examples(
          y
            .option("limit", { type: "number", default: 20, describe: "Most cards to list" })
            .option("exclude-domains", { type: "string", describe: "Comma-separated domains to skip" }),
          [["lianki due --limit 5", "the five most overdue cards"]],
        ),
      act(cmdDue),
    )
    .command(
      "add <url>",
      "Add a page as a card",
      (y) =>
        examples(
          y
            .positional("url", { type: "string", describe: "The page to learn" })
            .option("title", { type: "string", describe: "Card title" }),
          [['lianki add https://example.com/article --title "Example"', ""]],
        ),
      act(cmdAdd),
    )
    .command(
      "get <url>",
      "Look up one card",
      (y) => examples(y.positional("url", { type: "string", describe: "The card's url" }), [["lianki get https://example.com/article", "exit 3 if there is none"]]),
      act(cmdGet),
    )
    .command(
      "delete <url>",
      "Delete a card (asks first; --yes to skip)",
      (y) =>
        examples(
          y.positional("url", { type: "string", describe: "The card's url" }).option("yes", { alias: "y", type: "boolean", describe: "Do not ask" }),
          [["lianki delete https://example.com/article --yes", ""]],
        ),
      act(cmdDelete),
    )
    .command(
      "move <from> <to>",
      "Change a card's url",
      (y) =>
        examples(
          y.positional("from", { type: "string", describe: "Current url" }).positional("to", { type: "string", describe: "New url" }),
          [["lianki move http://old.example/a https://new.example/a", ""]],
        ),
      act(cmdMove),
    )
    .command("stats", "How many cards, how many due", (y) => examples(y, [["lianki stats --json", ""]]), act(cmdStats))
    .command("settings", "Read and change your account settings", (y) =>
      examples(
        sub(y)
          .usage("lianki settings <list|get|set>")
          .command("list", "Every setting and its value", (y) => examples(y, [["lianki settings list --json", ""]]), act(cmdSettingsList))
          .command(
            "get <key>",
            "One setting's value",
            (y) => examples(y.positional("key", { type: "string", describe: "Setting name (see settings list)" }), [["lianki settings get chat-voice.rate", ""]]),
            act(cmdSettingsGet),
          )
          .command(
            "set <key> <value>",
            "Change a setting (value as JSON or a bare word)",
            (y) =>
              examples(
                y
                  .positional("key", { type: "string", describe: "Setting name (see settings list)" })
                  .positional("value", { type: "string", describe: 'true, 1.25, light, \'["/words"]\'' }),
                [
                  ["lianki settings set words.readAloud true", ""],
                  ["lianki settings set chat-voice.rate 1.25", ""],
                ],
              ),
            act(cmdSettingsSet),
          ),
        [["lianki settings list", ""]],
      ),
    )
    .example("lianki auth login", "sign in through the browser")
    .example("lianki next --json", "the next due card, for a script")
    .demandCommand(1, "")
    .strict()
    .epilogue(EPILOG)
    .alias("h", "help")
    .version(deps.version)
    .alias("v", "version")
    .wrap(Math.min(100, deps.columns || 100))
    .exitProcess(false)
    .fail((msg, err) => {
      throw err ?? usage(msg || "usage error", "lianki --help");
    });
}

function report(deps, json, e) {
  const err =
    e instanceof CliError ? e : new CliError("internal", EXIT.server, String(e?.message ?? e));
  if (json)
    deps.err(
      JSON.stringify({
        v: SCHEMA_VERSION,
        ok: false,
        error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) },
        exit: err.exit,
      }),
    );
  else deps.err(`lianki: ${err.message}${err.hint ? `\n  try: ${err.hint}` : ""}`);
  return err.exit;
}

/** Runs one command line; resolves to the exit code. */
export async function run(args, deps) {
  if (args.length === 0) {
    await run(["--help"], deps);
    return EXIT.usage;
  }
  // yargs reads a bare `-` as a positional; `--token -` means "from stdin".
  args = args.flatMap((a, i) => (a === "-" && args[i - 1] === "--token" ? [] : a === "--token" && args[i + 1] === "-" ? ["--token=-"] : [a]));
  const json = args.includes("--json");
  const box = { task: null };
  let output = "";
  try {
    await new Promise((resolve, reject) => {
      build(args, deps, box).parse(args, {}, (err, _argv, out) => {
        output = out ?? "";
        if (err) reject(err);
        else resolve();
      });
    });
    if (output) deps.out(output.replace(/\n+$/, ""));
    if (!box.task) {
      if (!output) throw usage("missing command", "lianki --help");
      return EXIT.ok;
    }
    const code = await box.task;
    return typeof code === "number" ? code : EXIT.ok;
  } catch (e) {
    if (output && !(e instanceof CliError)) deps.err(output.replace(/\n+$/, ""));
    return report(deps, json, e);
  }
}

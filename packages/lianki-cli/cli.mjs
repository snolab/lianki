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
import { createChatBridge, filterDecision, ayDeliver, bridgeConfig } from "./chat-bridge.mjs";
import { createInterface } from "node:readline";
import { createChatReceiver, turnConfig } from "./chat-receiver.mjs";
import { applyGrantPolish } from "./chat-polish.mjs";
import { createFriendInbox, INBOX_DEFAULTS } from "./chat-inbox.mjs";
import { join } from "node:path";

export const SCHEMA_VERSION = 1;
export const DEFAULT_URL = "https://lianki.com";
export const EXIT = { ok: 0, usage: 1, auth: 2, notFound: 3, server: 4, refused: 5 };

/**
 * The settings that follow the account, as lib/prefs/schema.ts listed them
 * when this version was published. A newer server may know more keys: those
 * still work (the server checks every key and value), and `settings list`
 * shows any the server returns. unit/lianki-cli.test.ts checks that none of
 * these has been removed from the server.
 */
export const PREF_KEYS = [
  "words.showAll",
  "words.readAloud",
  "words.serverVoice",
  "words.speakOnSwipe",
  "words.gradeTones",
  "words.voiceMode",
  "words.swipeMirror",
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
  "chat-voice.cueSend",
  "chat-voice.cueSpeech",
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
const SCOPE_HINT =
  "the token lacks that permission: make one that has it at lianki.com/my/preferences → API tokens, or lianki auth login again";

// ── Context: where, who, how to print ─────────────────────────────────────

export function context(argv, deps) {
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
export async function currentToken(c) {
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
  const legacy = deps.config.legacyToken?.(c.site);
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

export async function call(c, token, { method = "GET", path, query, body, headers: extra }) {
  const url = new URL(path, c.base + "/");
  for (const [k, v] of Object.entries(query ?? {}))
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const headers = { accept: "application/json", ...extra };
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
    throw new CliError(
      "auth_refused",
      EXIT.auth,
      `${c.site} refused the token (${r.status}${/^(unknown|expired|scope|blocked)$/.test(detail) ? `: ${detail}` : ""})`,
      detail === "scope" ? SCOPE_HINT : LOGIN_HINT,
    );
  // The FSRS router answers a missing card with a 500 "Error: note not found".
  if (r.status === 404 || /note not found/i.test(detail))
    throw new CliError("not_found", EXIT.notFound, detail && !/^404$/.test(detail) ? detail : "not found");
  if (r.status === 429) {
    // Passed on as is: how long the server asked us to wait (seconds), if it said.
    const wait = Number(r.headers?.get?.("retry-after"));
    const e = new CliError(
      "rate_limited",
      EXIT.refused,
      `${c.site} refused it (429: too many requests)${wait > 0 ? `; retry after ${wait} s` : ""}`,
    );
    e.retryAfter = wait > 0 ? wait : null;
    throw e;
  }
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
  const { argv, deps, site } = c;
  const cfg = deps.config.read();
  const meta = cfg.sites[site];
  // `--token` names the token to revoke. LIANKI_TOKEN alone is not revoked:
  // it may be shared with other scripts, so that takes an explicit --token.
  const given = typeof argv.token === "string" && argv.token.trim() ? (await currentToken(c)).token : null;
  const legacy = deps.config.legacyToken?.(site) ?? null;
  const token = given ?? (meta ? await deps.store.get(site, meta) : legacy);
  if (!given && !meta && !token) {
    if (deps.env.LIANKI_TOKEN)
      throw usage(
        "nothing is stored; LIANKI_TOKEN is set and is not revoked by logout",
        'lianki auth logout --token "$LIANKI_TOKEN"   (revokes it), or unset LIANKI_TOKEN',
      );
    return emit(c, "auth logout", { site, revoked: false, forgotten: false }, () => "not signed in");
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
  const storedHere = meta && (!given || token === (await deps.store.get(site, meta)));
  if (storedHere) {
    await deps.store.delete(site);
    delete cfg.sites[site];
    deps.config.write(cfg);
  }
  const legacyDropped = Boolean(legacy && (!given || given === legacy) && deps.config.dropLegacy?.());
  emit(c, "auth logout", { site, revoked, forgotten: Boolean(storedHere || legacyDropped) }, (d) =>
    d.revoked
      ? "signed out: the token is revoked and forgotten"
      : "signed out here, but the server could not revoke the token — delete it in lianki.com/my/preferences → API Tokens",
  );
  if (!revoked) return EXIT.server;
}

// ── settings ──────────────────────────────────────────────────────────────

function checkKey(key) {
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(key))
    throw usage(`"${key}" is not a setting name`, "lianki settings list   (shows every key)");
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
  const keys = [...new Set([...PREF_KEYS, ...Object.keys(prefs)])];
  const settings = Object.fromEntries(keys.map((k) => [k, k in prefs ? prefs[k].value : null]));
  emit(c, "settings list", { settings }, (d) =>
    Object.entries(d.settings).map(([k, v]) => `${k} = ${v === null ? "(not set)" : JSON.stringify(v)}`).join("\n"),
  );
}

async function cmdSettingsGet(c) {
  checkKey(c.argv.key);
  const token = await needToken(c);
  const prefs = await readPrefs(c, token);
  if (!(c.argv.key in prefs) && !PREF_KEYS.includes(c.argv.key))
    throw new CliError("not_found", EXIT.notFound, `no setting "${c.argv.key}"`, "lianki settings list");
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

// ── chat ──────────────────────────────────────────────────────────────────
//
// Your own chat thread only (your Learning Partner's; the owner's thread for
// the owner), with a token that has the chat permissions (lianki.com/my/preferences
// → API tokens). Lines carry the token's name as 【name】. No eval, no pairing:
// the server has nothing of the kind for a token. Only your tap on lianki.com
// answers an ask card.

export const CHAT_PATH = "/api/version/chat";
const DEFAULT_WAIT = "10m";

/** "90s", "10m", "2h", or a number of seconds → ms; null when it is none of those. */
export function parseDuration(raw) {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(String(raw).trim());
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1000);
  return n > 0 && n <= 7 * 24 * 3_600_000 ? n : null;
}

/** The ask as the server takes it: one question (--q, --opt…; --recommend n marks option n). */
export function askBody(argv) {
  const q = typeof argv.q === "string" ? argv.q.trim() : "";
  if (!q) throw usage("ask needs --q \"the question\"", 'lianki chat ask --q "Ship it?" --opt Yes --opt No');
  const opts = (Array.isArray(argv.opt) ? argv.opt : argv.opt === undefined ? [] : [argv.opt]).map(String);
  if (opts.length < 1 || opts.length > 8) throw usage("ask needs 1–8 --opt");
  const rec = argv.recommend === undefined ? 0 : Number(argv.recommend);
  if (!Number.isInteger(rec) || rec < 0 || rec > opts.length) throw usage(`--recommend must be 1–${opts.length}`);
  return {
    question: q,
    options: opts.map((label, i) => ({ label, ...(rec === i + 1 ? { recommended: true } : {}) })),
    ...(argv.multi ? { multi: true } : {}),
  };
}

const wsUrl = (c) => {
  const u = new URL(CHAT_PATH, c.base + "/");
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
};

/**
 * One chat socket: authenticated with the token in its first message (never
 * the URL). `onEvent` gets each event; resolves when it returns true, or
 * rejects on a refusal, a close or the timeout.
 */
function chatSocket(c, token, { history = 0, onReady, onEvent, timeoutMs }) {
  const WS = c.deps.WebSocket ?? globalThis.WebSocket;
  if (!WS)
    throw new CliError("usage", EXIT.usage, "this needs a WebSocket: Node.js 22 or newer, or Bun", "bunx lianki …");
  return new Promise((resolve, reject) => {
    let done = false;
    let ws;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close(1000);
      } catch {}
      if (err) reject(err);
      else resolve(value);
    };
    const timer = timeoutMs ? setTimeout(() => finish(new CliError("timeout", EXIT.server, "timed out waiting")), timeoutMs) : null;
    try {
      ws = new WS(wsUrl(c));
    } catch (e) {
      return finish(new CliError("network", EXIT.server, `cannot reach ${c.site}: ${e?.message ?? e}`));
    }
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token, ...(history ? { history } : {}) }));
    ws.onmessage = async (ev) => {
      let m;
      try {
        m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (m.type === "ready") {
        try {
          if (onReady) await onReady(ws, m);
        } catch (e) {
          return finish(e);
        }
      }
      if (m.type === "error" && !m.retryAfterMs && /^(unknown|expired|scope|blocked)$/.test(m.error))
        return finish(
          new CliError("auth_refused", EXIT.auth, `${c.site} refused the token (${m.error})`, m.error === "scope" ? SCOPE_HINT : LOGIN_HINT),
        );
      if (m.type === "error" && m.error === "rate")
        return finish(new CliError("refused", EXIT.refused, `${c.site} refused it: rate limit for this token`));
      if (m.type === "revoked" || m.type === "expired")
        return finish(new CliError("auth_refused", EXIT.auth, `the token was ${m.type === "revoked" ? "revoked" : "expired"}`, LOGIN_HINT));
      try {
        if (onEvent && (await onEvent(m))) finish(null, m);
      } catch (e) {
        finish(e);
      }
    };
    ws.onerror = () => {};
    ws.onclose = (ev) =>
      finish(
        ev?.code === 4401
          ? new CliError("auth_refused", EXIT.auth, `${c.site} refused the token${ev.reason ? ` (${ev.reason})` : ""}`, LOGIN_HINT)
          : new CliError("network", EXIT.server, `the chat socket closed (${ev?.code ?? "?"}${ev?.reason ? ` ${ev.reason}` : ""})`),
      );
  });
}

async function cmdChatSay(c) {
  const token = await needToken(c);
  const parts = (c.argv.text ?? []).map(String);
  if (c.argv.stdin && parts.length > 0) throw usage("say takes its text or - (stdin), not both", 'lianki chat say "PR #12 is green"');
  const text = c.argv.stdin ? (await c.deps.readStdin()).trim() : parts.join(" ").trim();
  if (!text) throw usage("say needs text (or - to read it from stdin)", 'lianki chat say "PR #12 is green"');
  const { data } = await call(c, token, {
    method: "POST",
    path: CHAT_PATH,
    body: { op: "say", text, ...(c.argv.quiet ? { quiet: true } : {}), ...(c.argv.voice ? { voice: String(c.argv.voice) } : {}) },
  });
  emit(c, "chat say", { id: data.id, lane: data.lane ?? null }, (d) => `sent ${d.id}${d.lane ? ` as 【${d.lane}】` : ""}`);
}

async function cmdChatAsk(c) {
  const body = askBody(c.argv);
  const token = await needToken(c);
  if (!c.argv.wait) {
    const { data } = await call(c, token, { method: "POST", path: CHAT_PATH, body: { op: "ask", ...body } });
    return emit(c, "chat ask", { id: data.id, askId: data.askId, lane: data.lane ?? null, answer: null }, (d) => `asked ${d.askId}`);
  }
  const wait = parseDuration(c.argv.timeout ?? DEFAULT_WAIT);
  if (!wait) throw usage("--timeout is like 90s, 10m or 2h");
  let asked = null;
  const answered = await chatSocket(c, token, {
    timeoutMs: wait,
    onReady: (ws) => ws.send(JSON.stringify({ type: "ask", ...body })),
    onEvent: (m) => {
      if (m.type === "asked") asked = m;
      if (m.type === "error" && !asked) throw new CliError("refused", EXIT.refused, `${c.site} refused it: ${m.error}`);
      return m.type === "answered" && asked && m.askId === asked.askId;
    },
  });
  const labels = answered.labels ?? {};
  emit(
    c,
    "chat ask",
    { id: asked.id, askId: asked.askId, answer: { choices: answered.answer?.choices ?? {}, labels, at: answered.answer?.at ?? null } },
    (d) => Object.values(d.answer.labels).flat().join(", "),
  );
}

async function cmdChatRead(c) {
  const token = await needToken(c);
  const limit = Number(c.argv.limit ?? 30);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw usage("--limit must be 1–100");
  const { data } = await call(c, token, { method: "POST", path: CHAT_PATH, body: { op: "read", limit } });
  const messages = Array.isArray(data.messages) ? data.messages : [];
  emit(c, "chat read", { thread: data.thread ?? null, lane: data.lane ?? null, messages }, (d) =>
    d.messages.length ? d.messages.map(chatLine).join("\n") : "no messages",
  );
}

async function cmdChatPrepare(c) {
  const token = await needToken(c);
  const text = (c.argv.text ?? []).map(String).join(" ").trim();
  if (!text || text.length > 6000) throw usage("prepare needs 1–6000 characters");
  const { data } = await call(c, token, { method: "POST", path: CHAT_PATH, body: { op: "prepare", input: { v: 1, requestId: randomId(), text, context: c.argv.context ? [{ from: "user", text: String(c.argv.context).slice(0, 2000) }] : [] } } });
  emit(c, "chat prepare", data, (d) => JSON.stringify(d));
}

const chatLine = (m) =>
  `${new Date(m.at).toISOString().slice(0, 19).replace("T", " ")}  ${m.from === "agent" ? m.label || "agent" : m.from}: ${m.text}`;

async function cmdChatListen(c) {
  if (c.argv.deliver || c.argv["filter-service"] || c.argv["dry-run"]) return cmdChatBridge(c);
  const token = await needToken(c);
  const history = Number(c.argv.history ?? 0);
  if (!Number.isInteger(history) || history < 0 || history > 100) throw usage("--history must be 0–100");
  // One JSON line an event, as it comes; stops on Ctrl-C, a revoke or an expiry.
  await chatSocket(c, token, {
    history,
    onEvent: (m) => {
      if (m.type === "history") for (const x of m.messages ?? []) c.deps.out(c.json ? JSON.stringify({ type: "chat", message: x, history: true }) : chatLine(x));
      else if (m.type === "chat") c.deps.out(c.json ? JSON.stringify(m) : chatLine(m.message));
      else if (c.json || m.type === "answered") c.deps.out(JSON.stringify(m));
      return false;
    },
  });
}

async function cmdChatBridge(c) {
  const grantReply = c.argv["reply-transport"] === "grant";
  if (c.argv.stdin && c.argv.thread === "own") throw usage("--thread needs a concrete server thread id; own is only an authenticated socket alias");
  const friends = Boolean(c.argv.friends);
  if (friends && c.argv.thread) throw usage("--friends and --thread are mutually exclusive");
  if ((friends || grantReply) && (!c.argv.stdin || !c.argv["grant-repo"]))
    throw usage("friend/grant delivery requires trusted --stdin and --grant-repo <checkout>");
  if ((friends || (c.argv.thread && c.argv.thread !== "owner")) && !grantReply)
    throw usage("non-owner stdin needs --reply-transport grant; an account token cannot reply to another thread");
  if (friends && c.argv.polish) throw usage("--polish is owner-only; friends receive suggestions without history edits");
  if (c.argv.thread && !c.argv.stdin) throw usage("--thread applies only to trusted --stdin input; a direct socket uses the authenticated thread");
  if (c.argv.polish && (!c.argv.stdin || !c.argv["grant-repo"] || (c.argv.thread && c.argv.thread !== "owner")))
    throw usage("--polish requires trusted owner --stdin and --grant-repo <checkout>; API tokens cannot edit chat messages");
  const target = c.argv.deliver;
  if (!target && !c.argv["dry-run"]) throw usage("bridge needs --deliver <ay target> or --dry-run");
  const service = c.argv["filter-service"];
  if (service) {
    const u = new URL(service);
    if (u.username || u.password || u.search || u.hash || !/^https?:$/.test(u.protocol) ||
      (u.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
      throw usage("--filter-service must be HTTPS or loopback HTTP, without credentials or query");
  }
  const jobs = new Set();
  let failed;
  let stopInput;
  const controller = new AbortController();
  let signalFailure;
  const failure = new Promise((resolve) => { signalFailure = resolve; });
  const config = bridgeConfig(c.deps.env);
  const history = Number(c.argv.history ?? config.contextLines);
  if (!Number.isInteger(history) || history < 0 || history > 100) throw usage("--history must be 0–100");
  let accountToken;
  const makeReceiver = (thread) => {
  const bridge = createChatBridge({
    api: c.base,
    config,
    thread,
    principal: grantReply && thread !== "owner" ? { type: "friend", thread, authority: "friend-chat-only" } : undefined,
    replyCommand: grantReply ? () => ["bun", join(c.argv["grant-repo"], "scripts/dev/eval.ts"), "say", "--no-pair", "--to", thread, "<reply>"] : undefined,
    addressed: (text) => /(?:codex|claude|小可|小克|linky|lianki|帮我|请你|帮忙|修复|实现|部署|提交|合并|检查|继续|撤销|停止|重试|please|could you|can you)/iu.test(text),
    deliver: async (body) => {
      if (c.argv["dry-run"]) return c.deps.out(body);
      if (controller.signal.aborted) throw new Error("chat delivery stopped");
      let timer;
      let onAbort = () => {};
      try {
        return await Promise.race([
          (c.deps.deliver ?? ayDeliver)(String(target), c.argv.cwd, body, { signal: controller.signal }),
          new Promise((_, reject) => {
            onAbort = () => reject(new Error("chat delivery stopped"));
            controller.signal.addEventListener("abort", onAbort, { once: true });
            timer = setTimeout(() => reject(new Error("chat delivery timed out")), config.deliveryTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
    report: (data) => c.deps.err(JSON.stringify(data)),
  });
  const receiver = createChatReceiver({
    bridge, thread, lockScope: Boolean(c.argv.stdin), config: turnConfig(c.deps.env), requestId: () => randomId(),
    report: (data) => c.deps.err(JSON.stringify(data)),
    onError: (e) => { failed ??= e; signalFailure(e); controller.abort(); stopInput?.(); },
    polish: c.argv.polish && !c.argv["dry-run"] ? (turn, suggestion) => applyGrantPolish(c.argv["grant-repo"], turn, suggestion, { signal: controller.signal }) : undefined,
    prepare: c.argv.ai === "off" ? undefined : async (input) => {
      if (service) return filterDecision(service, { v: 1, message: { text: input.text.slice(0, config.lineChars), source: "stt" }, context: input.context }, {
        fetch: c.deps.fetch, token: c.deps.env.LIANKI_CHAT_FILTER_TOKEN, timeoutMs: config.timeoutMs,
      });
      let signal;
      try {
        accountToken ??= await needToken(c);
        signal = AbortSignal.timeout(config.timeoutMs);
        const res = await c.deps.fetch(`${c.base}${CHAT_PATH}`, {
          method: "POST", headers: { authorization: `Bearer ${accountToken}`, "content-type": "application/json" },
          body: JSON.stringify({ op: "prepare", input }), signal,
        });
        if (!res.ok) {
          c.deps.err(JSON.stringify({ type: "prepare-unavailable", reason: "prepare-http", status: res.status }));
          return { action: "forward", turn: "uncertain", reason: "unavailable" };
        }
        const result = await res.json();
        if (result?.ok && result.verdict?.v === 1) return result.verdict;
        c.deps.err(JSON.stringify({ type: "prepare-unavailable", reason: result?.error ?? "server", ...(Number.isInteger(result?.status) ? { status: result.status } : {}) }));
      } catch (e) {
        c.deps.err(JSON.stringify({ type: "prepare-unavailable", reason: signal?.aborted ? "prepare-timeout" : e instanceof SyntaxError ? "prepare-invalid-json" : "network-or-auth" }));
      }
      return { action: "forward", turn: "uncertain", reason: "unavailable" };
    },
  });
  return receiver;
  };
  const inboxConfig = Object.fromEntries(Object.entries(INBOX_DEFAULTS).map(([key, fallback]) => {
    const value = Number(c.deps.env[`LIANKI_CHAT_INBOX_${key.replace(/[A-Z]/g, (s) => `_${s}`).toUpperCase()}`]);
    return [key, Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback];
  }));
  const receiver = friends ? createFriendInbox({ createReceiver: makeReceiver, config: inboxConfig }) : makeReceiver(c.argv.thread ?? "owner");
  const accept = (event) => {
    const job = receiver.accept(event);
    jobs.add(job);
    void job.then(() => jobs.delete(job), (e) => {
      jobs.delete(job);
      failed ??= e;
      signalFailure(e);
      controller.abort();
      stopInput?.();
    });
    return job;
  };
  try {
    if (c.argv.stdin) {
      // Stream rather than readStdin(): voice messages must reach the agent before EOF.
      const input = c.deps.bridgeInput ?? process.stdin;
      const lines = createInterface({ input, crlfDelay: Infinity });
      stopInput = () => lines.close();
      for await (const line of lines) {
        if (failed) throw failed;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        accept(event);
      }
    } else {
      const token = await needToken(c);
      await chatSocket(c, token, { history, onEvent: async (m) => {
        if (failed) throw failed;
        await accept(m);
        return false;
      } });
    }
  } catch (e) {
    failed ??= e;
  } finally {
    if (!failed) await Promise.race([Promise.allSettled(jobs), failure]);
    if (!failed) await Promise.race([receiver.finish(), failure]);
    receiver.stop();
    controller.abort();
  }
  if (failed) throw failed;
}

// ── mcp ───────────────────────────────────────────────────────────────────

/** `lianki mcp`: the local MCP server (mcp.mjs), loaded only for this command. */
async function cmdMcp(c) {
  const { serveMcp } = await import("./mcp.mjs");
  await serveMcp(c);
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
                  ["lianki auth login --token - < token.txt", "store a token made in lianki.com/my/preferences → API Tokens"],
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
    .command("chat", "Your own chat thread: send, say, ask, read, listen, bridge", (y) =>
      examples(
        sub(y)
          .usage("lianki chat <send|say|ask|read|listen|bridge> — your own chat thread only; lines show the token's name")
          .command(
            ["say [text..]", "send [text..]"],
            "Post a line (- reads it from stdin)",
            (y) =>
              examples(
                y
                  .positional("text", { type: "string", describe: "The line" })
                  .option("quiet", { type: "boolean", describe: "Shown, never read aloud" })
                  .option("voice", { type: "string", describe: "Read this line in another voice: main | calm | bright, device:<name>, melo:<lang>" })
                  .option("stdin", { type: "boolean", hidden: true }),
                [
                  ['lianki chat say "PR #12 is green"', "→ 【<token name>】PR #12 is green"],
                  ['lianki chat say --voice main "hi"', "read in main's voice instead of the lane's"],
                  ["git log -1 --format=%s | lianki chat say -", ""],
                ],
              ),
            act(cmdChatSay),
          )
          .command(
            "ask",
            "Post an ask card; only your tap on lianki.com answers it",
            (y) =>
              examples(
                y
                  .option("q", { type: "string", describe: "The question" })
                  .option("opt", { type: "string", array: true, describe: "An option (1–8; repeat)" })
                  .option("recommend", { type: "number", describe: "Mark option n as recommended" })
                  .option("multi", { type: "boolean", describe: "More than one option may be picked" })
                  .option("wait", { type: "boolean", describe: "Wait for the tap and print the answer" })
                  .option("timeout", { type: "string", describe: `How long --wait waits (default ${DEFAULT_WAIT})` }),
                [['lianki chat ask --q "Ship it?" --opt Yes --opt No --recommend 1 --wait', "prints the option tapped"]],
              ),
            act(cmdChatAsk),
          )
          .command(
            "read",
            "The latest lines",
            (y) => examples(y.option("limit", { type: "number", default: 30, describe: "How many (1–100)" }), [["lianki chat read --limit 10 --json", ""]]),
            act(cmdChatRead),
          )
          .command(
            "listen",
            "Follow the thread live (one JSON line an event with --json)",
            (y) =>
              examples(y.option("history", { type: "number", default: 0, describe: "First print the last n lines (0–100; memory only with --deliver)" })
                .option("deliver", { type: "string", describe: "Optionally bridge to this ay agent target" })
                .option("cwd", { type: "string", describe: "Agent directory for ay target ." })
                .option("filter-service", { type: "string", describe: "Optional AI filter URL for --deliver" })
                .option("ai", { choices: ["cloud", "off"], default: "cloud", describe: "Turn preparation via the existing account's Cloudflare AI service" })
                .option("dry-run", { type: "boolean", describe: "Print bridge handoffs without delivering" }), [
                ["lianki chat listen --json | jq -c 'select(.type==\"chat\")'", "every new line"],
              ]),
            act(cmdChatListen),
          )
          .command(
            "prepare [text..]",
            "Classify, join and polish a turn using the account's cloud AI credits; posts nothing",
            (y) => y.positional("text", { type: "string" }).option("context", { type: "string", describe: "Optional prior utterance" }),
            act(cmdChatPrepare),
          )
          .command(
            "bridge",
            "Compose live chat, optional AI filtering and delivery to a Codex/Claude agent via ay",
            (y) => y
              .option("deliver", { type: "string", describe: "ay target (PID, keyword or .); no fixed agent" })
              .option("cwd", { type: "string", describe: "Agent working directory for ay target ." })
              .option("stdin", { type: "boolean", describe: "Read listen/eval NDJSON instead of opening a socket" })
              .option("thread", { type: "string", describe: "Trusted input thread for --stdin (default owner; socket derives it from auth)" })
              .option("history", { type: "number", describe: "Recent lines used as memory only (0–100)" })
              .option("polish", { type: "boolean", describe: "Opt in to guarded owner-grant edit/merge via --stdin; retains raw/undo" })
              .option("grant-repo", { type: "string", describe: "Checkout with the existing owner chat grant and eval.ts" })
              .option("reply-transport", { choices: ["own", "grant"], default: "own", describe: "Own-account chat send or explicitly authorized grant reply transport" })
              .option("friends", { type: "boolean", describe: "Multiplex friend threads from trusted grant stdin; excludes owner" })
              .option("filter-service", { type: "string", describe: "Optional v1 filter service URL; failures forward" })
              .option("ai", { choices: ["cloud", "off"], default: "cloud", describe: "Cloud turn preparation or bounded raw assembly only" })
              .option("dry-run", { type: "boolean", describe: "Print handoffs without delivering or replying" }),
            act(cmdChatBridge),
          )
          .epilogue(
            "Needs a token with the chat permissions (lianki.com/my/preferences → API tokens). An agent lane uses its own token: LIANKI_TOKEN=lk_… lianki chat say …",
          ),
        [['lianki chat say "hello"', ""]],
      ),
    )
    .command(
      "mcp",
      "Run a local MCP server for your AI app (stdio)",
      (y) =>
        examples(
          y.epilogue(
            "Tools for your cards and chat, only those the token allows; no deletes. Uses the token from `lianki auth login` (or LIANKI_TOKEN). stdout is the protocol; messages go to stderr.",
          ),
          [
            ["claude mcp add lianki -- npx -y lianki mcp", "Claude Code"],
            ['{"mcpServers": {"lianki": {"command": "npx", "args": ["-y", "lianki", "mcp"]}}}', "Claude Desktop, Cursor"],
          ],
        ),
      act(cmdMcp),
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
  // yargs drops a bare `-` before any command sees it: `--token -` means
  // "from stdin", and `say -` (`say --quiet -`) becomes `say --stdin`.
  args = args.flatMap((a, i) =>
    a === "-" && args[i - 1] === "--token"
      ? []
      : a === "--token" && args[i + 1] === "-"
        ? ["--token=-"]
        : a === "-" && (args[i - 1] === "say" || args[i - 1] === "send" || args[i - 1] === "--quiet")
          ? ["--stdin"]
          : [a],
  );
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

/**
 * `lianki auth` and `lianki settings` (docs/secrets-and-auth.md, "CLI login").
 *
 *   lianki auth login                 browser: approve on lianki.com/cli-login
 *   lianki auth login --token -       paste mode: read an lk_ token from stdin
 *   lianki auth login --token lk_…    (or LIANKI_TOKEN=lk_… lianki auth login)
 *   lianki auth status                who, where it is stored, still valid?
 *   lianki auth logout                revoke the token on the server, forget it
 *
 *   lianki settings list              every synced preference and its value
 *   lianki settings get <key>
 *   lianki settings set <key> <value> value as JSON (true, 1.25, ["/words"]) or a bare word
 *
 * The browser login never puts the token in a URL: the page sends a one-time
 * code to this CLI's 127.0.0.1 listener, and the CLI trades it, with its PKCE
 * verifier, for the token in a response body (lib/cli-login.ts).
 *
 * The token goes to the macOS Keychain (service `lianki-cli`, account = the
 * site's host), written through `security -i` on stdin so it never appears in
 * a process list; elsewhere, or if the Keychain refuses, to
 * ~/.config/lianki/cli.json with mode 0600. It is never printed or logged.
 * LIANKI_TOKEN, when set, is used instead of the stored token. LIANKI_URL
 * points the CLI at another site (default https://lianki.com).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomId, s256, sameString } from "@/lib/cli-login";
import { checkPref, isPrefKey, PREF_KEYS, type PrefHlc } from "@/lib/prefs/schema";

export const AUTH_USAGE = `usage: lianki auth <login [--token lk_…|-]|status|logout>
       lianki settings <list|get <key>|set <key> <value>>`;

export const TOKEN_RE = /^lk_[0-9a-f]{64}$/;

// ── Storage ───────────────────────────────────────────────────────────────

/** What is kept per site besides the token. Never the token itself, unless storage is "file". */
export type SiteMeta = {
  storage: "keychain" | "file";
  email?: string;
  user?: string;
  name?: string;
  tokenId?: string;
  token?: string;
};
export type CliConfig = { deviceId?: string; sites: Record<string, SiteMeta> };

export interface TokenStore {
  /** Store the token; says where it went. */
  set(site: string, token: string): Promise<"keychain" | "file">;
  get(site: string, meta: SiteMeta | undefined): Promise<string | null>;
  delete(site: string): Promise<void>;
}

export const configPath = () =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "lianki", "cli.json");

export function readConfig(path = configPath()): CliConfig {
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as CliConfig;
    return { deviceId: c.deviceId, sites: c.sites ?? {} };
  } catch {
    return { sites: {} };
  }
}

export function writeConfig(c: CliConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

// ── Wiring ────────────────────────────────────────────────────────────────

export type AuthDeps = {
  base: string;
  fetch: typeof fetch;
  store: TokenStore;
  config: { read(): CliConfig; write(c: CliConfig): void };
  out: (s: string) => void;
  err: (s: string) => void;
  openUrl: (url: string) => void | Promise<void>;
  hostname: string;
  env: Record<string, string | undefined>;
  readStdin: () => Promise<string>;
  timeoutMs: number;
};

const siteOf = (base: string) => new URL(base).host;

async function currentToken(d: AuthDeps): Promise<{ token: string | null; from: string }> {
  const env = d.env.LIANKI_TOKEN?.trim();
  if (env) return { token: TOKEN_RE.test(env) ? env : null, from: "LIANKI_TOKEN" };
  const site = siteOf(d.base);
  const meta = d.config.read().sites[site];
  if (!meta) return { token: null, from: "none" };
  return {
    token: await d.store.get(site, meta),
    from: meta.storage === "file" ? configPath() : "Keychain",
  };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function saveLogin(
  d: AuthDeps,
  token: string,
  info: { email?: string; user?: string; name?: string; tokenId?: string },
): Promise<string> {
  const site = siteOf(d.base);
  const where = await d.store.set(site, token);
  const c = d.config.read();
  c.sites[site] = { storage: where, ...info, ...(where === "file" ? { token } : {}) };
  d.config.write(c);
  return where === "keychain" ? "the macOS Keychain" : `${configPath()} (mode 0600)`;
}

// ── Browser login ─────────────────────────────────────────────────────────

const PAGE = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>lianki CLI</title><body style="font:16px system-ui;padding:2em">${msg}</body>`;

type Callback = { ok: true; code: string } | { ok: false; error: string };

/** The 127.0.0.1 listener: waits for /cb with our state. A wrong state is refused, and it keeps waiting. */
export function listen(state: string, timeoutMs: number) {
  let settle!: (c: Callback) => void;
  const done = new Promise<Callback>((r) => (settle = r));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/cb") return new Response("not found", { status: 404 });
      const got = u.searchParams.get("state") ?? "";
      if (!sameString(got, state))
        return new Response(PAGE("This sign-in does not match the terminal's. Ignored."), {
          status: 400,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      const error = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      if (error || !code) {
        settle({
          ok: false,
          error: error === "access_denied" ? "denied in the browser" : "no code",
        });
        return new Response(PAGE("Denied. Nothing was created; you can close this tab."), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      settle({ ok: true, code });
      return new Response(PAGE("Signed in. Return to your terminal; you can close this tab."), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  const timer = setTimeout(() => settle({ ok: false, error: "timed out" }), timeoutMs);
  return {
    redirectUri: `http://127.0.0.1:${server.port}/cb`,
    done: done.finally(() => {
      clearTimeout(timer);
      // Let the browser get its page before the socket closes.
      setTimeout(() => server.stop(true), 200);
    }),
  };
}

export async function browserLogin(d: AuthDeps): Promise<number> {
  const verifier = randomId(48);
  const state = randomId(24);
  const l = listen(state, d.timeoutMs);
  const url = new URL("/cli-login", d.base);
  url.searchParams.set("redirect_uri", l.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("host", d.hostname);
  d.out(`Opening ${url.origin}/cli-login in your browser. Approve there to sign in.`);
  d.out(`If it does not open, visit:\n  ${url.toString()}`);
  await d.openUrl(url.toString());

  const cb = await l.done;
  if (!cb.ok) {
    d.err(`lianki auth login: ${cb.error}`);
    return 1;
  }
  const r = await d.fetch(new URL("/api/cli-login/token", d.base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: cb.code, code_verifier: verifier, redirect_uri: l.redirectUri }),
  });
  const j = (await r.json().catch(() => ({}))) as {
    token?: string;
    id?: string;
    name?: string;
    email?: string;
    error?: string;
  };
  if (!r.ok || !j.token || !TOKEN_RE.test(j.token)) {
    d.err(`lianki auth login: the exchange failed (${r.status}${j.error ? ` ${j.error}` : ""})`);
    return 1;
  }
  const where = await saveLogin(d, j.token, { email: j.email, name: j.name, tokenId: j.id });
  d.out(`Signed in as ${j.email} — token "${j.name}", stored in ${where}.`);
  return 0;
}

// ── Paste login, status, logout ───────────────────────────────────────────

async function whoIs(d: AuthDeps, token: string): Promise<{ status: number; user?: string }> {
  const r = await d.fetch(new URL("/api/prefs", d.base), { headers: bearer(token) });
  const j = (await r.json().catch(() => ({}))) as { user?: string };
  return { status: r.status, user: j.user };
}

export async function pasteLogin(d: AuthDeps, given: string): Promise<number> {
  const token = (given === "-" ? await d.readStdin() : given).trim();
  if (!TOKEN_RE.test(token)) {
    d.err("lianki auth login: that is not a Lianki API token (lk_ and 64 hex digits).");
    return 1;
  }
  const who = await whoIs(d, token);
  if (who.status !== 200) {
    d.err(`lianki auth login: ${d.base} refused the token (${who.status}).`);
    return 1;
  }
  const where = await saveLogin(d, token, { user: who.user });
  d.out(`Signed in (user ${who.user}), token stored in ${where}.`);
  return 0;
}

export async function status(d: AuthDeps): Promise<number> {
  const site = siteOf(d.base);
  const meta = d.config.read().sites[site];
  const { token, from } = await currentToken(d);
  if (!token) {
    d.out(
      from === "LIANKI_TOKEN"
        ? "LIANKI_TOKEN is set but is not an lk_ token."
        : `Not signed in to ${site}. Run: lianki auth login`,
    );
    return 1;
  }
  const who = await whoIs(d, token);
  const account = meta?.email ?? (who.user ? `user ${who.user}` : "unknown account");
  d.out(`${site}: ${from === "LIANKI_TOKEN" ? "LIANKI_TOKEN" : account}`);
  if (meta?.name && from !== "LIANKI_TOKEN") d.out(`token: "${meta.name}", stored in ${from}`);
  d.out(who.status === 200 ? "the server accepts it" : `the server refused it (${who.status})`);
  return who.status === 200 ? 0 : 1;
}

export async function logout(d: AuthDeps): Promise<number> {
  const site = siteOf(d.base);
  const c = d.config.read();
  const meta = c.sites[site];
  if (!meta) {
    d.out(
      d.env.LIANKI_TOKEN
        ? "Nothing stored. LIANKI_TOKEN is set: unset it, and delete that token on the profile page."
        : "Not signed in.",
    );
    return 0;
  }
  const token = await d.store.get(site, meta);
  let revoked = false;
  if (token) {
    const r = await d
      .fetch(new URL("/api/cli-login/token", d.base), { method: "DELETE", headers: bearer(token) })
      .catch(() => null);
    revoked = r?.status === 200 || r?.status === 404;
  }
  await d.store.delete(site);
  delete c.sites[site];
  d.config.write(c);
  d.out(
    revoked
      ? "Signed out: the token is revoked and forgotten."
      : "Signed out locally, but the server could not revoke the token — delete it on the profile page.",
  );
  return revoked ? 0 : 1;
}

// ── Settings ──────────────────────────────────────────────────────────────

type PrefRows = Record<string, { value: unknown; hlc: PrefHlc }>;

async function needToken(d: AuthDeps): Promise<string | null> {
  const { token } = await currentToken(d);
  if (!token) d.err("Not signed in. Run: lianki auth login");
  return token;
}

async function readPrefs(d: AuthDeps, token: string): Promise<PrefRows | null> {
  const r = await d.fetch(new URL("/api/prefs", d.base), { headers: bearer(token) });
  if (r.status !== 200) {
    d.err(`lianki settings: the server answered ${r.status}`);
    return null;
  }
  return ((await r.json()) as { prefs: PrefRows }).prefs ?? {};
}

/** A command-line value for `key`: JSON first, else the bare word; checked by the registry. */
export function parseValue(key: string, raw: string): { ok: true; value: unknown } | { ok: false } {
  const tries: unknown[] = [];
  try {
    tries.push(JSON.parse(raw));
  } catch {}
  tries.push(raw);
  for (const t of tries) {
    const v = checkPref(key, t);
    if (v !== undefined) return { ok: true, value: v };
  }
  return { ok: false };
}

function deviceId(d: AuthDeps): string {
  const c = d.config.read();
  if (c.deviceId && /^[a-z0-9]{8,40}$/.test(c.deviceId)) return c.deviceId;
  c.deviceId = `cli${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  d.config.write(c);
  return c.deviceId;
}

/** A clock newer than the stored one, so the CLI's write wins (docs/prefs-sync.md). */
export function nextHlc(prev: PrefHlc | undefined, id: string, now = Date.now()): PrefHlc {
  if (prev && prev.timestamp >= now)
    return { timestamp: prev.timestamp, counter: prev.counter + 1, deviceId: id };
  return { timestamp: now, counter: 0, deviceId: id };
}

export async function settings(d: AuthDeps, args: string[]): Promise<number> {
  const [action, key, ...rest] = args;
  if (action === "get" || action === "set") {
    if (!key || !isPrefKey(key)) {
      d.err(`lianki settings: unknown key "${key ?? ""}". Keys: ${PREF_KEYS.join(", ")}`);
      return 2;
    }
  } else if (action !== "list") {
    d.err(AUTH_USAGE);
    return 2;
  }
  let parsed: { ok: true; value: unknown } | undefined;
  if (action === "set") {
    const p = parseValue(key!, rest.join(" "));
    if (!p.ok) {
      d.err(`lianki settings: "${rest.join(" ")}" is not a valid value for ${key}.`);
      return 2;
    }
    parsed = p;
  }
  const token = await needToken(d);
  if (!token) return 1;
  const prefs = await readPrefs(d, token);
  if (!prefs) return 1;

  if (action === "list") {
    for (const k of PREF_KEYS)
      d.out(`${k} = ${k in prefs ? JSON.stringify(prefs[k].value) : "(not set)"}`);
    return 0;
  }
  if (action === "get") {
    d.out(key! in prefs ? JSON.stringify(prefs[key!].value) : "(not set)");
    return 0;
  }
  const op = { key: key!, value: parsed!.value, hlc: nextHlc(prefs[key!]?.hlc, deviceId(d)) };
  const r = await d.fetch(new URL("/api/prefs", d.base), {
    method: "PATCH",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify({ ops: [op] }),
  });
  const j = (await r.json().catch(() => ({}))) as { prefs?: PrefRows; rejected?: string[] };
  if (r.status !== 200 || j.rejected?.includes(key!)) {
    d.err(`lianki settings: the server refused it (${r.status}).`);
    return 1;
  }
  const won = j.prefs?.[key!]?.value;
  d.out(`${key} = ${JSON.stringify(won ?? parsed!.value)}`);
  return 0;
}

// ── Entry ─────────────────────────────────────────────────────────────────

export async function authMain(argv: string[], deps?: AuthDeps): Promise<number> {
  // The real Keychain, browser and network: loaded only when run for real.
  const d = deps ?? (await import("./lianki-io")).defaultDeps();
  const [cmd, action, ...rest] = argv;
  if (cmd === "settings") return settings(d, argv.slice(1));
  if (cmd !== "auth") {
    d.err(AUTH_USAGE);
    return 2;
  }
  switch (action) {
    case "login": {
      const i = rest.indexOf("--token");
      const given = i >= 0 ? rest[i + 1] : d.env.LIANKI_TOKEN?.trim();
      if (i >= 0 && !given) {
        d.err("lianki auth login --token: give the token, or - to read it from stdin.");
        return 2;
      }
      return given ? pasteLogin(d, given) : browserLogin(d);
    }
    case "status":
      return status(d);
    case "logout":
      return logout(d);
    default:
      d.err(AUTH_USAGE);
      return 2;
  }
}

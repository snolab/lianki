// lianki CLI: where the token lives, and the browser login's moving parts.
//
// The token goes to the macOS Keychain (service `lianki-cli`, account = the
// site's host), written through `security -i` on stdin so it never appears in
// a process list. Elsewhere, or when the Keychain refuses, it goes to
// ~/.config/lianki/cli.json with mode 0600 (folder 0700). It is never printed.
//
// The browser login never puts the token in a URL: lianki.com/cli-login sends
// a one-time code to this CLI's 127.0.0.1 listener, and the CLI trades it,
// with its PKCE verifier, for the token in a response body
// (lib/cli-login.ts on the server, docs/secrets-and-auth.md "CLI login").

import { spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TOKEN_RE = /^lk_[0-9a-f]{64}$/;
export const DEVICE_RE = /^[a-z0-9]{8,40}$/;
const KEYCHAIN_SERVICE = "lianki-cli";

// ── PKCE and friends ──────────────────────────────────────────────────────

export const base64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomId = (bytes = 32) => base64url(randomBytes(bytes));
export const s256 = (verifier) => base64url(createHash("sha256").update(verifier).digest());
export function sameString(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** lianki.com and www.lianki.com are one site (www redirects to the apex). */
const apex = (host) => (host === "www.lianki.com" ? "lianki.com" : host);
export const sameSite = (a, b) => apex(a) === apex(b);

// ── Config file ───────────────────────────────────────────────────────────

const configDir = (env) => join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "lianki");
export const configPath = (env) => join(configDir(env), "cli.json");
/** 0.1.x kept `{ token, api }` here. Read as a fallback; removed on logout. */
export const legacyConfigPath = (env) => join(configDir(env), "config.json");

export function fileConfig(env) {
  const path = configPath(env);
  return {
    path,
    read() {
      try {
        const c = JSON.parse(readFileSync(path, "utf8"));
        return { deviceId: c.deviceId, sites: c.sites && typeof c.sites === "object" ? c.sites : {} };
      } catch {
        return { sites: {} };
      }
    },
    write(c) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
      chmodSync(path, 0o600);
    },
    /** 0.1.x's token, only for the site it was saved for (its `api`, default www.lianki.com). */
    legacyToken(site) {
      try {
        const c = JSON.parse(readFileSync(legacyConfigPath(env), "utf8"));
        const t = c.token;
        if (typeof t !== "string" || !TOKEN_RE.test(t)) return null;
        const host = new URL(typeof c.api === "string" ? c.api : "https://www.lianki.com").host;
        return sameSite(host, site) ? t : null;
      } catch {
        return null;
      }
    },
    dropLegacy() {
      const p = legacyConfigPath(env);
      if (!existsSync(p)) return false;
      rmSync(p);
      return true;
    },
  };
}

// ── Keychain (macOS only; the token only ever on `security`'s stdin) ──────

const SECURITY = "/usr/bin/security";
const ACCOUNT_RE = /^[A-Za-z0-9.:[\]-]+$/;

function runSecurity(args, input) {
  const r = spawnSync(SECURITY, args, {
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
  return { ok: r.status === 0, out: String(r.stdout ?? "") };
}

/** `sys` is for the tests: { platform, exists, run } stand in for the real Mac. */
export function keychain(env, sys = {}) {
  const platform = sys.platform ?? process.platform;
  const exists = sys.exists ?? existsSync;
  const security = sys.run ?? runSecurity;
  const available = () => platform === "darwin" && !env.LIANKI_NO_KEYCHAIN && exists(SECURITY);
  const get = (account) => {
    if (!available() || !ACCOUNT_RE.test(account)) return null;
    const r = security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]);
    const v = r.out.trim();
    return r.ok && TOKEN_RE.test(v) ? v : null;
  };
  return {
    available,
    get,
    set(account, token) {
      if (!available() || !TOKEN_RE.test(token) || !ACCOUNT_RE.test(account)) return false;
      security(
        ["-i"],
        `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "${account}" -w "${token}"\n`,
      );
      const back = get(account);
      return back !== null && sameString(back, token);
    },
    delete(account) {
      if (available() && ACCOUNT_RE.test(account))
        security(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]);
    },
  };
}

/** Keychain first; the 0600 config file when there is none or it refuses. */
export function tokenStore(env, sys) {
  const kc = keychain(env, sys);
  return {
    set: async (site, token) => (kc.set(site, token) ? "keychain" : "file"),
    async get(site, meta) {
      if (meta?.storage === "file")
        return typeof meta.token === "string" && TOKEN_RE.test(meta.token) ? meta.token : null;
      return kc.get(site);
    },
    delete: async (site) => kc.delete(site),
  };
}

// ── The 127.0.0.1 listener ────────────────────────────────────────────────

const PAGE = (msg) =>
  `<!doctype html><meta charset="utf-8"><title>lianki CLI</title>` +
  `<body style="font:16px system-ui;padding:2em">${msg}</body>`;

/**
 * Waits for GET /cb with our state. A wrong state is answered 400 and it keeps
 * waiting; anything else is 404. Resolves { ok, code } or { ok:false, error }.
 */
export function listen(state, timeoutMs) {
  return new Promise((resolveStart, rejectStart) => {
    let settle;
    const done = new Promise((r) => (settle = r));
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const send = (status, msg) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE(msg));
      };
      if (req.method !== "GET" || u.pathname !== "/cb") return send(404, "Not found.");
      if (!sameString(u.searchParams.get("state") ?? "", state))
        return send(400, "This sign-in does not match the terminal's. Ignored.");
      const error = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      if (error || !code) {
        settle({ ok: false, error: error === "access_denied" ? "denied in the browser" : "no code" });
        return send(200, "Denied. Nothing was created; you can close this tab.");
      }
      settle({ ok: true, code });
      send(200, "Signed in. Return to your terminal; you can close this tab.");
    });
    server.on("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const timer = setTimeout(() => settle({ ok: false, error: "timed out" }), timeoutMs);
      resolveStart({
        redirectUri: `http://127.0.0.1:${port}/cb`,
        done: done.finally(() => {
          clearTimeout(timer);
          // Let the browser get its page before the socket closes.
          setTimeout(() => server.close(), 200).unref();
          server.closeIdleConnections?.();
        }),
      });
    });
  });
}

// ── Opening the browser ───────────────────────────────────────────────────

export function openUrl(url, platform = process.platform, spawn = spawnSync) {
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const r = spawn(cmd, args, { stdio: "ignore", timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

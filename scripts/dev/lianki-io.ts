/**
 * The real I/O of `lianki auth` (scripts/dev/lianki-auth.ts): the macOS
 * Keychain, the browser, the network. Kept apart so the unit suites, which
 * pass fakes, never load it (it would touch the owner's Keychain).
 */
import { existsSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { sameString } from "@/lib/cli-login";
import { readConfig, TOKEN_RE, writeConfig, type AuthDeps, type TokenStore } from "./lianki-auth";

const KEYCHAIN_SERVICE = "lianki-cli";

const run = (cmd: string[], stdin?: string) => {
  const r = Bun.spawnSync(cmd, {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
};

/** The macOS Keychain, through /usr/bin/security; the token only ever on its stdin. */
export const keychain = {
  available: () => process.platform === "darwin" && existsSync("/usr/bin/security"),
  set(account: string, token: string): boolean {
    if (!TOKEN_RE.test(token) || !/^[A-Za-z0-9.:[\]-]+$/.test(account)) return false;
    run(
      ["/usr/bin/security", "-i"],
      `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "${account}" -w "${token}"\n`,
    );
    const back = keychain.get(account);
    return back !== null && sameString(back, token);
  },
  get(account: string): string | null {
    const r = run([
      "/usr/bin/security",
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account,
      "-w",
    ]);
    const v = r.out.trim();
    return r.ok && TOKEN_RE.test(v) ? v : null;
  },
  delete(account: string): void {
    run(["/usr/bin/security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]);
  },
};

/** Keychain first; the 0600 config file when there is none or it refuses. */
export const defaultStore: TokenStore = {
  async set(site, token) {
    return keychain.available() && keychain.set(site, token) ? "keychain" : "file";
  },
  async get(site, meta) {
    if (meta?.storage === "file")
      return meta.token && TOKEN_RE.test(meta.token) ? meta.token : null;
    return keychain.available() ? keychain.get(site) : null;
  },
  async delete(site) {
    if (keychain.available()) keychain.delete(site);
  },
};

export function defaultDeps(): AuthDeps {
  return {
    base: (process.env.LIANKI_URL || "https://lianki.com").replace(/\/+$/, ""),
    fetch: globalThis.fetch,
    store: defaultStore,
    config: { read: () => readConfig(), write: (c) => writeConfig(c) },
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    openUrl: (url) => {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
    },
    hostname: osHostname().replace(/\.local$/, ""),
    env: process.env,
    readStdin: async () => await new Response(Bun.stdin.stream()).text(),
    timeoutMs: 5 * 60_000,
  };
}

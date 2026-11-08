/**
 * The shared box tunnel's ingress (devbox/README.md, "One tunnel for every box"):
 * one rule per box env file in devbox/, `my-<hash|name>.lianki.com` -> that box's
 * dev port on the host loopback, and 404 for everything else. The wildcard
 * `*.lianki.com` CNAME sends every name without its own record here, so a host
 * that no env file names gets cloudflared's 404 and never reaches a box.
 *
 *   bun scripts/dev/boxes-ingress.ts <devbox dir> <tunnel id> <credentials file>
 *
 * Reads only DEVBOX_NAME, DEVBOX_DEV_PORT and DEVBOX_PUBLIC_URL from each file
 * (they also hold the DeepSeek key). Hosts go through the Worker's own rule
 * (isBoxHost, via boxHostOf), so a host lianki.com would refuse is never routed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { boxHostOf } from "./box-host";

export type BoxRoute = { file: string; name: string; host: string; port: number };

const KEYS = ["DEVBOX_NAME", "DEVBOX_DEV_PORT", "DEVBOX_PUBLIC_URL"] as const;

/** The three keys of one env file; the last line wins, as with compose. */
export function readBoxEnv(text: string): Partial<Record<(typeof KEYS)[number], string>> {
  const out: Partial<Record<(typeof KEYS)[number], string>> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m && (KEYS as readonly string[]).includes(m[1]))
      out[m[1] as (typeof KEYS)[number]] = m[2].trim();
  }
  return out;
}

/** A box env file's name: `.env` or `.env.<name>`, never the example. */
export const isBoxEnvFile = (f: string) =>
  f === ".env" || (/^\.env\.[a-z0-9-]+$/.test(f) && f !== ".env.example");

/**
 * Every routable box. A file with no public URL is a local-only box and is
 * skipped; a bad URL or port, or two files claiming one host or one port, is an
 * error: better no config than one that sends a host to the wrong box.
 */
export function boxRoutes(files: { file: string; text: string }[]): {
  routes: BoxRoute[];
  errors: string[];
} {
  const routes: BoxRoute[] = [];
  const errors: string[] = [];
  for (const { file, text } of files) {
    const env = readBoxEnv(text);
    if (!env.DEVBOX_PUBLIC_URL) continue;
    const host = boxHostOf(env.DEVBOX_PUBLIC_URL);
    if (!host) {
      errors.push(`${file}: DEVBOX_PUBLIC_URL is not https://my-<hash or name>.lianki.com`);
      continue;
    }
    const port = Number(env.DEVBOX_DEV_PORT ?? "3200");
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      errors.push(`${file}: DEVBOX_DEV_PORT is not a port`);
      continue;
    }
    const clash = routes.find((r) => r.host === host || r.port === port);
    if (clash) {
      errors.push(`${file}: same ${clash.host === host ? "host" : "port"} as ${clash.file}`);
      continue;
    }
    routes.push({ file, name: env.DEVBOX_NAME ?? "", host, port });
  }
  return { routes, errors };
}

/** cloudflared's config: exact hosts only, then 404. */
export function ingressYaml(tunnelId: string, credentials: string, routes: BoxRoute[]): string {
  const lines = [`tunnel: ${tunnelId}`, `credentials-file: ${credentials}`, "ingress:"];
  for (const r of routes)
    lines.push(`  - hostname: ${r.host}`, `    service: http://127.0.0.1:${r.port}`);
  lines.push("  - service: http_status:404", "");
  return lines.join("\n");
}

/** The command: the config on `out`, notes and errors on `err` (no host: a hash is private). */
export function main(
  [dir, id, creds]: (string | undefined)[],
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  if (!dir || !/^[0-9a-f-]{36}$/.test(id ?? "") || !creds) {
    err("usage: boxes-ingress.ts <devbox dir> <tunnel id> <credentials file>");
    return 2;
  }
  const files = readdirSync(dir)
    .filter(isBoxEnvFile)
    .sort()
    .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }));
  const { routes, errors } = boxRoutes(files);
  if (errors.length) {
    for (const e of errors) err(e);
    return 1;
  }
  out(ingressYaml(id!, creds, routes));
  for (const r of routes) err(`  ${r.file}: ${r.name} -> 127.0.0.1:${r.port}`);
  return 0;
}

if (import.meta.main)
  process.exit(
    main(process.argv.slice(2), process.stdout.write.bind(process.stdout), console.error),
  );

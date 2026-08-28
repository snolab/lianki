/**
 * Renders scripts/dev-loader.user.js for a given dev-server origin.
 *
 * Split out of dev-userscript-server.ts so the unit suite can exercise it
 * without loading the server (which spawns tunnels and watches the filesystem,
 * and would otherwise land in the coverage gate as one big uncovered file).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const TEMPLATE = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "dev-loader.user.js");

export function renderLoader(opts: {
  origin: string;
  appOrigin: string;
  version: string;
  rev: string;
  template?: string;
}) {
  const hosts = new Set<string>();
  for (const o of [opts.origin, opts.appOrigin]) {
    try {
      hosts.add(new URL(o).hostname);
    } catch {}
  }
  // Managers match @connect against the hostname; a trycloudflare subdomain is
  // covered by the apex entry, and localhost needs both spellings.
  if ([...hosts].some((h) => h.endsWith(".trycloudflare.com"))) hosts.add("trycloudflare.com");
  if (hosts.has("localhost")) hosts.add("127.0.0.1");
  const connect = [...hosts].map((h) => `// @connect     ${h}`).join("\n");

  return (
    (opts.template ?? readFileSync(TEMPLATE, "utf8"))
      .replaceAll("__ORIGIN__", opts.origin)
      .replaceAll("__APP_ORIGIN__", opts.appOrigin)
      // The dev suffix keeps a dev install distinguishable in the manager while
      // staying numerically equal to the build — the bundle's isNewerVersion()
      // parseInt()s each dotted segment, so "-dev.x" is ignored in the compare
      // and no update prompt fires.
      .replaceAll("__VERSION__", `${opts.version}-dev.${opts.rev || "0"}`)
      // A comment-form placeholder, so the template stays parseable JS — a bare
      // __CONNECT__ line reads as an identifier and oxfmt rewrites the file
      // into a call expression.
      .replace("// __CONNECT__", connect)
  );
}

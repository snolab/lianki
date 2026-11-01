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

/**
 * Did this request come through the tunnel (Cloudflare adds these), rather
 * than from this machine? Public requests get no client list and no paths.
 */
export function isPublicRequest(h: Headers): boolean {
  return h.has("cf-connecting-ip") || h.has("cf-ray") || h.has("x-forwarded-for");
}

/** A client id as the loader makes it (letters, digits, `_`, `-`; ≤ 40); anything else is "". */
export function cleanClientId(id: string | null | undefined): string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : "";
}

/**
 * A request body read up to `max` bytes while it streams: null as soon as it
 * goes over (or its content-length says it will), never buffering more.
 */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * Keep the client table bounded: drop clients unseen for `ttlMs`, then the
 * least recently seen beyond `max`. Mutates and returns the map.
 */
export function pruneClients<C extends { last: number }>(
  clients: Map<string, C>,
  now: number,
  max: number,
  ttlMs: number,
): Map<string, C> {
  for (const [id, c] of clients) if (now - c.last > ttlMs) clients.delete(id);
  if (clients.size > max) {
    const oldest = [...clients].sort((a, b) => a[1].last - b[1].last);
    for (const [id] of oldest.slice(0, clients.size - max)) clients.delete(id);
  }
  return clients;
}

/** Printable, one line per field: control characters (terminal escapes) go. */
const printable = (s: unknown, max: number) =>
  String(s ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .slice(0, max);

/**
 * An /error report as it may be printed: bounded fields, no escapes, the
 * page's query and fragment cut off (they can hold tokens). The body is
 * anyone's on a public tunnel; nothing here is trusted or executed.
 */
export function cleanErrorReport(
  raw: string,
  id: string,
): { id: string; what: string; detail: string; page: string } {
  let body: { what?: unknown; detail?: unknown; page?: unknown } = {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") body = v;
  } catch {
    body = { detail: raw };
  }
  let page = printable(body.page, 300);
  page = page.replace(/[?#].*$/, "");
  return {
    id: printable(id, 40).replace(/[^\w.-]/g, ""),
    what: printable(body.what ?? "error", 60),
    detail: printable(body.detail, 2000).replace(/\n/g, "\n   "),
    page,
  };
}

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

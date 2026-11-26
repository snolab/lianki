/**
 * The live I/O of lib/mcp-events/server.ts, from a D1 binding and AUTH_SECRET:
 * the flag and the limits read from D1 (fail closed: a flag that cannot be
 * read is off; limits fall back to their defaults), the global fetch, DNS over
 * HTTPS for the callback's addresses, the clock.
 */
import type { D1Like } from "@/lib/d1/types";
import { defaultConfig } from "@/lib/config";
import { loadConfig } from "@/lib/config-store";
import { flagIn } from "@/lib/flags";
import { loadFlags } from "@/lib/flags-store";
import { MCP_EVENTS_FLAG, dohAddresses, eventsLimits } from "./rules";
import { WAKE_PULL_FLAG, wakeLimits } from "@/lib/chat-wake/rules";
import type { EventsDeps } from "./server";

/** Cloudflare's resolver, JSON API. Reached from the Worker over HTTPS. */
export const DOH_URL = "https://cloudflare-dns.com/dns-query";
/** Per lookup (A and AAAA run together); part of each attempt's budget, docs/chat-wake.md. */
const DOH_TIMEOUT_MS = 2000;

/**
 * A host's A and AAAA addresses, fresh (no cache), or null when the resolver
 * fails. An empty list: the name has no address. Both families are asked, so
 * a name with a public A and a private AAAA is still refused.
 */
export async function resolveDoh(
  host: string,
  f: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<string[] | null> {
  const ask = async (type: "A" | "AAAA") => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DOH_TIMEOUT_MS);
    try {
      const u = new URL(DOH_URL);
      u.searchParams.set("name", host);
      u.searchParams.set("type", type);
      const res = await f(u.toString(), {
        headers: { accept: "application/dns-json" },
        redirect: "error",
        signal: ac.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { Status?: unknown };
      // NOERROR or NXDOMAIN are answers; anything else (SERVFAIL…) is a failure.
      if (json.Status !== 0 && json.Status !== 3) return null;
      return dohAddresses(json);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const [a, aaaa] = await Promise.all([ask("A"), ask("AAAA")]);
  if (a === null || aaaa === null) return null;
  return [...a, ...aaaa];
}

export function eventsDeps(db: D1Like, sealSecret: string | undefined): EventsDeps {
  return {
    db,
    flagOn: async () => flagIn(await loadFlags(db).catch(() => null), MCP_EVENTS_FLAG),
    pullOn: async () => flagIn(await loadFlags(db).catch(() => null), WAKE_PULL_FLAG),
    limits: async () => eventsLimits(await loadConfig(db).catch(defaultConfig)),
    wakeLimits: async () => wakeLimits(await loadConfig(db).catch(defaultConfig)),
    sealSecret,
    fetch: (url, init) => fetch(url, init),
    resolve: (host) => resolveDoh(host),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

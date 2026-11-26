/**
 * The live I/O of lib/mcp-events/server.ts, from a D1 binding and AUTH_SECRET:
 * the flag and the limits read from D1 (fail closed: a flag that cannot be
 * read is off; limits fall back to their defaults), the global fetch, the clock.
 */
import type { D1Like } from "@/lib/d1/types";
import { defaultConfig } from "@/lib/config";
import { loadConfig } from "@/lib/config-store";
import { flagIn } from "@/lib/flags";
import { loadFlags } from "@/lib/flags-store";
import { MCP_EVENTS_FLAG, eventsLimits } from "./rules";
import type { EventsDeps } from "./server";

export function eventsDeps(db: D1Like, sealSecret: string | undefined): EventsDeps {
  return {
    db,
    flagOn: async () => flagIn(await loadFlags(db).catch(() => null), MCP_EVENTS_FLAG),
    limits: async () => eventsLimits(await loadConfig(db).catch(defaultConfig)),
    sealSecret,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

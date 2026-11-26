/**
 * Who may be woken, or read their mentions: a live API token with chat:read,
 * its account a `dev` holder (the owner audience of mcp.events and
 * chat.wake.pull; lib/permissions.ts grants, read live), and its own thread
 * (threadFor). Shared by the push (lib/mcp-events) and pull adapters.
 */
import { checkToken } from "@/lib/api-tokens";
import type { D1Like } from "@/lib/d1/types";
import { threadFor } from "@/lib/dev-eval";
import { userHolds } from "@/lib/account-permission";

/** What a wake needs of its token: the payload is a line of its thread. */
export const WAKE_SCOPE = "chat:read" as const;

export type Principal =
  | { ok: true; tokenHash: string; userId: string; name: string; thread: string }
  | { ok: false; why: "auth" | "scope" | "audience" };

/** `cred`: the secret, or its hash with `byHash`. */
export async function principal(
  d: { db: D1Like; now: () => number },
  cred: string,
  byHash: boolean,
): Promise<Principal> {
  const c = await checkToken(d.db, cred, WAKE_SCOPE, d.now(), { byHash });
  if (!c.ok) return { ok: false, why: c.reason === "scope" ? "scope" : "auth" };
  // The flag's audience is the owner: a `dev` holder, read live (no cache).
  const dispatch = await userHolds(d.db as never, c.user.id, "dev");
  if (!dispatch) return { ok: false, why: "audience" };
  const thread = threadFor({ userId: c.user.id, dispatch });
  if (!thread) return { ok: false, why: "audience" };
  return { ok: true, tokenHash: c.id, userId: c.user.id, name: c.name, thread };
}

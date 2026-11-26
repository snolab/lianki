/**
 * `lianki chat attachment get <id>` (owner, 2026-11-26): a lane token reads a
 * file posted in its own thread. lianki-push's hub has checked the token
 * (chat:read, the same scope as read/listen; never eval) and that the id is on
 * a line of the token's thread; this, DebugSessions.threadTicket (worker.ts),
 * checks the file belongs to that thread's account and mints a single-use
 * download ticket of INBOX.ticketMs (60 s). The agent then fetches
 * /api/my/inbox/<id> with it in x-inbox-ticket (lib/inbox/handlers.ts download).
 *
 * The thread's account: for the owner thread, the owner's accounts (those
 * holding `dev`) and the token's account must be one of them; for any other
 * thread, that user alone. No listing, nothing about the user's other files.
 */
import { holderIds } from "@/lib/account-permission";
import { INBOX } from "./config";
import { isInboxId } from "./keys";
import { type InboxDb, THREAD_TICKET, getItem, mintTicket } from "./store";

export type ThreadTicketAnswer =
  | {
      ok: true;
      item: { id: string; name: string; type: string; size: number };
      ticket: string;
      exp: number;
    }
  | { ok: false; error: "bad request" | "no database" | "no such item" | "busy" };

const isUserId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/** {userId, owner, id} from the hub: the token's account, whether its thread is the owner's, the file. */
export async function threadTicketOp(
  db: InboxDb | undefined,
  raw: unknown,
  opts: { now?: () => number; ttlMs?: number } = {},
): Promise<ThreadTicketAnswer> {
  if (!db) return { ok: false, error: "no database" };
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isUserId(r.userId) || !isInboxId(r.id) || typeof r.owner !== "boolean")
    return { ok: false, error: "bad request" };
  const it = await getItem(db, r.id);
  // One answer for every refusal: whether someone else's id exists is not told.
  const none = { ok: false, error: "no such item" } as const;
  if (!it || it.source !== "chat") return none;
  if (r.owner) {
    const owners = await holderIds(db, "dev");
    if (!owners.includes(r.userId) || !owners.includes(it.ownerId)) return none;
  } else if (it.ownerId !== r.userId) return none;
  const now = (opts.now ?? Date.now)();
  const ttl = Math.min(opts.ttlMs ?? INBOX.ticketMs, 60_000);
  const t = await mintTicket(db, it.id, now, ttl, THREAD_TICKET);
  if (!t) return none;
  return {
    ok: true,
    item: { id: it.id, name: it.name, type: it.type, size: it.size },
    ticket: t.ticket,
    exp: t.exp,
  };
}

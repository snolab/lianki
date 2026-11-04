/**
 * The agent's side of the inbox (`bun scripts/dev/eval.ts inbox …`): an
 * approved listener asks lianki-push's debug hub, which calls the main
 * Worker's DebugSessions.inbox (worker.ts) over its service binding. No URL,
 * no secret; the hub has already checked the grant. Only the owners' files
 * are reachable, and deleting is not here: that needs the owner's own
 * session (the chat's Inbox view).
 *
 * `get` mints a single-use, 60 s download ticket; the agent fetches
 * /api/dev/inbox/<id> with it in the x-inbox-ticket header.
 */
import { ownerEmails } from "@/lib/owner";
import { INBOX } from "./config";
import { isInboxId } from "./keys";
import { type InboxDb, getItem, listItemsOf, markProcessed, mintTicket } from "./store";

export type InboxOp = { op: "list" } | { op: "get"; id: string } | { op: "done"; id: string };

/** An op from the hub, or null: known ops only, a well-formed id. */
export function parseInboxOp(raw: unknown): InboxOp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.op === "list") return { op: "list" };
  if ((r.op === "get" || r.op === "done") && isInboxId(r.id)) return { op: r.op, id: r.id };
  return null;
}

async function ownerIds(db: InboxDb, raw: string | undefined): Promise<string[]> {
  const emails = ownerEmails(raw);
  if (!emails.length) return [];
  const { results } = await db
    .prepare(`SELECT id FROM user WHERE lower(email) IN (${emails.map(() => "?").join(",")})`)
    .bind(...emails)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export type InboxAnswer =
  | { ok: true; items: unknown[] }
  | { ok: true; item: unknown; ticket: string; exp: number }
  | { ok: true; done: string }
  | { ok: false; error: string };

export async function inboxOp(
  db: InboxDb | undefined,
  raw: unknown,
  opts: { ownerEmails?: string; now?: () => number },
): Promise<InboxAnswer> {
  const op = parseInboxOp(raw);
  if (!db) return { ok: false, error: "no database" };
  if (!op) return { ok: false, error: "bad inbox op" };
  const owners = await ownerIds(db, opts.ownerEmails);
  const now = (opts.now ?? Date.now)();
  const view = (i: Awaited<ReturnType<typeof getItem>> & {}) => ({
    id: i.id,
    name: i.name,
    type: i.type,
    size: i.size,
    sha256: i.sha256,
    at: new Date(i.createdMs).toISOString(),
    ...(i.processedMs ? { processedAt: new Date(i.processedMs).toISOString() } : {}),
    ...(i.lineId ? { line: i.lineId } : {}),
  });
  if (op.op === "list") return { ok: true, items: (await listItemsOf(db, owners)).map(view) };
  const it = await getItem(db, op.id);
  if (!it || !owners.includes(it.ownerId)) return { ok: false, error: "no such item" };
  if (op.op === "done") {
    await markProcessed(db, it.id, now);
    return { ok: true, done: it.id };
  }
  const t = await mintTicket(db, it.id, now, INBOX.ticketMs);
  if (!t) return { ok: false, error: "no such item" };
  return { ok: true, item: view(it), ticket: t.ticket, exp: t.exp };
}

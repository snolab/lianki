/**
 * Files on a chat line in a user's own thread (owner, 2026-11-26: every user
 * can send images in their Li chat). The page sends only refs; lianki-push's
 * debug hub keeps a ref on a non-owner line only after the main Worker
 * (DebugSessions.threadFiles, worker.ts) has checked that the id is a file of
 * that thread's account. No cross-account ids: someone else's id, a made-up
 * one or a deleted one is dropped, and the name, type and size come from the
 * stored row, never from the page.
 */
// Types only, and no app imports: lianki-push's hub bundles this file too.
import type { AttachmentRef } from "../../packages/debug-chat/src/wire";
import type { InboxDb } from "./store";

/** An item id as lib/inbox/keys.ts newInboxId makes it. */
const isInboxId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{20}$/.test(v);

/** Most refs checked per line (the wire's MAX_ATTACHMENTS). */
const MAX_IDS = 10;

/** A user id as better-auth makes it (also a thread's base id). */
const isUserId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/**
 * The refs among `ids` that are `userId`'s own stored files, in the order
 * sent, each described by its row. Anything else: left out.
 */
export async function ownedAttachments(
  db: InboxDb,
  userId: string,
  ids: readonly unknown[],
): Promise<AttachmentRef[]> {
  if (!isUserId(userId)) return [];
  const want = [...new Set(ids.filter(isInboxId))].slice(0, MAX_IDS);
  if (!want.length) return [];
  const { results } = await db
    .prepare(
      `SELECT id, name, type, size FROM inbox_item WHERE owner_id = ? AND id IN (${want.map(() => "?").join(",")})`,
    )
    .bind(userId, ...want)
    .all<{ id: string; name: string; type: string; size: number }>();
  const byId = new Map(results.map((r) => [r.id, r]));
  return want.flatMap((id) => {
    const r = byId.get(id);
    return r ? [{ id: r.id, name: r.name, type: r.type, size: Number(r.size) }] : [];
  });
}

export type ThreadFilesAnswer =
  | { ok: true; files: AttachmentRef[] }
  | { ok: false; error: "bad request" | "no database" | "busy" };

/** DebugSessions.threadFiles: {userId, ids} from the hub → that account's own files among ids. */
export async function threadFilesOp(
  db: InboxDb | undefined,
  raw: unknown,
): Promise<ThreadFilesAnswer> {
  if (!db) return { ok: false, error: "no database" };
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isUserId(r.userId) || !Array.isArray(r.ids)) return { ok: false, error: "bad request" };
  return { ok: true, files: await ownedAttachments(db, r.userId, r.ids) };
}

/**
 * The hub's side: only the refs the main Worker vouched for, as it described
 * them. No answer, or a refusal: none (a line's files fail closed).
 */
export function verifiedRefs(sent: readonly AttachmentRef[], answer: unknown): AttachmentRef[] {
  const a = answer as { ok?: unknown; files?: unknown } | null;
  if (!a || a.ok !== true || !Array.isArray(a.files)) return [];
  const sentIds = new Set(sent.map((x) => x.id));
  const out: AttachmentRef[] = [];
  for (const f of a.files as Record<string, unknown>[]) {
    if (!f || !isInboxId(f.id) || !sentIds.has(f.id) || out.some((x) => x.id === f.id)) continue;
    out.push({
      id: f.id,
      name: typeof f.name === "string" ? f.name : "file",
      type: typeof f.type === "string" ? f.type : "application/octet-stream",
      size: typeof f.size === "number" && Number.isSafeInteger(f.size) ? f.size : 0,
    });
  }
  return out;
}

/**
 * The inbox's HTTP side (app/api/dev/inbox/**), as plain functions over
 * their dependencies so the gate, the caps and the sniffing are unit-tested
 * (unit/inbox.test.ts). Owner session only: anyone else gets 404, as every
 * /api/dev route. A file is streamed to R2 as it arrives (hashed on the
 * way); its row and the user's usage are written together after.
 */
import { createHash } from "node:crypto";
import { cleanFileName } from "@lianki/debug-chat/wire";
import { INBOX } from "./config";
import { chargeInbox, monthlyUsd, readUsd, storageUsd, uploadUsd } from "./charge";
import type { InboxUsage } from "./store";
import { fileHeaders, inboxKey, isInboxId, newInboxId } from "./keys";
import { SNIFF_BYTES, sniff } from "./sniff";
import {
  type InboxDb,
  deleteItem,
  getItem,
  insertItem,
  linkLine,
  listItems,
  settleTo,
  spendTicket,
  uploadedSince,
  usageOf,
} from "./store";

/** The slice of an R2 bucket used here. */
export type InboxBucket = {
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>;
  delete(key: string): Promise<unknown>;
};

export type Who = { id: string; email: string; owner: boolean } | null;

export type InboxDeps = {
  who: () => Promise<Who>;
  db: () => InboxDb;
  bucket: () => InboxBucket;
  now?: () => number;
  /** The upload rate limit (lib/debug-session.ts rateLimiter). */
  allow?: () => boolean;
};

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...NO_STORE },
  });
const notFound = () => json({ error: "Not found" }, 404);
const DAY_MS = 24 * 3600_000;

/** The gate: the owner's own session, else null (→ 404). Friends and other users are refused for now. */
async function owner(d: InboxDeps) {
  const w = await d.who();
  return w?.owner && w.id ? w : null;
}

/** Over the safety cap on what one user keeps stored (INBOX.maxStoredBytes)? Applies to everyone. */
export const overCap = (stored: number, adding: number) => stored + adding > INBOX.maxStoredBytes;

/**
 * The storage cost accrued since the last settlement (bytes stored × time),
 * charged to the user; the caller moves settled_ms to `now` in the same write.
 */
export async function settleStorage(userId: string, u: InboxUsage, now: number) {
  if (!u.settledMs || u.bytesStored <= 0 || now <= u.settledMs) return;
  const ms = now - u.settledMs;
  await chargeInbox(userId, {
    kind: "storage",
    usd: storageUsd(u.bytesStored, ms),
    bytes: u.bytesStored,
    ms,
  });
}

/**
 * The body, with its head peeked for sniffing and every byte hashed and
 * counted on its way to R2; more bytes than announced is an error.
 */
async function peeked(body: ReadableStream<Uint8Array>, max: number) {
  const reader = body.getReader();
  const head: Uint8Array[] = [];
  let got = 0;
  while (got < SNIFF_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    head.push(value);
    got += value.length;
  }
  const first = new Uint8Array(got);
  let at = 0;
  for (const c of head) {
    first.set(c, at);
    at += c.length;
  }
  const hash = createHash("sha256");
  let count = 0;
  const take = (c: Uint8Array, ctl: ReadableStreamDefaultController<Uint8Array>) => {
    count += c.length;
    // Over what was announced: the stream errors, so R2's put fails and nothing is kept.
    if (count > max) return ctl.error(new Error("longer than announced"));
    hash.update(c);
    ctl.enqueue(c);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      if (first.length) take(first, ctl);
    },
    async pull(ctl) {
      const { done, value } = await reader.read();
      if (done) return ctl.close();
      take(value, ctl);
    },
    cancel(r) {
      return reader.cancel(r);
    },
  });
  return {
    head: first.slice(0, SNIFF_BYTES),
    stream,
    count: () => count,
    sha256: () => hash.digest("hex"),
  };
}

/** R2 needs a body of known length: workerd's FixedLengthStream (absent in tests). */
function fixedLength(s: ReadableStream<Uint8Array>, len: number) {
  const F = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream })
    .FixedLengthStream;
  return F ? s.pipeThrough(new F(len)) : s;
}

/** POST /api/dev/inbox — the raw bytes as the body; `x-file-name` (URI-encoded) and content-type as declared. */
export async function upload(req: Request, d: InboxDeps): Promise<Response> {
  const who = await owner(d);
  if (!who) return notFound();
  if (d.allow && !d.allow()) return json({ error: "rate-limited" }, 429);
  const len = Number(req.headers.get("content-length"));
  if (!Number.isSafeInteger(len) || len <= 0 || !req.body)
    return json({ error: "length-required" }, 411);
  if (len > INBOX.maxFileBytes) return json({ error: "too-big", max: INBOX.maxFileBytes }, 413);
  const now = (d.now ?? Date.now)();
  const db = d.db();
  const [day, usage] = await Promise.all([
    uploadedSince(db, who.id, now - DAY_MS),
    usageOf(db, who.id),
  ]);
  if (day + len > INBOX.maxDayBytes) return json({ error: "day-cap", max: INBOX.maxDayBytes }, 413);
  if (overCap(usage.bytesStored, len))
    return json({ error: "storage-cap", max: INBOX.maxStoredBytes }, 413);
  let name = "file";
  try {
    name = cleanFileName(decodeURIComponent(req.headers.get("x-file-name") ?? ""));
  } catch {}
  const body = await peeked(req.body, len);
  const { type } = sniff(body.head, req.headers.get("content-type") ?? "");
  const id = newInboxId();
  const key = inboxKey(who.id, id, now);
  try {
    await d
      .bucket()
      .put(key, fixedLength(body.stream, len), { httpMetadata: { contentType: type } });
  } catch {
    await d
      .bucket()
      .delete(key)
      .catch(() => {});
    return json({ error: "upload-failed" }, 400);
  }
  if (body.count() !== len) {
    await d
      .bucket()
      .delete(key)
      .catch(() => {});
    return json({ error: "length-mismatch" }, 400);
  }
  // What was stored until now is settled first; the insert moves settled_ms to now.
  await settleStorage(who.id, usage, now);
  await insertItem(db, {
    id,
    ownerId: who.id,
    name,
    type,
    size: len,
    sha256: body.sha256(),
    r2Key: key,
    createdMs: now,
  });
  await chargeInbox(who.id, { kind: "upload", usd: uploadUsd(), bytes: len });
  // Never the name in a log: a user's text.
  console.log(JSON.stringify({ event: "inbox.upload", id, type, size: len }));
  return json({ id, name, type, size: len }, 201);
}

/** GET /api/dev/inbox — the owner's files, newest first, and his usage. */
export async function list(d: InboxDeps): Promise<Response> {
  const who = await owner(d);
  if (!who) return notFound();
  const db = d.db();
  const [items, usage] = await Promise.all([listItems(db, who.id), usageOf(db, who.id)]);
  // Opening the inbox settles the storage it has used so far (event-driven, no polling).
  const now = (d.now ?? Date.now)();
  await settleStorage(who.id, usage, now);
  await settleTo(db, who.id, now);
  return json({
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      type: i.type,
      size: i.size,
      at: i.createdMs,
      ...(i.processedMs ? { processedAt: i.processedMs } : {}),
    })),
    usage: {
      bytesStored: usage.bytesStored,
      bytesUploaded: usage.bytesUploaded,
      items: usage.items,
      capBytes: INBOX.maxStoredBytes,
      monthlyUsd: monthlyUsd(usage.bytesStored),
    },
  });
}

/** PATCH /api/dev/inbox — {ids, line}: the chat line these files were sent with. */
export async function link(req: Request, d: InboxDeps): Promise<Response> {
  const who = await owner(d);
  if (!who) return notFound();
  const b = (await req.json().catch(() => null)) as { ids?: unknown; line?: unknown } | null;
  const ids = Array.isArray(b?.ids) ? b.ids.filter(isInboxId).slice(0, 10) : [];
  const line = typeof b?.line === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(b.line) ? b.line : null;
  if (!ids.length || !line) return json({ error: "bad request" }, 400);
  await linkLine(d.db(), who.id, ids, line);
  return json({ ok: true });
}

/** The header an agent's single-use download ticket rides in (never the URL: URLs are logged). */
export const TICKET_HEADER = "x-inbox-ticket";

/**
 * GET /api/dev/inbox/<id> — the file: with the owner's session (his own
 * files), or a ticket an agent got through the hub (single use, 60 s).
 */
export async function download(req: Request, id: string, d: InboxDeps): Promise<Response> {
  if (!isInboxId(id)) return notFound();
  const db = d.db();
  const it = await getItem(db, id);
  if (!it) return notFound();
  const who = await owner(d);
  const ticket = req.headers.get(TICKET_HEADER);
  const mine = !!who && who.id === it.ownerId;
  if (!mine && !(ticket && (await spendTicket(db, id, ticket, (d.now ?? Date.now)()))))
    return notFound();
  const obj = await d.bucket().get(it.r2Key);
  if (!obj) return notFound();
  await chargeInbox(it.ownerId, { kind: "read", usd: readUsd(), bytes: it.size });
  return new Response(obj.body, { headers: fileHeaders(it) });
}

/** DELETE /api/dev/inbox/<id> — the owner's own session only; the file and its row go for good. */
export async function remove(id: string, d: InboxDeps): Promise<Response> {
  const who = await owner(d);
  if (!who || !isInboxId(id)) return notFound();
  const db = d.db();
  const it = await getItem(db, id);
  if (!it || it.ownerId !== who.id) return notFound();
  const now = (d.now ?? Date.now)();
  // Everything stored (this file included) is settled up to now, then it goes.
  await settleStorage(it.ownerId, await usageOf(db, it.ownerId), now);
  await d.bucket().delete(it.r2Key);
  await deleteItem(db, it, now);
  console.log(JSON.stringify({ event: "inbox.delete", id }));
  return json({ ok: true });
}

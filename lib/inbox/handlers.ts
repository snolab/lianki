/**
 * The inbox's HTTP side (app/api/dev/inbox/**), as plain functions over
 * their dependencies so the gate, the caps and the sniffing are unit-tested
 * (unit/inbox.test.ts). Every signed-in account sees only its own files. A file is streamed to R2 as it arrives (hashed on the
 * way); its row and the user's usage are written together after.
 */
import { createHash } from "node:crypto";
import { cleanFileName } from "@lianki/debug-chat/wire";
import { INBOX, type InboxLimits } from "./config";
import { holderIds } from "@/lib/account-permission";
import { chargeInbox, monthlyUsd, readUsd, storageUsd, uploadUsd } from "./charge";
import type { InboxSource, InboxUsage } from "./store";
import { fileHeaders, inboxKey, isInboxId, newInboxId } from "./keys";
import { SNIFF_BYTES, sniff } from "./sniff";
import { knownLengthBody, inboxResponseBody } from "./body";
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
    body: ReadableStream<Uint8Array> | ArrayBuffer,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<import("./body").InboxObject | null>;
  delete(key: string): Promise<unknown>;
};

export type Who = { id: string; email: string; owner: boolean } | null;

export type InboxDeps = {
  who: () => Promise<Who>;
  db: () => InboxDb;
  bucket: () => InboxBucket;
  now?: () => number;
  /** The upload rate limit (lib/debug-session.ts rateLimiter). */
  allow?: (account: string, max: number) => boolean;
  limits?: () => Promise<InboxLimits>;
};

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...NO_STORE },
  });
const notFound = () => json({ error: "Not found" }, 404);
const DAY_MS = 24 * 3600_000;

/** A signed-in account, never an account id supplied by the request. */
async function account(d: InboxDeps) {
  const w = await d.who();
  return w?.id ? w : null;
}

/** Over the safety cap on what one user keeps stored (INBOX.maxStoredBytes)? Applies to everyone. */
export const overCap = (stored: number, adding: number, max = INBOX.maxStoredBytes) =>
  stored + adding > max;

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

/** POST /api/my/inbox — the raw bytes as the body; `x-file-name` (URI-encoded) and content-type as declared. */
export async function upload(req: Request, d: InboxDeps): Promise<Response> {
  const who = await account(d);
  if (!who) return notFound();
  return storeUpload(req, who, d, "chat");
}

/**
 * Store one uploaded file for `who` under `source`, with every cap: the
 * rate, the file size, the rolling day, the stored total. The gate is the
 * caller's (the chat inbox: the owner; the Import panel: its flag).
 */
export async function storeUpload(
  req: Request,
  who: { id: string },
  d: InboxDeps,
  source: InboxSource,
): Promise<Response> {
  const limits = d.limits ? await d.limits() : INBOX;
  if (d.allow && !d.allow(who.id, limits.uploadsPerMinute))
    return json({ error: "rate-limited" }, 429);
  const len = Number(req.headers.get("content-length"));
  if (!Number.isSafeInteger(len) || len <= 0 || !req.body)
    return json({ error: "length-required" }, 411);
  if (len > limits.maxFileBytes) return json({ error: "too-big", max: limits.maxFileBytes }, 413);
  const now = (d.now ?? Date.now)();
  const db = d.db();
  const [day, usage] = await Promise.all([
    uploadedSince(db, who.id, now - DAY_MS),
    usageOf(db, who.id),
  ]);
  if (day + len > limits.maxDayBytes)
    return json({ error: "day-cap", max: limits.maxDayBytes }, 413);
  if (overCap(usage.bytesStored, len, limits.maxStoredBytes))
    return json({ error: "storage-cap", max: limits.maxStoredBytes }, 413);
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
      .put(key, await knownLengthBody(body.stream, len), { httpMetadata: { contentType: type } });
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
  try {
    const inserted = await insertItem(
      db,
      {
        id,
        ownerId: who.id,
        name,
        type,
        size: len,
        sha256: body.sha256(),
        r2Key: key,
        createdMs: now,
        source,
      },
      limits,
    );
    if (!inserted) {
      await d.bucket().delete(key);
      const usage = await usageOf(db, who.id);
      return overCap(usage.bytesStored, len, limits.maxStoredBytes)
        ? json({ error: "storage-cap", max: limits.maxStoredBytes }, 413)
        : json({ error: "day-cap", max: limits.maxDayBytes }, 413);
    }
  } catch {
    await d
      .bucket()
      .delete(key)
      .catch(() => {});
    return json({ error: "upload-failed" }, 503);
  }
  await chargeInbox(who.id, { kind: "upload", usd: uploadUsd(), bytes: len });
  // Never the name in a log: a user's text.
  console.log(JSON.stringify({ event: "inbox.upload", id, type, size: len, source }));
  return json({ id, name, type, size: len, at: now }, 201);
}

/** GET /api/my/inbox — the account's own files, newest first, and its usage. */
export async function list(d: InboxDeps): Promise<Response> {
  const who = await account(d);
  if (!who) return notFound();
  return listFor(who, d, "chat");
}

/** `who`'s files from `source`, newest first, and their usage (storage settled to now). */
export async function listFor(
  who: { id: string },
  d: InboxDeps,
  source: InboxSource,
): Promise<Response> {
  const db = d.db();
  const [items, usage] = await Promise.all([
    listItems(db, who.id, 200, source),
    usageOf(db, who.id),
  ]);
  // Opening the inbox settles the storage it has used so far (event-driven, no polling).
  const now = (d.now ?? Date.now)();
  await settleStorage(who.id, usage, now);
  await settleTo(db, who.id, now);
  const limits = d.limits ? await d.limits() : INBOX;
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
      capBytes: limits.maxStoredBytes,
      monthlyUsd: monthlyUsd(usage.bytesStored),
    },
  });
}

/** PATCH /api/my/inbox — {ids, line}: the chat line these files were sent with. */
export async function link(req: Request, d: InboxDeps): Promise<Response> {
  const who = await account(d);
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
 * GET /api/my/inbox/<id> — the file: with the owner's session (his own
 * files), or a ticket an agent got through the hub (single use, 60 s).
 */
export async function download(req: Request, id: string, d: InboxDeps): Promise<Response> {
  if (!isInboxId(id)) return notFound();
  const db = d.db();
  const it = await getItem(db, id);
  if (!it) return notFound();
  const who = await account(d);
  const ticket = req.headers.get(TICKET_HEADER);
  const mine = !!who && who.id === it.ownerId;
  // Tickets remain restricted to the dev accounts the agent can read.
  if (
    !mine &&
    !(
      ticket &&
      it.source === "chat" &&
      (await holderIds(db, "dev")).includes(it.ownerId) &&
      (await spendTicket(db, id, ticket, (d.now ?? Date.now)()))
    )
  )
    return notFound();
  const obj = await d.bucket().get(it.r2Key);
  if (!obj) return notFound();
  await chargeInbox(it.ownerId, { kind: "read", usd: readUsd(), bytes: it.size });
  return new Response(await inboxResponseBody(obj), { headers: fileHeaders(it) });
}

/**
 * One of `who`'s own files, served back to them only (any source): the
 * stored, sniffed type, inline only for a safe image, else an attachment;
 * no shared link exists. Anyone else, or a missing id: 404.
 */
export async function serveOwn(id: string, who: { id: string }, d: InboxDeps): Promise<Response> {
  if (!isInboxId(id)) return notFound();
  const it = await getItem(d.db(), id);
  if (!it || it.ownerId !== who.id) return notFound();
  const obj = await d.bucket().get(it.r2Key);
  if (!obj) return notFound();
  await chargeInbox(it.ownerId, { kind: "read", usd: readUsd(), bytes: it.size });
  return new Response(await inboxResponseBody(obj), { headers: fileHeaders(it) });
}

/** DELETE /api/my/inbox/<id> — the account's own session only; the file and its row go for good. */
export async function remove(id: string, d: InboxDeps): Promise<Response> {
  const who = await account(d);
  if (!who) return notFound();
  return removeFor(id, who, d, "chat");
}

/** Delete one of `who`'s own files (from `source`; null: any source), for good (R2 object, row, usage). */
export async function removeFor(
  id: string,
  who: { id: string },
  d: InboxDeps,
  source: InboxSource | null,
): Promise<Response> {
  if (!isInboxId(id)) return notFound();
  const db = d.db();
  const it = await getItem(db, id);
  if (!it || it.ownerId !== who.id || (source !== null && it.source !== source)) return notFound();
  const now = (d.now ?? Date.now)();
  // Everything stored (this file included) is settled up to now, then it goes.
  await settleStorage(it.ownerId, await usageOf(db, it.ownerId), now);
  await d.bucket().delete(it.r2Key);
  await deleteItem(db, it, now);
  console.log(JSON.stringify({ event: "inbox.delete", id }));
  return json({ ok: true });
}

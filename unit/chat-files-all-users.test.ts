/**
 * Images in every user's Li chat (owner, 2026-11-26): the 5 GB file space
 * (config files.quotaBytes, every source together), the friendly over-quota
 * note, and the hub's ownership check on a user's attachment ids
 * (lib/inbox/thread-files.ts; no cross-account ids).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import { CONFIG } from "../lib/config";
import { INBOX } from "../lib/inbox/config";
import {
  type InboxBucket,
  type InboxDeps,
  overCap,
  storeUpload,
  upload,
} from "../lib/inbox/handlers";
import type { InboxDb } from "../lib/inbox/store";
import { ownedAttachments, threadFilesOp, verifiedRefs } from "../lib/inbox/thread-files";
import { UploadRefused, refusalNote } from "../lib/inbox/client";
import { createPendingFiles, type ChatFiles } from "../packages/debug-chat/src/files";

const SCHEMA =
  "CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT);\n" +
  readFileSync(new URL("../db/migrations/0035_inbox.sql", import.meta.url), "utf8") +
  readFileSync(new URL("../db/migrations/0068_import_files.sql", import.meta.url), "utf8") +
  readFileSync(new URL("../db/migrations/0077_inbox_upload_log.sql", import.meta.url), "utf8");
const GB = 1024 ** 3;
const T0 = 1_800_000_000_000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const A = { id: "uA", email: "a@example.com", owner: false };
const B = { id: "uB", email: "b@example.com", owner: false };

function memBucket(): InboxBucket {
  const store = new Map<string, Uint8Array>();
  return {
    async put(key, body) {
      store.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
    },
    async get(key) {
      const v = store.get(key);
      return v ? { body: new Response(v as Uint8Array<ArrayBuffer>).body! } : null;
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

let db: InboxDb;
let raw: { exec(s: string): void };
let who: typeof A | typeof B;
let deps: InboxDeps;
beforeEach(() => {
  const d = createTestD1(SCHEMA);
  d.raw().exec(
    "INSERT INTO user (id, email) VALUES ('uA', 'a@example.com'), ('uB', 'b@example.com')",
  );
  raw = d.raw();
  db = d as unknown as InboxDb;
  who = A;
  deps = { who: async () => who, db: () => db, bucket: memBucket, now: () => T0 };
});

const post = (body = PNG) =>
  new Request("https://x/api/my/inbox", {
    method: "POST",
    headers: {
      "content-length": String(body.length),
      "x-file-name": encodeURIComponent("photo.png"),
      "content-type": "image/png",
    },
    body: body as Uint8Array<ArrayBuffer>,
  });
const sent = async () =>
  (await (await upload(post(), deps)).json()) as { id: string; size: number };

describe("the file space (files.quotaBytes)", () => {
  test("defaults to 5 GB per account, read live, and the old 2 GB key is gone", () => {
    expect(CONFIG["files.quotaBytes"].default).toBe(5 * GB);
    expect(INBOX.maxStoredBytes).toBe(5 * GB);
    expect("inbox.maxStoredBytes" in CONFIG).toBe(false);
  });

  test("overCap: up to the space is fine, a byte past it is not", () => {
    expect(overCap(5 * GB - 10, 10)).toBe(false);
    expect(overCap(5 * GB - 10, 11)).toBe(true);
    expect(overCap(3 * GB, 2.5 * GB)).toBe(true); // 2 GB no longer the cap: 3 GB stored is fine alone
    expect(overCap(3 * GB, 1)).toBe(false);
  });

  test("every source shares it: imports fill the space, then a chat image is refused with used and max", async () => {
    const limits = {
      maxFileBytes: 1024,
      maxDayBytes: 10_000,
      maxStoredBytes: 20,
      uploadsPerMinute: 100,
    };
    const d = { ...deps, limits: async () => limits };
    expect((await storeUpload(post(), A, d, "import")).status).toBe(201); // 12 bytes stored
    const r = await upload(post(), d); // 12 more would be 24 > 20
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: "storage-cap", used: 12, max: 20 });
    // Another account's space is its own.
    who = B;
    expect((await upload(post(), d)).status).toBe(201);
  });

  test("the friendly note says what is used and the limit", () => {
    const body = JSON.stringify({ error: "storage-cap", used: 5 * GB - 1024, max: 5 * GB });
    expect(refusalNote(413, body)).toBe(
      "Your file space is full: 5 GB of 5 GB used. Delete some files in My files to make room.",
    );
    expect(refusalNote(413, body, "满 {used}/{max}")).toBe("满 5 GB/5 GB");
    expect(refusalNote(413, JSON.stringify({ error: "day-cap", max: 1 }))).toBeUndefined();
    expect(refusalNote(500, body)).toBeUndefined();
    expect(refusalNote(413, "not json")).toBeUndefined();
  });

  test("the chat shows the host's note on the failed file", async () => {
    const host: ChatFiles = {
      upload: () =>
        Promise.reject(new UploadRefused(413, "Your file space is full: 5 GB of 5 GB used.")),
      url: () => "",
    };
    const p = createPendingFiles({ files: () => host });
    p.add([new File([PNG], "photo.png", { type: "image/png" })]);
    await new Promise((r) => setTimeout(r, 0));
    expect(p.get()[0]).toMatchObject({
      state: "failed",
      note: "Your file space is full: 5 GB of 5 GB used.",
    });
  });
});

describe("attachment ownership (no cross-account ids)", () => {
  test("only the account's own ids are kept, described by the stored row, in the order sent", async () => {
    const a1 = await sent();
    const a2 = await sent();
    who = B;
    const b1 = await sent();
    const own = await ownedAttachments(db, "uA", [
      a2.id,
      b1.id,
      "f".repeat(20),
      a1.id,
      a1.id,
      "bad id",
    ]);
    expect(own.map((x) => x.id)).toEqual([a2.id, a1.id]);
    expect(own[0]).toEqual({ id: a2.id, name: "photo.png", type: "image/png", size: PNG.length });
    expect(await ownedAttachments(db, "uB", [a1.id, a2.id])).toEqual([]);
    expect((await ownedAttachments(db, "uB", [b1.id])).map((x) => x.id)).toEqual([b1.id]);
  });

  test("a deleted file is not kept", async () => {
    const a1 = await sent();
    raw.exec(`DELETE FROM inbox_item WHERE id = '${a1.id}'`);
    expect(await ownedAttachments(db, "uA", [a1.id])).toEqual([]);
  });

  test("the RPC refuses malformed requests and has no database fallback", async () => {
    expect(await threadFilesOp(undefined, { userId: "uA", ids: [] })).toEqual({
      ok: false,
      error: "no database",
    });
    expect(await threadFilesOp(db, { userId: "uA" })).toEqual({ ok: false, error: "bad request" });
    expect(await threadFilesOp(db, { userId: "a b", ids: [] })).toEqual({
      ok: false,
      error: "bad request",
    });
    const a1 = await sent();
    expect(await threadFilesOp(db, { userId: "uA", ids: [a1.id] })).toMatchObject({
      ok: true,
      files: [{ id: a1.id }],
    });
  });

  test("the hub keeps only what the main Worker vouched for, as it described it; else nothing", () => {
    const id1 = "1".repeat(20);
    const id2 = "2".repeat(20);
    const page = [
      { id: id1, name: "evil.html", type: "image/png", size: 1 },
      { id: id2, name: "b.png", type: "image/png", size: 2 },
    ];
    const answer = {
      ok: true,
      files: [
        { id: id1, name: "a.png", type: "image/png", size: 10 },
        { id: "3".repeat(20), name: "never sent", type: "image/png", size: 3 },
      ],
    };
    expect(verifiedRefs(page, answer)).toEqual([
      { id: id1, name: "a.png", type: "image/png", size: 10 },
    ]);
    expect(verifiedRefs(page, { ok: false, error: "busy" })).toEqual([]);
    expect(verifiedRefs(page, null)).toEqual([]);
    expect(verifiedRefs(page, { ok: true })).toEqual([]);
  });
});

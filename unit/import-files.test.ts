/**
 * The Import panel's "Any file" (lib/import/files.ts; docs/import-material.md,
 * "Any file: stored, not processed"): the gate is the panel's flag (never an
 * email), each user sees and deletes only their own files, the chat inbox and
 * the import files stay apart, the inbox's caps apply, writes are same-origin.
 */
import { beforeEach, describe, expect, spyOn, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import { INBOX } from "../lib/inbox/config";
import { type InboxBucket, list as inboxList, upload as inboxUpload } from "../lib/inbox/handlers";
import { inboxOp } from "../lib/inbox/agent";
import { type InboxDb, usageOf } from "../lib/inbox/store";
import {
  type ImportFilesDeps,
  deleteImportFile,
  listImportFiles,
  uploadImportFile,
} from "../lib/import/files";

const SCHEMA = ["0035_inbox.sql", "0068_import_files.sql"]
  .map((f) => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), "utf8"))
  .join("\n");

function memBucket() {
  const store = new Map<string, Uint8Array>();
  const b: InboxBucket & { store: typeof store } = {
    store,
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
  return b;
}

const ALICE = { id: "u1", email: "alice@example.com", owner: false };
const BOB = { id: "u2", email: "bob@example.com", owner: false };
const OWNER = { id: "u9", email: "owner@example.com", owner: true };
const ORIGIN = "https://lianki.com";

let db: InboxDb;
let bucket: ReturnType<typeof memBucket>;
let who: typeof ALICE | null;
let flagOn: boolean;
let now: number;
let deps: ImportFilesDeps;
let logs: ReturnType<typeof spyOn>;
beforeEach(() => {
  const d = createTestD1(SCHEMA);
  d.raw().exec(
    `CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT);
     INSERT INTO user (id, email) VALUES ('u1', 'alice@example.com'), ('u9', 'owner@example.com');
     CREATE TABLE account_permission (email TEXT, permission TEXT NOT NULL DEFAULT 'dev', revoked_at INTEGER);
     INSERT INTO account_permission (email) VALUES ('owner@example.com')`,
  );
  db = d as unknown as InboxDb;
  bucket = memBucket();
  who = ALICE;
  flagOn = true;
  now = 1_800_000_000_000;
  deps = {
    who: async () => who,
    db: () => db,
    bucket: () => bucket,
    now: () => now,
    // The panel's gate as the route wires it: importAnyOn(flags, isDev) — here, the flag.
    on: async () => flagOn,
  };
  logs = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logs.mockRestore());

const put = (name: string, bytes: Uint8Array | string, headers: Record<string, string> = {}) => {
  const body = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return new Request(`${ORIGIN}/api/import/files`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      host: "lianki.com",
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
      "x-file-name": encodeURIComponent(name),
      ...headers,
    },
    body: body as Uint8Array<ArrayBuffer>,
  });
};
const del = (id: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/import/files/${id}`, {
    method: "DELETE",
    headers: { origin: ORIGIN, host: "lianki.com", ...headers },
  });
const items = async () =>
  ((await (await listImportFiles(deps)).json()) as { items: { id: string; name: string }[] }).items;

describe("Any file: stored, listed, deleted — not processed", () => {
  test("any signed-in user the flag lets in stores a file of any type and sees it listed", async () => {
    const r = await uploadImportFile(put("notes 第1課.pdf", "%PDF-1.4 hello"), deps);
    expect(r.status).toBe(201);
    const b = (await r.json()) as { id: string; name: string; size: number; at: number };
    expect(b).toMatchObject({ name: "notes 第1課.pdf", size: 14, at: now });
    expect(await items()).toMatchObject([{ id: b.id, name: "notes 第1課.pdf", size: 14, at: now }]);
    // In R2 under the user's own prefix; the name is never in the key.
    const [key] = [...bucket.store.keys()];
    expect(key).toContain(`/${ALICE.id}/`);
    expect(key).not.toContain("notes");
    expect((await usageOf(db, ALICE.id)).bytesStored).toBe(14);
  });

  test("a binary of an unknown kind is kept too (stored only, never parsed)", async () => {
    const r = await uploadImportFile(put("data.bin", new Uint8Array([0, 1, 2, 255])), deps);
    expect(r.status).toBe(201);
    expect(((await r.json()) as { type: string }).type).toBe("application/octet-stream");
  });

  test("the gate is the flag: off → 404 for everyone, the owner included; a guest 401", async () => {
    flagOn = false;
    who = OWNER;
    expect((await uploadImportFile(put("a.txt", "a"), deps)).status).toBe(404);
    expect((await listImportFiles(deps)).status).toBe(404);
    expect((await deleteImportFile(del("0".repeat(20)), "0".repeat(20), deps)).status).toBe(404);
    who = null;
    expect((await uploadImportFile(put("a.txt", "a"), deps)).status).toBe(401);
    expect((await listImportFiles(deps)).status).toBe(401);
    expect((await deleteImportFile(del("0".repeat(20)), "0".repeat(20), deps)).status).toBe(401);
    who = ALICE;
    flagOn = true;
    expect((await uploadImportFile(put("a.txt", "a"), { ...deps, available: false })).status).toBe(
      404,
    );
  });

  test("writes are same-origin only", async () => {
    expect(
      (await uploadImportFile(put("a.txt", "a", { origin: "https://evil.example" }), deps)).status,
    ).toBe(403);
    expect(
      (await deleteImportFile(del("0".repeat(20), { origin: "https://evil.example" }), "x", deps))
        .status,
    ).toBe(403);
  });

  test("each user lists and deletes only their own files", async () => {
    const a = (await (await uploadImportFile(put("a.txt", "aaa"), deps)).json()) as { id: string };
    who = BOB;
    expect(await items()).toEqual([]);
    expect((await deleteImportFile(del(a.id), a.id, deps)).status).toBe(404);
    who = ALICE;
    expect((await deleteImportFile(del("not-an-id"), "not-an-id", deps)).status).toBe(404);
    const r = await deleteImportFile(del(a.id), a.id, deps);
    expect(r.status).toBe(200);
    expect(await items()).toEqual([]);
    expect(bucket.store.size).toBe(0);
    expect((await usageOf(db, ALICE.id)).bytesStored).toBe(0);
  });

  test("the chat inbox and the import files stay apart", async () => {
    who = OWNER;
    const chat = (await (await inboxUpload(put("chat.png", "x"), deps)).json()) as { id: string };
    const imp = (await (await uploadImportFile(put("import.txt", "y"), deps)).json()) as {
      id: string;
    };
    expect((await items()).map((i) => i.id)).toEqual([imp.id]);
    const chatList = (await (await inboxList(deps)).json()) as { items: { id: string }[] };
    expect(chatList.items.map((i) => i.id)).toEqual([chat.id]);
    // Neither side deletes the other's file.
    expect((await deleteImportFile(del(chat.id), chat.id, deps)).status).toBe(404);
    // An agent's inbox ops see only the chat's files.
    const agent = await inboxOp(db as never, { op: "get", id: imp.id });
    expect(agent).toMatchObject({ ok: false });
  });

  test("the inbox's caps apply: one file, a rolling day, the stored total", async () => {
    const big = new Request(`${ORIGIN}/api/import/files`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        host: "lianki.com",
        "content-length": String(INBOX.maxFileBytes + 1),
        "x-file-name": "big.zip",
      },
      body: "x",
    });
    expect((await uploadImportFile(big, deps)).status).toBe(413);
    const limited = { ...deps, allow: () => false };
    expect((await uploadImportFile(put("a.txt", "a"), limited)).status).toBe(429);
  });
});

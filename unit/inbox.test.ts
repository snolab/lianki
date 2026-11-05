/**
 * The chat inbox (lib/inbox/; docs/dev-debug-widget.md, "Attachments and the
 * inbox"): the owner gate, the caps, content sniffing, the R2 key layout,
 * the served headers, usage metering, agent tickets, and the widget's side.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import { INBOX, INBOX_PREFIX } from "../lib/inbox/config";
import { MONTH_MS, storageUsd } from "../lib/inbox/charge";
import { fileHeaders, inboxKey, isInboxId, newInboxId } from "../lib/inbox/keys";
import { sniff } from "../lib/inbox/sniff";
import {
  type InboxBucket,
  type InboxDeps,
  download,
  link,
  list,
  remove,
  upload,
} from "../lib/inbox/handlers";
import { inboxOp } from "../lib/inbox/agent";
import { type InboxDb, usageOf } from "../lib/inbox/store";
import { cleanAttachments, cleanFileName } from "../packages/debug-chat/src/wire";
import {
  type ChatFiles,
  createPendingFiles,
  dragHasFiles,
  filesFrom,
  formatSize,
  isInlineImage,
} from "../packages/debug-chat/src/files";

const SCHEMA =
  "CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT);\n" +
  readFileSync(new URL("../db/migrations/0035_inbox.sql", import.meta.url), "utf8");
const OWNER = { id: "u1", email: "owner@example.com", owner: true };
const FRIEND = { id: "u2", email: "friend@example.com", owner: false };
const T0 = 1_800_000_000_000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const enc = (s: string) => new TextEncoder().encode(s);

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

let db: InboxDb;
let rawDb: ReturnType<ReturnType<typeof createTestD1>["raw"]>;
let bucket: ReturnType<typeof memBucket>;
let who: typeof OWNER | typeof FRIEND | null;
let now: number;
let deps: InboxDeps;
beforeEach(() => {
  const d = createTestD1(SCHEMA);
  d.raw().exec(
    "INSERT INTO user (id, email) VALUES ('u1', 'owner@example.com'), ('u2', 'friend@example.com')",
  );
  d.raw().exec(
    `CREATE TABLE site_role (email TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'owner', revoked_at INTEGER);
     INSERT INTO site_role (email) VALUES ('owner@example.com')`,
  );
  rawDb = d.raw();
  db = d as unknown as InboxDb;
  bucket = memBucket();
  who = OWNER;
  now = T0;
  deps = { who: async () => who, db: () => db, bucket: () => bucket, now: () => now };
});

const post = (body: Uint8Array, name = "a.png", len = body.length) =>
  new Request("https://x/api/dev/inbox", {
    method: "POST",
    headers: {
      "content-length": String(len),
      "x-file-name": encodeURIComponent(name),
      "content-type": "image/png",
    },
    body: body as Uint8Array<ArrayBuffer>,
  });

describe("the owner gate", () => {
  test("nobody but the owner uploads, lists, downloads or deletes: 404", async () => {
    for (const w of [null, FRIEND]) {
      who = w;
      expect((await upload(post(PNG), deps)).status).toBe(404);
      expect((await list(deps)).status).toBe(404);
    }
    who = OWNER;
    const { id } = (await (await upload(post(PNG), deps)).json()) as { id: string };
    who = FRIEND;
    expect((await download(new Request("https://x"), id, deps)).status).toBe(404);
    expect((await remove(id, deps)).status).toBe(404);
    who = null;
    expect((await remove(id, deps)).status).toBe(404);
    expect(bucket.store.size).toBe(1);
  });

  test("a rate limit answers 429", async () => {
    expect((await upload(post(PNG), { ...deps, allow: () => false })).status).toBe(429);
  });
});

describe("caps", () => {
  test("a file over the per-file cap is refused before anything is stored", async () => {
    const r = await upload(post(PNG, "a.png", INBOX.maxFileBytes + 1), deps);
    expect(r.status).toBe(413);
    expect(((await r.json()) as { error: string }).error).toBe("too-big");
    expect(bucket.store.size).toBe(0);
  });

  test("the rolling-day total and the storage safety cap", async () => {
    (db as unknown as { raw(): { exec(s: string): void } })
      .raw()
      .exec(
        `INSERT INTO inbox_item (id, owner_id, name, type, size, sha256, r2_key, created_ms) VALUES ('${"a".repeat(20)}', 'u1', 'x', 'image/png', ${INBOX.maxDayBytes}, '', 'k', ${T0 - 1000})`,
      );
    expect(((await (await upload(post(PNG), deps)).json()) as { error: string }).error).toBe(
      "day-cap",
    );
    now = T0 + 25 * 3600_000; // a day later it counts no more
    expect((await upload(post(PNG), deps)).status).toBe(201);
    (db as unknown as { raw(): { exec(s: string): void } })
      .raw()
      .exec(`UPDATE inbox_usage SET bytes_stored = ${INBOX.maxStoredBytes} WHERE user_id = 'u1'`);
    expect(((await (await upload(post(PNG), deps)).json()) as { error: string }).error).toBe(
      "storage-cap",
    );
  });

  test("more bytes than announced is refused and nothing is kept", async () => {
    const r = await upload(post(PNG, "a.png", 4), deps);
    expect(r.status).toBe(400);
    expect(bucket.store.size).toBe(0);
  });
});

describe("sniffing", () => {
  test("the type comes from the bytes, never the claim", () => {
    expect(sniff(PNG, "text/html").type).toBe("image/png");
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).type).toBe("image/jpeg");
    expect(sniff(enc("GIF89a....")).type).toBe("image/gif");
    expect(sniff(enc("RIFF\0\0\0\0WEBPVP8 ")).type).toBe("image/webp");
    expect(sniff(enc("\0\0\0\x18ftypheic")).type).toBe("image/heic");
    expect(sniff(enc("\0\0\0\x18ftypisom")).type).toBe("video/mp4");
    expect(sniff(enc("%PDF-1.7")).type).toBe("application/pdf");
    // An Anki package (.apkg) is a zip.
    expect(sniff(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])).type).toBe("application/zip");
  });

  test("markup is stored as plain text; executables are flagged", () => {
    expect(sniff(enc("<!doctype html><script>alert(1)</script>"), "text/html").type).toBe(
      "text/plain",
    );
    expect(sniff(enc("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml").type).toBe(
      "text/plain",
    );
    expect(sniff(enc("# notes"), "text/markdown").type).toBe("text/markdown");
    expect(sniff(enc("MZ\x90\0"))).toEqual({ type: "application/octet-stream", executable: true });
    expect(sniff(new Uint8Array([0x7f, 0x45, 0x4c, 0x46])).executable).toBe(true);
    expect(sniff(enc("#!/bin/sh\nrm -rf /")).executable).toBe(true);
    expect(sniff(new Uint8Array([0, 1, 2, 3, 0xfe])).type).toBe("application/octet-stream");
  });
});

describe("keys and serving", () => {
  test("inbox/<user>/<yyyy>/<mm>/<id>: never the file's name", () => {
    const id = newInboxId();
    expect(isInboxId(id)).toBe(true);
    expect(inboxKey("u1", id, Date.UTC(2026, 10, 4))).toBe(`${INBOX_PREFIX}u1/2026/11/${id}`);
    expect(() => inboxKey("../x", id, T0)).toThrow();
    expect(() => inboxKey("u1", "../../etc", T0)).toThrow();
  });

  test("only a safe image is inline; everything else downloads, sandboxed, never sniffed", () => {
    const img = fileHeaders({ name: "a.png", type: "image/png", size: 3 });
    expect(img.get("content-disposition")).toStartWith("inline;");
    for (const type of [
      "text/plain",
      "application/octet-stream",
      "application/pdf",
      "image/heic",
    ]) {
      const h = fileHeaders({ name: 'x"y\n.html', type, size: 3 });
      expect(h.get("content-disposition")).toStartWith("attachment;");
      expect(h.get("content-disposition")).not.toContain("\n");
      expect(h.get("x-content-type-options")).toBe("nosniff");
      expect(h.get("content-security-policy")).toContain("sandbox");
    }
  });
});

describe("upload, usage and cost", () => {
  test("stored in R2 under inbox/, a row with its sha256, usage in the same batch", async () => {
    const r = await upload(post(PNG, "dir/../photo.png"), deps);
    expect(r.status).toBe(201);
    const ref = (await r.json()) as { id: string; name: string; type: string; size: number };
    expect(ref).toMatchObject({ name: "photo.png", type: "image/png", size: PNG.length });
    const [key] = [...bucket.store.keys()];
    expect(key).toStartWith("inbox/u1/");
    const body = (await (await list(deps)).json()) as {
      items: { id: string }[];
      usage: { bytesStored: number; items: number };
    };
    expect(body.items.map((i) => i.id)).toEqual([ref.id]);
    expect(body.usage).toMatchObject({ bytesStored: PNG.length, items: 1 });
    const got = await download(new Request("https://x"), ref.id, deps);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    const sha = createHash("sha256").update(PNG).digest("hex");
    const agent = await inboxOp(db, { op: "list" }, { now: () => now });
    expect(agent).toMatchObject({ ok: true, items: [{ id: ref.id, sha256: sha }] });
  });

  test("delete lowers usage (uploaded stays), and storage accrues by bytes × time", async () => {
    const { id } = (await (await upload(post(PNG), deps)).json()) as { id: string };
    now = T0 + MONTH_MS;
    expect((await remove(id, deps)).status).toBe(200);
    const u = await usageOf(db, OWNER.id);
    expect(u).toMatchObject({
      bytesStored: 0,
      bytesUploaded: PNG.length,
      items: 0,
      settledMs: now,
    });
    expect(bucket.store.size).toBe(0);
    expect(storageUsd(1024 ** 3, MONTH_MS)).toBeCloseTo(INBOX.r2.storageUsdPerGbMonth, 10);
  });
});

describe("edges", () => {
  test("link: the line id lands on the owner's own rows; junk is a 400", async () => {
    const { id } = (await (await upload(post(PNG), deps)).json()) as { id: string };
    const patch = (body: unknown) =>
      link(new Request("https://x", { method: "PATCH", body: JSON.stringify(body) }), deps);
    expect((await patch({ ids: [id], line: "line_1" })).status).toBe(200);
    expect((await patch({ ids: ["nope"], line: "x" })).status).toBe(400);
    expect((await patch({ ids: [id], line: "bad line!" })).status).toBe(400);
    const agent = (await inboxOp(db, { op: "list" }, {})) as {
      items: { line?: string }[];
    };
    expect(agent.items[0]?.line).toBe("line_1");
    who = FRIEND;
    expect((await patch({ ids: [id], line: "x" })).status).toBe(404);
  });

  test("a body in many chunks is streamed whole; no length is a 411; a bad name is 'file'", async () => {
    const chunks = [PNG, new Uint8Array(600).fill(1), new Uint8Array(300).fill(2)];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        for (const c of chunks) ctl.enqueue(c);
        ctl.close();
      },
    });
    const req = new Request("https://x", {
      method: "POST",
      headers: { "content-length": String(total), "x-file-name": "%E0%A4%A" },
      body,
      duplex: "half",
    } as RequestInit);
    const r = await upload(req, deps);
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ name: "file", type: "image/png", size: total });
    expect([...bucket.store.values()][0]?.length).toBe(total);
    const none = new Request("https://x", { method: "POST" });
    expect((await upload(none, deps)).status).toBe(411);
  });

  test("fewer bytes than announced, or a failing R2 put: nothing is kept", async () => {
    expect((await upload(post(PNG, "a.png", PNG.length + 10), deps)).status).toBe(400);
    // The clean-up delete failing too changes nothing: still a 400.
    const noDelete = { ...bucket, delete: async () => Promise.reject(new Error("r2 down")) };
    const short = post(PNG, "a.png", PNG.length + 10);
    expect((await upload(short, { ...deps, bucket: () => noDelete })).status).toBe(400);
    bucket.store.clear(); // what that failed delete left behind
    const broken = { ...noDelete, put: async () => Promise.reject(new Error("r2 down")) };
    expect((await upload(post(PNG), { ...deps, bucket: () => broken })).status).toBe(400);
    expect(bucket.store.size).toBe(0);
    // A body R2 stops reading: the reader is cancelled with it.
    const lazy = {
      ...bucket,
      put: async (_k: string, b: ReadableStream<Uint8Array>) => {
        await b.cancel("stop");
        throw new Error("r2 stopped reading");
      },
    };
    const big = new Uint8Array(4096).fill(65);
    expect((await upload(post(big, "a.txt"), { ...deps, bucket: () => lazy })).status).toBe(400);
  });
});

describe("agent tickets", () => {
  test("single use, 60 s, in a header; done marks it processed; friends' files unreachable", async () => {
    const { id } = (await (await upload(post(PNG), deps)).json()) as { id: string };
    const opts = { now: () => now };
    const t = (await inboxOp(db, { op: "get", id }, opts)) as { ticket: string };
    who = null;
    const get = () =>
      download(new Request("https://x", { headers: { "x-inbox-ticket": t.ticket } }), id, deps);
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(404);
    const t2 = (await inboxOp(db, { op: "get", id }, opts)) as { ticket: string };
    now = T0 + INBOX.ticketMs + 1;
    expect(
      (
        await download(
          new Request("https://x", { headers: { "x-inbox-ticket": t2.ticket } }),
          id,
          deps,
        )
      ).status,
    ).toBe(404);
    expect(await inboxOp(db, { op: "done", id }, opts)).toEqual({ ok: true, done: id });
    expect(await inboxOp(db, { op: "rm", id }, opts)).toEqual({ ok: false, error: "bad inbox op" });
    rawDb.exec("UPDATE site_role SET revoked_at = 1"); // a revoked owner: no one's files
    expect(await inboxOp(db, { op: "list" }, {})).toEqual({ ok: true, items: [] });
  });
});

describe("the widget's side", () => {
  test("refs from the wire: checked ids, safe names, at most ten", () => {
    expect(cleanFileName("C:\\Users\\a\\b\u202e.exe")).toBe("b.exe");
    expect(cleanFileName("")).toBe("file");
    expect(
      cleanAttachments([
        { id: "ok_1", name: "a.png", type: "image/png", size: 3 },
        { id: "bad id!", name: "x" },
        { id: "ok_2", name: "b", type: "text/html<script>", size: -1 },
      ]),
    ).toEqual([
      { id: "ok_1", name: "a.png", type: "image/png", size: 3 },
      { id: "ok_2", name: "b", type: "application/octet-stream", size: 0 },
    ]);
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `i${i}`,
      name: "n",
      type: "a/b",
      size: 1,
    }));
    expect(cleanAttachments(many)).toHaveLength(10);
    expect(cleanAttachments("nope")).toBeUndefined();
  });

  test("pending files: upload, too big, remove, take", async () => {
    let finish: (v: { id: string; name: string; type: string; size: number }) => void = () => {};
    const p = createPendingFiles({
      files: () => ({
        maxBytes: 10,
        url: () => "",
        upload: (f) => new Promise((ok) => (finish = (v) => ok({ ...v, name: f.name }))),
      }),
    });
    p.add([new File(["abc"], "a.txt"), new File(["x".repeat(11)], "big.bin")]);
    expect(p.get().map((x) => x.state)).toEqual(["uploading", "too-big"]);
    expect(p.busy()).toBe(true);
    finish({ id: "r1", name: "", type: "text/plain", size: 3 });
    await Bun.sleep(0);
    expect(p.busy()).toBe(false);
    p.remove(p.get()[1]!.key);
    expect(p.take()).toEqual([{ id: "r1", name: "a.txt", type: "text/plain", size: 3 }]);
    expect(p.get()).toEqual([]);
  });

  test("pending files: aborting a running upload, failures, thumbnails, no host", async () => {
    const revoked: string[] = [];
    let host: ChatFiles | undefined = {
      url: () => "",
      upload: (_f, onProgress, signal) =>
        new Promise((_ok, no) => {
          onProgress(1, 3);
          signal.addEventListener("abort", () => no(new Error("aborted")));
        }),
    };
    const p = createPendingFiles({
      files: () => host,
      objectUrl: { create: () => "blob:1", revoke: (u) => revoked.push(u) },
    });
    let ticks = 0;
    const off = p.subscribe(() => ticks++);
    p.add([new File(["abc"], "a.png", { type: "image/png" })]);
    expect(p.get()[0]).toMatchObject({ thumb: "blob:1", sent: 1, state: "uploading" });
    p.remove(p.get()[0]!.key);
    await Bun.sleep(0);
    expect(p.get()).toEqual([]);
    expect(revoked).toEqual(["blob:1"]);
    host = { url: () => "", upload: () => Promise.reject(new Error("HTTP 500")) };
    p.add([new File(["x"], "b.bin")]);
    await Bun.sleep(0);
    expect(p.get()[0]?.state).toBe("failed");
    expect(p.take()).toEqual([]);
    p.remove("missing");
    off();
    expect(ticks).toBeGreaterThan(2);
    host = undefined;
    p.add([new File(["x"], "c.bin")]);
    expect(p.get()).toEqual([]);
    expect(dragHasFiles({ types: ["Files"] })).toBe(true);
    expect(dragHasFiles({ types: ["text/plain"] })).toBe(false);
    expect(isInlineImage("image/png")).toBe(true);
    expect(isInlineImage("image/svg+xml")).toBe(false);
    expect(filesFrom(null)).toEqual([]);
    expect(formatSize(-1)).toBe("");
  });

  test("files from a paste or a drop; sizes for a chip", () => {
    const f = new File(["x"], "shot.png", { type: "image/png" });
    expect(
      filesFrom({
        items: [
          { kind: "string", getAsFile: () => null },
          { kind: "file", getAsFile: () => f },
        ],
      }),
    ).toEqual([f]);
    expect(filesFrom({ files: [f] })).toEqual([f]);
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(20 * 1024 * 1024)).toBe("20 MB");
  });
});

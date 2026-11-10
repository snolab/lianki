/**
 * The user's own file store across sources (lib/import/files.ts, /my/files):
 * only the uploader lists, reads or deletes a file (anyone else: 404); a
 * delete removes the R2 object; /self-intro uploads under their own source
 * and its import reads them on the server; the browser helpers (upload with
 * progress, delete with Undo).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import type { InboxBucket } from "../lib/inbox/handlers";
import type { InboxDb } from "../lib/inbox/store";
import {
  type ImportFilesDeps,
  deleteMyFile,
  listImportFiles,
  listMyFiles,
  readMyFile,
  uploadImportFile,
  uploadSourceOf,
} from "../lib/import/files";
import { FOLDERS, folderOf } from "../lib/import/my-files";
import {
  UNDO_MS,
  pendingDeletes,
  uploadErrorOf,
  uploadFile,
  type XhrLike,
} from "../lib/import/uploads-client";
import {
  ImportBody,
  handleImport,
  handleImportQuota,
  minImportHoldUsd,
  type ImportDeps,
} from "../lib/self-intro/import-handler";
import { reserveCredits } from "../lib/payments/ai-credits";

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
const ORIGIN = "https://lianki.com";

let db: InboxDb;
let raw: ReturnType<ReturnType<typeof createTestD1>["raw"]>;
let bucket: ReturnType<typeof memBucket>;
let who: typeof ALICE | null;
let deps: ImportFilesDeps;
let logs: ReturnType<typeof spyOn>;
beforeEach(() => {
  const d = createTestD1(SCHEMA);
  raw = d.raw();
  db = d as unknown as InboxDb;
  bucket = memBucket();
  who = ALICE;
  deps = {
    who: async () => who,
    db: () => db,
    bucket: () => bucket,
    now: () => 1_800_000_000_000,
    on: async () => true,
  };
  logs = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logs.mockRestore());

const put = (name: string, body: string, source?: string) =>
  new Request(`${ORIGIN}/api/import/files${source ? `?source=${source}` : ""}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      host: "lianki.com",
      "content-type": "text/plain",
      "content-length": String(new TextEncoder().encode(body).length),
      "x-file-name": encodeURIComponent(name),
    },
    body,
  });
const del = (id: string) =>
  new Request(`${ORIGIN}/api/my/files/${id}`, {
    method: "DELETE",
    headers: { origin: ORIGIN, host: "lianki.com" },
  });
const upload = async (name: string, body: string, source?: string) =>
  (await (await uploadImportFile(put(name, body, source), deps)).json()) as { id: string };

describe("My Files: one store, folders by origin, the owner only", () => {
  test("uploads land under their source; /my/files lists every source", async () => {
    const a = await upload("cv.pdf", "%PDF", "self-intro");
    const b = await upload("words.csv", "a,b", "import");
    const c = await upload("plain.txt", "x");
    raw.exec(
      `INSERT INTO inbox_item (id, owner_id, name, type, size, sha256, r2_key, created_ms, source) VALUES ('${"c".repeat(20)}', 'u1', 'photo.png', 'image/png', 1, 'x', 'k', 1, 'chat')`,
    );
    const { items } = (await (await listMyFiles(deps)).json()) as {
      items: { id: string; source: string }[];
    };
    const src = Object.fromEntries(items.map((i) => [i.id, i.source]));
    expect(src).toMatchObject({ [a.id]: "self-intro", [b.id]: "import", [c.id]: "import" });
    expect(src["c".repeat(20)]).toBe("chat");
    // The per-source list keeps to its source.
    const self = (await (
      await listImportFiles(deps, new Request(`${ORIGIN}/x?source=self-intro`))
    ).json()) as { items: { id: string }[] };
    expect(self.items.map((i) => i.id)).toEqual([a.id]);
  });

  test("an unknown source is refused", async () => {
    expect((await uploadImportFile(put("a.txt", "a", "chat"), deps)).status).toBe(400);
    expect(uploadSourceOf(new Request(`${ORIGIN}/x?source=../x`))).toBeNull();
    expect(uploadSourceOf(new Request(`${ORIGIN}/x`))).toBe("import");
    expect((await listImportFiles(deps, new Request(`${ORIGIN}/x?source=nope`))).status).toBe(400);
  });

  test("another user gets 404 for both read and delete; the owner reads it back as an attachment", async () => {
    const a = await upload("notes.txt", "secret notes", "self-intro");
    who = BOB;
    expect((await readMyFile(a.id, deps)).status).toBe(404);
    expect((await deleteMyFile(del(a.id), a.id, deps)).status).toBe(404);
    expect(((await (await listMyFiles(deps)).json()) as { items: unknown[] }).items).toEqual([]);
    expect(bucket.store.size).toBe(1);
    who = ALICE;
    const r = await readMyFile(a.id, deps);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("secret notes");
    expect(r.headers.get("content-disposition")).toStartWith("attachment");
    expect(r.headers.get("cache-control")).toContain("private");
    expect((await readMyFile("nope", deps)).status).toBe(404);
  });

  test("delete removes the R2 object and the row, whatever the source", async () => {
    const a = await upload("cv.pdf", "%PDF", "self-intro");
    expect(bucket.store.size).toBe(1);
    const key = [...bucket.store.keys()][0]!;
    expect(key).toMatch(/^inbox\/u1\/\d{4}\/\d{2}\/[0-9a-f]{20}$/);
    const dropped: string[] = [];
    const withDrop = {
      ...deps,
      dropDerived: async (u: string, f: string) => void dropped.push(`${u}/${f}`),
    };
    expect((await deleteMyFile(del("f".repeat(20)), "f".repeat(20), withDrop)).status).toBe(404);
    expect(dropped).toEqual([]);
    expect((await deleteMyFile(del(a.id), a.id, withDrop)).status).toBe(200);
    // Its cached AI chunks go with it.
    expect(dropped).toEqual([`u1/${a.id}`]);
    expect(bucket.store.has(key)).toBe(false);
    expect((await readMyFile(a.id, deps)).status).toBe(404);
  });

  test("the gate, a guest, cross-site", async () => {
    const off = { ...deps, on: async () => false };
    expect((await listMyFiles(off)).status).toBe(404);
    expect((await readMyFile("x", off)).status).toBe(404);
    expect((await deleteMyFile(del("x"), "x", off)).status).toBe(404);
    who = null;
    expect((await listMyFiles(deps)).status).toBe(401);
    expect((await readMyFile("x", deps)).status).toBe(401);
    expect((await deleteMyFile(del("x"), "x", deps)).status).toBe(401);
    const evil = new Request(`${ORIGIN}/api/my/files/x`, {
      method: "DELETE",
      headers: { origin: "https://evil.example", host: "lianki.com" },
    });
    expect((await deleteMyFile(evil, "x", deps)).status).toBe(403);
  });

  test("folders: each source its own, anything else in Other", () => {
    expect(folderOf("self-intro")).toBe("selfIntro");
    expect(folderOf("import")).toBe("import");
    expect(folderOf("chat")).toBe("chat");
    expect(folderOf("future")).toBe("other");
    expect(folderOf("constructor")).toBe("other");
    expect(FOLDERS).toEqual(["selfIntro", "import", "chat", "other"]);
  });
});

describe("the browser helpers", () => {
  function fakeXhr(status: number, body: string) {
    const x: XhrLike & { sent?: Blob; headers: Record<string, string>; url?: string } = {
      headers: {},
      status: 0,
      responseText: "",
      upload: { onprogress: null },
      onload: null,
      onerror: null,
      onabort: null,
      open(_m, url) {
        x.url = url;
      },
      setRequestHeader(k, v) {
        x.headers[k] = v;
      },
      send(b) {
        x.sent = b;
        x.upload.onprogress?.({ loaded: 5, total: 10, lengthComputable: true });
        x.status = status;
        x.responseText = body;
        queueMicrotask(() => x.onload?.());
      },
      abort() {
        x.onabort?.();
      },
    };
    return x;
  }
  const file = Object.assign(new Blob(["hello"], { type: "text/plain" }), { name: "a b.txt" });

  test("upload: progress, the id, the name encoded, the source in the URL", async () => {
    const x = fakeXhr(201, '{"id":"abc"}');
    const seen: number[] = [];
    const up = uploadFile(
      file,
      "self-intro",
      (p) => seen.push(p),
      () => x,
    );
    expect(await up.done).toEqual({ ok: true, id: "abc" });
    expect(seen).toEqual([0.5, 1]);
    expect(x.url).toBe("/api/import/files?source=self-intro");
    expect(x.headers["x-file-name"]).toBe("a%20b.txt");
  });

  test("upload: refusals named; network error; abort", async () => {
    expect(
      await uploadFile(
        file,
        "import",
        () => {},
        () => fakeXhr(413, "{}"),
      ).done,
    ).toEqual({
      ok: false,
      error: "too-large",
    });
    expect(
      await uploadFile(
        file,
        "import",
        () => {},
        () => fakeXhr(413, '{"error":"day-cap"}'),
      ).done,
    ).toEqual({ ok: false, error: "full" });
    expect(
      await uploadFile(
        file,
        "import",
        () => {},
        () => fakeXhr(500, "nope"),
      ).done,
    ).toEqual({
      ok: false,
      error: "failed",
    });
    const broken = fakeXhr(0, "");
    broken.send = () => queueMicrotask(() => broken.onerror?.());
    expect(
      await uploadFile(
        file,
        "import",
        () => {},
        () => broken,
      ).done,
    ).toEqual({
      ok: false,
      error: "failed",
    });
    const slow = fakeXhr(0, "");
    slow.send = () => {};
    const up = uploadFile(
      file,
      "import",
      () => {},
      () => slow,
    );
    up.abort();
    expect(await up.done).toEqual({ ok: false, error: "aborted" });
    expect(uploadErrorOf(429, null)).toBe("rate");
    expect(uploadErrorOf(413, "storage-cap")).toBe("full");
  });

  test("delete with Undo: sent after the window, cancelled by Undo, flushed when leaving", () => {
    const sent: string[] = [];
    const timers = new Map<number, () => void>();
    let n = 0;
    const d = pendingDeletes(async (id) => sent.push(id), {
      set: (fn, ms) => {
        expect(ms).toBe(UNDO_MS);
        timers.set(++n, fn);
        return n;
      },
      clear: (t) => timers.delete(t as number),
    });
    d.remove("a");
    d.remove("a");
    d.remove("b");
    d.remove("c");
    expect(d.pending()).toEqual(["a", "b", "c"]);
    expect(d.undo("b")).toBe(true);
    expect(d.undo("zz")).toBe(false);
    timers.get(1)!();
    expect(sent).toEqual(["a"]);
    d.flush();
    expect(sent).toEqual(["a", "c"]);
    expect(d.pending()).toEqual([]);
  });
});

test("delete with Undo, as the page uses it: the real timer and fetch", () => {
  const calls: string[] = [];
  const f = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    calls.push(url);
    return new Response(null);
  }) as unknown as typeof fetch);
  const d = pendingDeletes();
  d.remove("z1");
  d.remove("z2");
  expect(d.undo("z2")).toBe(true);
  d.flush();
  expect(calls).toEqual(["/api/my/files/z1"]);
  f.mockRestore();
});

describe("/self-intro reads the user's stored files", () => {
  const facts = JSON.stringify({ facts: [{ field: "hobby", value: "baking", certain: true }] });
  let sentBodies: string[] = [];
  const base = (over: Partial<ImportDeps> = {}): ImportDeps => ({
    user: { id: "u1", email: "u1@example.com" },
    owner: false,
    flags: { "self-intro.import": true },
    configured: true,
    complete: async (body) => {
      sentBodies.push(JSON.stringify(body));
      return { choices: [{ message: { content: facts } }] };
    },
    readFile: async (userId, id) =>
      userId === "u1" && id === "a".repeat(20)
        ? { name: "cv.txt", type: "text/plain", bytes: new TextEncoder().encode("I bake bread.") }
        : userId === "u1" && id === "b".repeat(20)
          ? { name: "x.mp4", type: "video/mp4", bytes: new Uint8Array([1]) }
          : null,
    ...over,
  });
  const post = (body: unknown) =>
    new Request(`${ORIGIN}/api/self-intro/import`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, host: "lianki.com" },
      body: JSON.stringify(body),
    });
  beforeEach(() => {
    sentBodies = [];
  });

  test("the stored file's text goes to the model after what was typed", async () => {
    const r = await handleImport(post({ text: "Hi", fileIds: ["a".repeat(20)] }), base());
    expect(r.status).toBe(200);
    expect(sentBodies[0]).toContain("Hi");
    expect(sentBodies[0]).toContain("--- cv.txt ---");
    expect(sentBodies[0]).toContain("I bake bread.");
  });

  test("a file that is not theirs or cannot be read is named; the rest goes on", async () => {
    const r = await handleImport(
      post({ text: "Hi", fileIds: ["a".repeat(20), "b".repeat(20), "f".repeat(20)] }),
      base(),
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { fileErrors: unknown }).fileErrors).toEqual([
      { id: "b".repeat(20), code: "unsupported" },
      { id: "f".repeat(20), code: "not-found" },
    ]);
    const only = await handleImport(post({ fileIds: ["f".repeat(20)] }), base());
    expect(only.status).toBe(400);
    expect(ImportBody.safeParse({ fileIds: ["../x"] }).success).toBe(false);
  });

  test("GET: may this user start (credits for the smallest hold)?", async () => {
    const need = reserveCredits(minImportHoldUsd());
    expect(await (await handleImportQuota(base({ admin: () => true }))).json()).toEqual({
      on: true,
      available: true,
      need,
      have: need,
      recommended: need,
    });
    expect(await (await handleImportQuota(base({ flags: {}, owner: false }))).json()).toMatchObject(
      { on: false, available: false },
    );
    expect((await handleImportQuota(base({ user: null }))).status).toBe(401);
  });
});

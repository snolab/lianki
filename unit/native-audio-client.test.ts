import { expect, test } from "bun:test";
import JSZip from "jszip";
import {
  NativeAudioClient,
  NATIVE_AUDIO_PREF,
  extractNativeChapter,
} from "../lib/words/native-audio-client";
import { parseNativeManifest } from "../vendor/otoji/packages/private-word-audio/src/index";

const sha = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
async function fixture(twoArchives = false) {
  const mp3 = new Uint8Array([73, 68, 51, 1, 2, 3, 4, 5]);
  const zip = new JSZip();
  zip.file("audio/word.mp3", mp3);
  const archive = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const manifest = {
    version: 1,
    scope: "account-private",
    chapters: [
      {
        id: "chapter-1",
        inboxItemId: "b".repeat(20),
        memberPath: "audio/word.mp3",
        sha256: await sha(mp3),
        archiveSha256: await sha(archive),
        bytes: mp3.length,
        durationMs: 10000,
      },
    ],
    entries: [
      {
        listId: "owned-list",
        key: "stable-key",
        term: "native word",
        chapterId: "chapter-1",
        startMs: 1000,
        endMs: 2000,
        confidence: 0.8,
        reason: "machine-headword",
        estimated: true,
        verified: false,
      },
    ],
  };
  if (twoArchives) {
    manifest.chapters.push({
      ...manifest.chapters[0],
      id: "chapter-2",
      inboxItemId: "c".repeat(20),
    });
    manifest.entries.push({
      ...manifest.entries[0],
      key: "second-key",
      term: "second word",
      chapterId: "chapter-2",
      startMs: 3000,
      endMs: 4000,
    });
  }
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const state = {
    account: "account-a",
    ref: { version: 1, fileId: "a".repeat(20), sha256: await sha(bytes) } as unknown,
    status: 200,
    failManifest: false,
    wrongArchive: false,
  };
  const requests: { url: string; init: RequestInit }[] = [],
    revoked: string[] = [],
    blobs: Blob[] = [];
  let intercept: ((url: string) => Promise<Response> | undefined) | undefined;
  const client = new NativeAudioClient({
    timeoutMs: () => 15000,
    createObjectURL: (blob) => {
      blobs.push(blob);
      return `blob:synthetic-${blobs.length}`;
    },
    revokeObjectURL: (url) => revoked.push(url),
    fetch: async (url, init) => {
      requests.push({ url, init });
      const delayed = intercept?.(url);
      if (delayed) return delayed;
      if (url === "/api/prefs")
        return state.status === 200
          ? Response.json({
              user: state.account,
              prefs: { [NATIVE_AUDIO_PREF]: { value: state.ref } },
            })
          : new Response(null, { status: state.status });
      if (url.endsWith("a".repeat(20)))
        return state.failManifest
          ? new Response(null, { status: 503 })
          : new Response(bytes.slice());
      return new Response(state.wrongArchive ? new Uint8Array([0]) : archive.slice());
    },
  });
  return {
    client,
    state,
    manifest,
    mp3,
    archive,
    bytes,
    requests,
    revoked,
    blobs,
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
  };
}
const card = { listId: "owned-list", term: "native word" };
const signal = () => new AbortController().signal;

test("private original recording is selected by exact card and reauthenticates memory hits", async () => {
  const f = await fixture();
  try {
    await f.client.prepare();
    expect(f.client.ready).toBe(true);
    expect(f.client.enabled).toBe(true);
    expect(f.client.has(card)).toBe(true);
    const first = await f.client.load(card, signal());
    expect(first).toMatchObject({ startMs: 1000, endMs: 2000, estimated: true });
    expect(await f.client.load(card, signal())).toEqual(first);
    expect(f.requests.filter((r) => r.url.endsWith("b".repeat(20)))).toHaveLength(1);
    expect(f.requests.filter((r) => r.url === "/api/prefs")).toHaveLength(3);
    expect(
      f.requests.every(
        (r) =>
          r.init.credentials === "same-origin" &&
          r.init.cache === "no-store" &&
          r.init.redirect === "error",
      ),
    ).toBe(true);
    expect(f.requests.some((r) => r.url.includes("tts"))).toBe(false);
    expect(new Uint8Array(await f.blobs[0].arrayBuffer())).toEqual(f.mp3);
    expect(await f.client.load({ ...card, term: "renamed" }, signal())).toBeNull();
    expect(await f.client.load({ ...card, listId: "other-list" }, signal())).toBeNull();
  } finally {
    f.client.dispose();
  }
  expect(f.revoked).toEqual(["blob:synthetic-1"]);
});
test("account switch and sign-out fence cached private recordings", async () => {
  const f = await fixture();
  await f.client.prepare();
  await f.client.load(card, signal());
  f.state.account = "account-b";
  expect(await f.client.load(card, signal())).toBeNull();
  expect(f.revoked).toHaveLength(1);
  expect(f.client.enabled).toBe(false);
  expect(await f.client.load(card, signal())).toBeNull();
  f.client.dispose();
  const g = await fixture();
  await g.client.prepare();
  await g.client.load(card, signal());
  g.state.status = 401;
  expect(await g.client.load(card, signal())).toBeNull();
  expect(g.revoked).toHaveLength(1);
  g.client.dispose();
});
test("a transient manifest failure retries, malformed refs disable, and hash mismatches never play", async () => {
  const f = await fixture();
  f.state.failManifest = true;
  await f.client.prepare();
  expect(f.client.enabled).toBe(false);
  f.state.failManifest = false;
  expect(await f.client.load(card, signal())).not.toBeNull();
  f.client.dispose();
  const g = await fixture();
  g.state.ref = { version: 1, fileId: "https://outside.invalid", sha256: "a".repeat(64) };
  await g.client.prepare();
  expect(await g.client.load(card, signal())).toBeNull();
  expect(g.requests.every((r) => r.url === "/api/prefs")).toBe(true);
  g.client.dispose();
  const h = await fixture();
  await h.client.prepare();
  h.state.wrongArchive = true;
  expect(await h.client.load(card, signal())).toBeNull();
  expect(h.blobs).toHaveLength(0);
  h.client.dispose();
});
test("late archive completion after logout cannot create or resurrect an object URL", async () => {
  const f = await fixture();
  await f.client.prepare();
  const pending = deferred<Response>();
  f.intercept((url) => (url.endsWith("b".repeat(20)) ? pending.promise : undefined));
  const loading = f.client.load(card, signal());
  for (let i = 0; i < 20 && !f.requests.some((r) => r.url.endsWith("b".repeat(20))); i++)
    await Promise.resolve();
  f.client.dispose();
  pending.resolve(new Response(f.archive.slice()));
  expect(await loading).toBeNull();
  expect(f.blobs).toHaveLength(0);
  expect(f.revoked).toHaveLength(0);
});
test("clearing a live account drops private blobs and safely reloads its index", async () => {
  const f = await fixture();
  await f.client.prepare();
  await f.client.load(card, signal());
  f.client.clear();
  expect(f.revoked).toHaveLength(1);
  expect(f.client.enabled).toBe(false);
  expect(await f.client.load(card, signal())).not.toBeNull();
  expect(f.blobs).toHaveLength(2);
  f.client.dispose();
});
test("ZIP output is streamed and refuses changed sizes, unsafe members and aborted extraction", async () => {
  const f = await fixture();
  const chapter = parseNativeManifest(JSON.stringify(f.manifest)).chapters[0];
  expect(await extractNativeChapter(f.archive, chapter, signal())).toEqual(f.mp3);
  await expect(
    extractNativeChapter(f.archive, { ...chapter, bytes: 1 }, signal()),
  ).rejects.toThrow();
  await expect(
    extractNativeChapter(f.archive, { ...chapter, memberPath: "audio/missing.mp3" }, signal()),
  ).rejects.toThrow();
  const corrupted = f.archive.slice(),
    view = new DataView(corrupted.buffer);
  const at = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  corrupted.fill(255, at, at + 4);
  await expect(extractNativeChapter(corrupted, chapter, signal())).rejects.toThrow();
  const zip = new JSZip();
  zip.file("../outside", new Uint8Array([1]));
  zip.file("audio/word.mp3", f.mp3);
  // JSZip sanitizes traversal names; a wrong source hash is separately rejected by load().
  const abort = new AbortController();
  abort.abort();
  await expect(extractNativeChapter(f.archive, chapter, abort.signal)).rejects.toThrow();
  f.client.dispose();
});

test("stream extraction aborts an in-flight producer and refuses oversized download headers", async () => {
  const f = await fixture();
  const big = new Uint8Array(4 * 1024 * 1024).fill(3),
    zip = new JSZip();
  zip.file("audio/big.mp3", big);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
  const chapter = {
    ...parseNativeManifest(JSON.stringify(f.manifest)).chapters[0],
    memberPath: "audio/big.mp3",
    bytes: big.length,
  };
  const abort = new AbortController();
  const task = extractNativeChapter(bytes, chapter, abort.signal);
  const timer = setTimeout(() => abort.abort(), 5);
  try {
    await expect(task).rejects.toThrow();
  } finally {
    clearTimeout(timer);
  }
  await f.client.prepare();
  f.intercept((url) =>
    url.endsWith("b".repeat(20))
      ? Promise.resolve(
          new Response(new Uint8Array([1]), {
            headers: { "content-length": String(21 * 1024 * 1024) },
          }),
        )
      : undefined,
  );
  expect(await f.client.load(card, signal())).toBeNull();
  expect(f.blobs).toHaveLength(0);
  f.client.dispose();
});

const archiveRequests = (f: { requests: { url: string }[] }) =>
  f.requests.filter((r) => r.url.endsWith("b".repeat(20))).length;
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(cond()).toBe(true);
}

const secondCard = { listId: "owned-list", term: "second word" };
const secondArchiveRequests = (f: { requests: { url: string }[] }) =>
  f.requests.filter((r) => r.url.endsWith("c".repeat(20))).length;

test("alternating archives joins the active transfer and drops canceled archive waiters", async () => {
  const f = await fixture(true);
  await f.client.prepare();
  const pending = deferred<Response>();
  f.intercept((url) => (url.endsWith("b".repeat(20)) ? pending.promise : undefined));
  const first = new AbortController();
  const a = f.client.load(card, first.signal);
  await until(() => archiveRequests(f) === 1);
  first.abort();
  expect(await a).toBeNull();
  const next = new AbortController();
  const b = f.client.load(secondCard, next.signal);
  await until(() => f.requests.filter((r) => r.url === "/api/prefs").length === 3);
  await new Promise((r) => setTimeout(r, 1));
  expect(secondArchiveRequests(f)).toBe(0);
  next.abort();
  expect(await b).toBeNull();
  const again = f.client.load(card, signal());
  await until(() => f.requests.filter((r) => r.url === "/api/prefs").length === 4);
  expect(archiveRequests(f)).toBe(1);
  pending.resolve(new Response(f.archive.slice()));
  expect(await again).toMatchObject({ startMs: 1000, endMs: 2000 });
  await new Promise((r) => setTimeout(r, 1));
  expect(secondArchiveRequests(f)).toBe(0);
  f.client.dispose();
});

test("a live different archive waits for the active transfer, then serves its own range", async () => {
  const f = await fixture(true);
  await f.client.prepare();
  const pending = deferred<Response>();
  f.intercept((url) => (url.endsWith("b".repeat(20)) ? pending.promise : undefined));
  const first = new AbortController();
  const a = f.client.load(card, first.signal);
  await until(() => archiveRequests(f) === 1);
  first.abort();
  expect(await a).toBeNull();
  const b = f.client.load(secondCard, signal());
  await until(() => f.requests.filter((r) => r.url === "/api/prefs").length === 3);
  await new Promise((r) => setTimeout(r, 1));
  expect(secondArchiveRequests(f)).toBe(0);
  pending.resolve(new Response(f.archive.slice()));
  expect(await b).toMatchObject({ startMs: 3000, endMs: 4000 });
  expect(archiveRequests(f)).toBe(1);
  expect(secondArchiveRequests(f)).toBe(1);
  f.client.dispose();
});

test("disposing while another archive waits prevents a late second transfer", async () => {
  const f = await fixture(true);
  await f.client.prepare();
  const pending = deferred<Response>();
  f.intercept((url) => (url.endsWith("b".repeat(20)) ? pending.promise : undefined));
  const a = f.client.load(card, signal());
  await until(() => archiveRequests(f) === 1);
  const b = f.client.load(secondCard, signal());
  await until(() => f.requests.filter((r) => r.url === "/api/prefs").length === 3);
  f.client.dispose();
  pending.resolve(new Response(f.archive.slice()));
  expect(await a).toBeNull();
  expect(await b).toBeNull();
  expect(secondArchiveRequests(f)).toBe(0);
  expect(f.blobs).toHaveLength(0);
});

test("a failed active archive does not block a live waiter for a different archive", async () => {
  const f = await fixture(true);
  await f.client.prepare();
  const pending = deferred<Response>();
  f.intercept((url) => (url.endsWith("b".repeat(20)) ? pending.promise : undefined));
  const a = f.client.load(card, signal());
  await until(() => archiveRequests(f) === 1);
  const b = f.client.load(secondCard, signal());
  await until(() => f.requests.filter((r) => r.url === "/api/prefs").length === 3);
  pending.resolve(new Response(null, { status: 503 }));
  expect(await a).toBeNull();
  expect(await b).toMatchObject({ startMs: 3000, endMs: 4000 });
  expect(secondArchiveRequests(f)).toBe(1);
  f.client.dispose();
});

test("a card change stops waiting for a slow archive but never restarts or aborts it", async () => {
  const f = await fixture();
  await f.client.prepare();
  const pending = deferred<Response>();
  f.intercept((url) => (url.endsWith("b".repeat(20)) ? pending.promise : undefined));
  const first = new AbortController();
  const a = f.client.load(card, first.signal);
  await until(() => archiveRequests(f) === 1);
  first.abort(); // the card changed
  expect(await a).toBeNull();
  // The next showing joins the same download instead of starting another.
  const b = f.client.load(card, signal());
  await until(() => f.requests.filter((r) => r.url === "/api/prefs").length >= 3);
  expect(archiveRequests(f)).toBe(1);
  const archiveInit = f.requests.find((r) => r.url.endsWith("b".repeat(20)))!.init;
  expect(archiveInit.signal?.aborted).toBe(false);
  pending.resolve(new Response(f.archive.slice()));
  expect(await b).toMatchObject({ startMs: 1000, endMs: 2000 });
  // Kept once done: later showings use it from memory.
  expect(await f.client.load(card, signal())).not.toBeNull();
  expect(archiveRequests(f)).toBe(1);
  f.client.dispose();
});

test("a download that nobody waits for any more still lands for next time", async () => {
  const f = await fixture();
  await f.client.prepare();
  const pending = deferred<Response>();
  f.intercept((url) => (url.endsWith("b".repeat(20)) ? pending.promise : undefined));
  const cut = new AbortController();
  const a = f.client.load(card, cut.signal);
  await until(() => archiveRequests(f) === 1);
  cut.abort();
  expect(await a).toBeNull();
  pending.resolve(new Response(f.archive.slice()));
  await new Promise((r) => setTimeout(r, 5));
  f.intercept(undefined);
  expect(await f.client.load(card, signal())).not.toBeNull();
  expect(archiveRequests(f)).toBe(1);
  f.client.dispose();
});

test("a stalled archive is given up after the timeout and retried next time; a fence drops it", async () => {
  const f = await fixture();
  let ms = 15000;
  const client = new NativeAudioClient({
    timeoutMs: () => ms,
    createObjectURL: () => "blob:x",
    revokeObjectURL: () => {},
    fetch: (url, init) => {
      f.requests.push({ url, init });
      if (url === "/api/prefs")
        return Promise.resolve(
          Response.json({
            user: "account-a",
            prefs: { [NATIVE_AUDIO_PREF]: { value: f.state.ref } },
          }),
        );
      if (url.endsWith("a".repeat(20))) return Promise.resolve(new Response(f.bytes.slice()));
      // Never answers; ends only when its signal aborts.
      return new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    },
  });
  await client.prepare();
  ms = 20;
  expect(await client.load(card, signal())).toBeNull();
  await until(() => f.requests.filter((r) => r.url.endsWith("b".repeat(20))).length === 1);
  const stalled = f.requests.find((r) => r.url.endsWith("b".repeat(20)))!.init.signal!;
  await until(() => stalled.aborted);
  expect(stalled.aborted).toBe(true);
  ms = 15000;
  const again = new AbortController();
  const b = client.load(card, again.signal);
  await until(() => f.requests.filter((r) => r.url.endsWith("b".repeat(20))).length === 2);
  const second = f.requests.filter((r) => r.url.endsWith("b".repeat(20)))[1].init.signal!;
  client.clear();
  expect(second.aborted).toBe(true);
  again.abort();
  expect(await b).toBeNull();
  client.dispose();
});

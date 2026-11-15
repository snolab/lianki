/**
 * `say --play file:<id>`: the short-lived URL that plays one of the user's own
 * audio files (lib/import/play-url.ts; docs/li-sound-hub.md, "Playing audio
 * from an agent"). Minted only by the owner's own session for their own audio
 * file; served while the signature and expiry hold, with byte ranges.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { insertItem } from "@/lib/inbox/store";
import type { InboxDb } from "@/lib/inbox/store";
import {
  PLAY_URL_MS,
  byteRange,
  isPlayable,
  mintPlayUrl,
  servePlay,
  signPlay,
  verifyPlay,
  type PlayUrlDeps,
} from "@/lib/import/play-url";

const SCHEMA = testSchema();
const SECRET = "s".repeat(40);
const T0 = Date.parse("2026-11-11T12:00:00Z");
const AUDIO = "0123456789abcdef0123";
const PDF = "abcdefabcdefabcdef01";
const BYTES = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));

let d1: TestD1Database;
let gets: { key: string; range?: { offset: number; length: number } }[];

beforeEach(async () => {
  d1 = createTestD1(SCHEMA);
  gets = [];
  const db = d1 as unknown as InboxDb;
  for (const [id, type] of [
    [AUDIO, "audio/mpeg"],
    [PDF, "application/pdf"],
  ] as const)
    await insertItem(db, {
      id,
      ownerId: "uOwner",
      name: `${id}.bin`,
      type,
      size: BYTES.length,
      sha256: "x",
      r2Key: `inbox/uOwner/2026/11/${id}`,
      createdMs: T0,
    });
});

function deps(
  o: Partial<Omit<PlayUrlDeps, "who">> & {
    who?: { id: string; email: string } | null;
    gate?: boolean;
  } = {},
): PlayUrlDeps {
  return {
    who: async () =>
      o.who === undefined
        ? { id: "uOwner", email: "o@x.com", owner: true }
        : o.who && { ...o.who, owner: false },
    db: () => d1 as unknown as InboxDb,
    bucket: () =>
      ({
        put: async () => {},
        delete: async () => {},
        get: async (key: string, opts?: { range?: { offset: number; length: number } }) => {
          gets.push({ key, ...(opts?.range ? { range: opts.range } : {}) });
          const r = opts?.range;
          const bytes = r ? BYTES.slice(r.offset, r.offset + r.length) : BYTES;
          return { body: new Response(bytes).body! };
        },
      }) as never,
    now: () => T0,
    on: async () => o.gate ?? true,
    secret: () => SECRET,
    ...(o.bucket ? { bucket: o.bucket } : {}),
    ...(o.now ? { now: o.now } : {}),
  };
}

const post = (id: string, site = "same-origin") =>
  new Request(`https://lianki.com/api/my/files/${id}/play`, {
    method: "POST",
    headers: { "sec-fetch-site": site, origin: "https://lianki.com" },
  });

describe("minting a play URL", () => {
  it("the owner's own audio file: a signed URL valid for an hour", async () => {
    const r = await mintPlayUrl(post(AUDIO), AUDIO, deps());
    expect(r.status).toBe(200);
    const j = (await r.json()) as { url: string; type: string; expiresAt: number };
    expect(j.type).toBe("audio/mpeg");
    expect(j.expiresAt).toBe(T0 + PLAY_URL_MS);
    expect(j.url).toMatch(new RegExp(`^/api/my/files/${AUDIO}/play\\?exp=\\d+&sig=[0-9a-f]{64}$`));
  });

  it("refused: cross-site, signed out, the gate off, not audio, not theirs, a bad id", async () => {
    expect((await mintPlayUrl(post(AUDIO, "cross-site"), AUDIO, deps())).status).toBe(403);
    expect((await mintPlayUrl(post(AUDIO), AUDIO, deps({ who: null }))).status).toBe(401);
    expect((await mintPlayUrl(post(AUDIO), AUDIO, deps({ gate: false }))).status).toBe(404);
    expect((await mintPlayUrl(post(PDF), PDF, deps())).status).toBe(404);
    expect(
      (await mintPlayUrl(post(AUDIO), AUDIO, deps({ who: { id: "uOther", email: "x@x.com" } })))
        .status,
    ).toBe(404);
    expect((await mintPlayUrl(post("nope"), "nope", deps())).status).toBe(404);
  });
});

describe("serving it", () => {
  const url = async () => {
    const j = (await (await mintPlayUrl(post(AUDIO), AUDIO, deps())).json()) as { url: string };
    return `https://lianki.com${j.url}`;
  };

  it("the whole file, inline, ranges offered; no session needed", async () => {
    const r = await servePlay(new Request(await url()), AUDIO, deps({ who: null }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/mpeg");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-length")).toBe("100");
    expect(r.headers.get("content-disposition")).toBe("inline");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(BYTES);
  });

  it("a byte range: 206 with its part (iOS asks for ranges while it plays)", async () => {
    const r = await servePlay(
      new Request(await url(), { headers: { range: "bytes=10-19" } }),
      AUDIO,
      deps(),
    );
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(r.headers.get("content-length")).toBe("10");
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    expect(gets.at(-1)?.range).toEqual({ offset: 10, length: 10 });
    const bad = await servePlay(
      new Request(await url(), { headers: { range: "bytes=500-" } }),
      AUDIO,
      deps(),
    );
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */100");
  });

  it("refused (404): expired, too far ahead, forged, another file's signature, not audio, gone", async () => {
    const good = new URL(await url());
    const at = (now: number) => servePlay(new Request(good), AUDIO, deps({ now: () => now }));
    expect((await at(T0 + PLAY_URL_MS + 1)).status).toBe(404);
    const far = new URL(good);
    far.searchParams.set("exp", String(T0 + PLAY_URL_MS * 5));
    expect((await servePlay(new Request(far), AUDIO, deps())).status).toBe(404);
    const forged = new URL(good);
    forged.searchParams.set("sig", "0".repeat(64));
    expect((await servePlay(new Request(forged), AUDIO, deps())).status).toBe(404);
    forged.searchParams.set("sig", "zz");
    expect((await servePlay(new Request(forged), AUDIO, deps())).status).toBe(404);
    expect((await servePlay(new Request(good), PDF, deps())).status).toBe(404);
    expect((await servePlay(new Request(good), "bad", deps())).status).toBe(404);
    const gone = deps({ bucket: () => ({ get: async () => null }) as never });
    expect((await servePlay(new Request(good), AUDIO, gone)).status).toBe(404);
  });

  it("the signature binds owner, file and expiry; the key needs a real secret", async () => {
    const sig = await signPlay(SECRET, "u1", AUDIO, 5);
    expect(await verifyPlay(SECRET, "u1", AUDIO, 5, sig)).toBe(true);
    expect(await verifyPlay(SECRET, "u2", AUDIO, 5, sig)).toBe(false);
    expect(await verifyPlay(SECRET, "u1", PDF, 5, sig)).toBe(false);
    expect(await verifyPlay(SECRET, "u1", AUDIO, 6, sig)).toBe(false);
    expect(await verifyPlay("t".repeat(40), "u1", AUDIO, 5, sig)).toBe(false);
    expect(signPlay("short", "u1", AUDIO, 5)).rejects.toThrow("AUTH_SECRET");
  });
});

describe("helpers", () => {
  it("byteRange", () => {
    expect(byteRange(null, 100)).toBeNull();
    expect(byteRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(byteRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    for (const bad of [
      "bytes=-0",
      "bytes=-",
      "items=0-1",
      "bytes=5-2",
      "bytes=100-",
      "bytes=1-2,4-5",
    ])
      expect(byteRange(bad, 100)).toBe("bad");
  });

  it("isPlayable: audio, and audio-bearing webm/mp4", () => {
    for (const t of ["audio/mpeg", "audio/ogg", "video/webm", "video/mp4"])
      expect(isPlayable(t)).toBe(true);
    for (const t of ["application/pdf", "image/png", "text/html", "video/quicktime"])
      expect(isPlayable(t)).toBe(false);
  });
});

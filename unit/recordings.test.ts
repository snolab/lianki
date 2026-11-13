/**
 * Mic recordings in the account (lib/recordings.ts, lib/recordings-sweep.ts,
 * lib/zip-stream.ts, lib/recordings-view.ts; docs/recordings.md): strict
 * validation, sealing bound to user, kind and clip id, own rows only, the
 * streamed day archive, and the retention sweep.
 */
import { describe, expect, it } from "bun:test";
import JSZip from "jszip";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { encodeWav } from "@lianki/debug-chat/mic";
import {
  MAX_CLIPS_PER_DAY,
  MAX_POST_BODY,
  RECORDING_LIMITS,
  type ClipRow,
  type RecBlobs,
  type RecDb,
  type RecDeps,
  aadOf,
  bad,
  clipAudio,
  clipName,
  d1RecDb,
  dayArchive,
  dayClips,
  deleteClip,
  deleteDay,
  getDay,
  isDay,
  listDays,
  objectKey,
  openAudio,
  openText,
  parseRecordingPost,
  postRecording,
  r2RecBlobs,
  recordingsKey,
  sealAudio,
  sealText,
  transcriptTxt,
} from "@/lib/recordings";
import { type SweepDb, retentionDays, sweepRecordings, SWEEP_PAGE } from "@/lib/recordings-sweep";
import { crc32, zipStream, ZIP_LIMITS } from "@/lib/zip-stream";
import { clock, recordingRows, withoutClip } from "@/lib/recordings-view";
import { toBase64 } from "@/lib/voice-clone-ref";
import { seal } from "@/lib/connections/crypto";
import { OWNER_SCOPES, parseScopes } from "@/lib/api-tokens";

const SECRET = "y".repeat(48);
const NOW = Date.parse("2026-11-14T03:00:00Z");
const DAY = "2026-11-14";

const audio = (sec = 1) => encodeWav(new Float32Array(Math.round(sec * 16_000)).fill(0.1));
const body = (o: Record<string, unknown> = {}) => ({
  id: "abcdefghijklmnop",
  at: NOW - 1_000,
  day: DAY,
  text: "你好 world",
  source: "local",
  mode: "active",
  device: "iphone",
  speaker: "me",
  wav: toBase64(audio()),
  ...o,
});

function memBlobs() {
  const objects = new Map<string, Uint8Array>();
  const blobs: RecBlobs = {
    put: async (k, b) => void objects.set(k, b),
    get: async (k) => objects.get(k) ?? null,
    delete: async (k) => void objects.delete(k),
  };
  return { objects, blobs };
}

function setup(uid = "u1") {
  const d1 = createTestD1(testSchema());
  const db = d1RecDb(d1 as never);
  const { objects, blobs } = memBlobs();
  const deps = (u = uid): RecDeps => ({
    uid: u,
    db,
    blobs,
    key: () => recordingsKey(SECRET),
    now: NOW,
  });
  return { d1, db, objects, blobs, deps };
}

describe("parseRecordingPost: exactly the shape, nothing else", () => {
  it("takes a good body", () => {
    const p = parseRecordingPost(body(), NOW);
    expect(typeof p).toBe("object");
    if (typeof p === "string") throw new Error(p);
    expect(p).toMatchObject({ id: "abcdefghijklmnop", day: DAY, mode: "active", speaker: "me" });
    expect(p.info).toMatchObject({ sampleRate: 16_000, durationMs: 1_000 });
    // speaker is optional
    const q = parseRecordingPost(body({ speaker: undefined }), NOW);
    expect(typeof q !== "string" && q.speaker).toBeNull();
    const n = parseRecordingPost(body({ speaker: null, text: "" }), NOW);
    expect(typeof n !== "string" && n.text).toBe("");
  });

  it.each([
    [null, "bad body"],
    [[1], "bad body"],
    [{ ...body(), extra: 1 }, "bad body"],
    [body({ id: "short" }), "bad id"],
    [body({ id: "../../../etc/passwd!" }), "bad id"],
    [body({ at: "1" }), "bad at"],
    [body({ at: 1.5 }), "bad at"],
    [body({ at: NOW + 10 * 60_000 }), "bad at"],
    [body({ at: NOW - 3 * 86_400_000 }), "bad at"],
    [body({ day: "2026-02-30" }), "bad day"],
    [body({ day: "2026-11-1" }), "bad day"],
    [body({ day: "2026-11-10" }), "bad day"],
    [body({ text: 1 }), "bad text"],
    [body({ text: "x".repeat(RECORDING_LIMITS.maxTextChars + 1) }), "text too long"],
    [body({ text: "a\u0000b" }), "bad text"],
    [body({ source: "server" }), "bad source"],
    [body({ mode: "x" }), "bad mode"],
    [body({ device: 3 }), "bad device"],
    [body({ device: "a b" }), "bad device"],
    [body({ device: "x".repeat(41) }), "bad device"],
    [body({ speaker: "boss" }), "bad speaker"],
    [body({ wav: "" }), "no wav"],
    [body({ wav: "A".repeat(2_000_000) }), "too large"],
    [body({ wav: "!!!!" }), "bad wav encoding"],
    [body({ wav: toBase64(encodeWav(new Float32Array(16_000), 24_000)) }), "bad sample rate"],
    [body({ wav: toBase64(audio(0.05)) }), "too short"],
    [body({ wav: toBase64(audio(41)) }), "too large"],
  ])("refuses %#", (b, why) => {
    expect(parseRecordingPost(b, NOW)).toBe(why);
  });

  it("a day is a real calendar day", () => {
    expect(isDay("2026-11-14")).toBe(true);
    expect(isDay("2026-13-01")).toBe(false);
    expect(isDay(20261114)).toBe(false);
  });

  it("the body cap covers the largest clip", () => {
    expect(MAX_POST_BODY).toBeGreaterThan(Math.ceil(RECORDING_LIMITS.maxBytes / 3) * 4);
  });
});

describe("sealing: AAD bound to user, kind and id", () => {
  it("opens only with the same user, kind and id", async () => {
    const k = await recordingsKey(SECRET);
    const w = audio(0.5);
    const s = await sealAudio(k, "u1", "id1", w);
    expect(await openAudio(k, "u1", "id1", s)).toEqual(w);
    expect(await openAudio(k, "u2", "id1", s)).toBeNull();
    expect(await openAudio(k, "u1", "id2", s)).toBeNull();
    expect(await openAudio(k, "u1", "id1", s.slice(0, 20))).toBeNull();
    const bent = s.slice();
    bent[0] = 0;
    expect(await openAudio(k, "u1", "id1", bent)).toBeNull();
    const t = await sealText(k, "u1", "id1", "secret words");
    expect(await openText(k, "u1", "id1", t)).toBe("secret words");
    expect(await openText(k, "u2", "id1", t)).toBeNull();
    expect(await openText(k, "u1", "id2", t)).toBeNull();
    expect(aadOf("u", "audio", "i")).not.toBe(aadOf("u", "text", "i"));
    // An empty transcript seals and opens; the longest CJK one fits the cap.
    expect(await openText(k, "u1", "id1", await sealText(k, "u1", "id1", ""))).toBe("");
    const long = "語".repeat(RECORDING_LIMITS.maxTextChars);
    expect(await openText(k, "u1", "id1", await sealText(k, "u1", "id1", long))).toBe(long);
    // Not a sealed JSON string: null.
    expect(
      await openText(k, "u1", "id1", await seal(k, "raw", aadOf("u1", "text", "id1"))),
    ).toBeNull();
    expect(
      await openText(k, "u1", "id1", await seal(k, "42", aadOf("u1", "text", "id1"))),
    ).toBeNull();
  });

  it("another secret opens nothing; a short secret is refused", async () => {
    const s = await sealAudio(await recordingsKey(SECRET), "u1", "i", audio(0.5));
    expect(await openAudio(await recordingsKey("z".repeat(48)), "u1", "i", s)).toBeNull();
    expect(() => recordingsKey("short")).toThrow();
    expect(() => recordingsKey(undefined)).toThrow();
    expect(recordingsKey(SECRET)).toBe(recordingsKey(SECRET)); // cached
  });
});

describe("the store: own rows only", () => {
  it("stores, lists, reads back and is idempotent per id", async () => {
    const s = setup();
    const r = await postRecording(s.deps(), body());
    expect(r).toEqual({ status: 200, json: { ok: true, id: "abcdefghijklmnop" } });
    // The audio is sealed in R2, not the WAV.
    const obj = s.objects.get(objectKey("u1", DAY, "abcdefghijklmnop"))!;
    expect(new TextDecoder().decode(obj.slice(0, 4))).toBe("LKR1");
    expect(await postRecording(s.deps(), body())).toMatchObject({ json: { dup: true } });
    await postRecording(
      s.deps(),
      body({ id: "bbbbbbbbbbbbbbbb", at: NOW - 500, speaker: undefined }),
    );
    await postRecording(
      s.deps(),
      body({ id: "cccccccccccccccc", day: "2026-11-13", at: NOW - 86_400_000 }),
    );
    const days = await listDays(s.deps(), new URLSearchParams());
    expect(days.json).toEqual({
      days: [
        { day: DAY, clips: 2, ms: 2_000, bytes: audio().length * 2 },
        { day: "2026-11-13", clips: 1, ms: 1_000, bytes: audio().length },
      ],
      more: false,
    });
    const page = await listDays(s.deps(), new URLSearchParams("limit=1"));
    expect(page.json).toMatchObject({ more: true, days: [{ day: DAY }] });
    const rest = await listDays(s.deps(), new URLSearchParams(`before=${DAY}&limit=500`));
    expect(rest.json).toMatchObject({ days: [{ day: "2026-11-13" }] });
    expect((await listDays(s.deps(), new URLSearchParams("before=x"))).status).toBe(400);
    expect((await listDays(s.deps(), new URLSearchParams("limit=0"))).status).toBe(400);
    const day = await getDay(s.deps(), DAY);
    expect(day.json.clips).toEqual([
      expect.objectContaining({ id: "abcdefghijklmnop", text: "你好 world", speaker: "me" }),
      expect.objectContaining({ id: "bbbbbbbbbbbbbbbb", speaker: null }),
    ]);
    expect((await getDay(s.deps(), "nope")).status).toBe(400);
    const a = await clipAudio(s.deps(), "abcdefghijklmnop");
    expect("wav" in a && a.wav).toEqual(audio());
  });

  it("another account sees, plays and deletes nothing of it", async () => {
    const s = setup();
    await postRecording(s.deps(), body());
    expect((await listDays(s.deps("u2"), new URLSearchParams())).json.days).toEqual([]);
    expect((await getDay(s.deps("u2"), DAY)).json.clips).toEqual([]);
    expect(await clipAudio(s.deps("u2"), "abcdefghijklmnop")).toMatchObject({ status: 404 });
    expect((await deleteClip(s.deps("u2"), "abcdefghijklmnop")).json.deleted).toBe(0);
    expect((await deleteDay(s.deps("u2"), DAY)).json.deleted).toBe(0);
    expect(await dayArchive(s.deps("u2"), DAY)).toMatchObject({ status: 404 });
    expect((await getDay(s.deps(), DAY)).json.clips).toHaveLength(1);
    // The same id from another account is its own clip, not a duplicate.
    expect((await postRecording(s.deps("u2"), body())).json.dup).toBeUndefined();
  });

  it("a sealed half moved to another account or id does not open", async () => {
    const s = setup();
    await postRecording(s.deps(), body());
    const obj = s.objects.get(objectKey("u1", DAY, "abcdefghijklmnop"))!;
    await postRecording(s.deps("u2"), body());
    s.objects.set(objectKey("u2", DAY, "abcdefghijklmnop"), obj);
    expect(await clipAudio(s.deps("u2"), "abcdefghijklmnop")).toMatchObject({ status: 410 });
    s.objects.delete(objectKey("u1", DAY, "abcdefghijklmnop"));
    expect(await clipAudio(s.deps(), "abcdefghijklmnop")).toMatchObject({ status: 410 });
    expect(await clipAudio(s.deps(), "bad id!")).toMatchObject({ status: 400 });
  });

  it("refuses bad bodies, too-large ones and a full day", async () => {
    const s = setup();
    expect(await postRecording(s.deps(), body({ id: "x" }))).toEqual(bad(400, "bad id"));
    expect(await postRecording(s.deps(), body({ wav: "A".repeat(2_000_000) }))).toEqual(
      bad(413, "too-large"),
    );
    const full: RecDeps = {
      ...s.deps(),
      db: { ...s.db, countDay: async () => MAX_CLIPS_PER_DAY },
    };
    expect(await postRecording(full, body())).toEqual(bad(429, "day full"));
  });

  it("a failed row write leaves no orphan object", async () => {
    const s = setup();
    const broken: RecDeps = {
      ...s.deps(),
      db: {
        ...s.db,
        insert: async () => {
          throw new Error("d1 down");
        },
      },
    };
    await expect(postRecording(broken, body())).rejects.toThrow("d1 down");
    expect(s.objects.size).toBe(0);
  });

  it("a race on the same id answers dup", async () => {
    const s = setup();
    const raced: RecDeps = { ...s.deps(), db: { ...s.db, insert: async () => false } };
    expect((await postRecording(raced, body())).json).toMatchObject({ ok: true, dup: true });
  });

  it("deletes a clip and a whole day, objects too", async () => {
    const s = setup();
    await postRecording(s.deps(), body());
    await postRecording(s.deps(), body({ id: "bbbbbbbbbbbbbbbb" }));
    await postRecording(s.deps(), body({ id: "cccccccccccccccc" }));
    expect((await deleteClip(s.deps(), "abcdefghijklmnop")).json.deleted).toBe(1);
    expect(s.objects.size).toBe(2);
    expect(await deleteClip(s.deps(), "../x")).toMatchObject({ status: 400 });
    expect((await deleteDay(s.deps(), DAY)).json.deleted).toBe(2);
    expect(s.objects.size).toBe(0);
    expect(await deleteDay(s.deps(), "x")).toMatchObject({ status: 400 });
  });

  it("an unreadable transcript reads as null", async () => {
    const s = setup();
    await postRecording(s.deps(), body());
    const other: RecDeps = { ...s.deps(), key: () => recordingsKey("q".repeat(48)) };
    expect((await dayClips(other, DAY))[0]!.text).toBeNull();
  });
});

async function unzip(stream: ReadableStream<Uint8Array>) {
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  return JSZip.loadAsync(buf);
}

describe("retryable deletion", () => {
  for (const wholeDay of [false, true])
    it(`keeps rows after an R2 failure and retries (${wholeDay ? "day" : "clip"})`, async () => {
      const s = setup();
      await postRecording(s.deps(), body());
      const remove = () =>
        wholeDay ? deleteDay(s.deps(), DAY) : deleteClip(s.deps(), "abcdefghijklmnop");
      const original = s.blobs.delete;
      s.blobs.delete = async () => {
        throw new Error("R2 unavailable");
      };
      await expect(remove()).rejects.toThrow("R2 unavailable");
      expect(await s.db.get("u1", "abcdefghijklmnop")).not.toBeNull();
      expect(s.objects.size).toBe(1);
      s.blobs.delete = original;
      expect((await remove()).json.deleted).toBe(1);
      expect(s.objects.size).toBe(0);
      expect(await s.db.get("u1", "abcdefghijklmnop")).toBeNull();
    });
  it("preserves uploads arriving after the day's snapshot", async () => {
    const s = setup();
    await postRecording(s.deps(), body());
    const original = s.blobs.delete;
    s.blobs.delete = async (key) => {
      await postRecording(s.deps(), body({ id: "abcdefghijklmnop2" }));
      await original(key);
    };
    expect((await deleteDay(s.deps(), DAY)).json.deleted).toBe(1);
    expect(await s.db.get("u1", "abcdefghijklmnop2")).not.toBeNull();
    expect(s.objects.size).toBe(1);
  });
});

describe("the day archive", () => {
  it("streams transcripts first, then each clip's WAV", async () => {
    const s = setup();
    await postRecording(s.deps(), body({ at: Date.parse("2026-11-14T01:02:03Z") }));
    await postRecording(
      s.deps(),
      body({
        id: "bbbbbbbbbbbbbbbb",
        at: Date.parse("2026-11-14T01:05:00Z"),
        text: "",
        speaker: "other",
      }),
    );
    await postRecording(
      s.deps(),
      body({ id: "cccccccccccccccc", at: Date.parse("2026-11-14T01:06:00Z") }),
    );
    s.objects.delete(objectKey("u1", DAY, "cccccccccccccccc")); // a lost object is left out
    const r = await dayArchive(s.deps(), DAY, -540);
    if (!(r instanceof ReadableStream)) throw new Error(JSON.stringify(r));
    const z = await unzip(r);
    expect(Object.keys(z.files)).toEqual([
      "transcript.txt",
      "transcript.json",
      "100203-abcdefghijklmnop.wav",
      "100500-bbbbbbbbbbbbbbbb.wav",
    ]);
    expect(await z.file("transcript.txt")!.async("string")).toBe(
      "10:02:03 [me] 你好 world\n10:05:00 [other]\n10:06:00 [me] 你好 world\n",
    );
    const j = JSON.parse(await z.file("transcript.json")!.async("string"));
    expect(j.clips[0]).toMatchObject({ file: "100203-abcdefghijklmnop.wav", text: "你好 world" });
    expect(await z.file("100203-abcdefghijklmnop.wav")!.async("uint8array")).toEqual(audio());
  });

  it("refuses a bad day, a bad zone, an empty day and an oversized one", async () => {
    const s = setup();
    expect(await dayArchive(s.deps(), "x")).toMatchObject({ status: 400 });
    expect(await dayArchive(s.deps(), DAY, 2000)).toMatchObject({ status: 400 });
    expect(await dayArchive(s.deps(), DAY)).toMatchObject({ status: 404 });
    await postRecording(s.deps(), body());
    const huge: RecDeps = {
      ...s.deps(),
      db: {
        ...s.db,
        day: async (u, d) =>
          (await s.db.day(u, d)).map((r: ClipRow) => ({ ...r, bytes: ZIP_LIMITS.bytes })),
      },
    };
    expect(await dayArchive(huge, DAY)).toMatchObject({ status: 413 });
  });

  it("names and text lines", () => {
    expect(clipName({ at: Date.parse("2026-11-14T23:59:59Z"), id: "i" })).toBe("235959-i.wav");
    expect(transcriptTxt([{ at: 0, speaker: null, text: null } as never])).toBe(
      "00:00:00 (unreadable)\n",
    );
  });
});

describe("zipStream", () => {
  it("writes a valid stored zip from a sync iterable; crc32 is IEEE", async () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const z = await unzip(
      zipStream([
        { name: "a.txt", data: new TextEncoder().encode("hello") },
        { name: "日本.txt", data: new Uint8Array(0), at: new Date("1970-01-01T00:00:00Z") },
      ]),
    );
    expect(await z.file("a.txt")!.async("string")).toBe("hello");
    expect(await z.file("日本.txt")!.async("string")).toBe("");
  });

  it("errors past the limits, and a cancel stops the source", async () => {
    let stopped = false;
    function* big() {
      try {
        yield { name: "x", data: new Uint8Array(1) };
        yield { name: "y", data: { length: ZIP_LIMITS.bytes } as Uint8Array };
      } finally {
        stopped = true;
      }
    }
    await expect(new Response(zipStream(big())).arrayBuffer()).rejects.toThrow("too large");
    const s = zipStream(big());
    const rd = s.getReader();
    await rd.read();
    await rd.cancel();
    expect(stopped).toBe(true);
  });
});

describe("retention", () => {
  it("sweeps clips older than the retention, objects first, any account", async () => {
    const s = setup();
    await postRecording(
      s.deps(),
      body({ id: "old1old1old1old1", at: NOW - 86_400_000, day: "2026-11-13" }),
    );
    await postRecording(
      s.deps("u2"),
      body({ id: "old2old2old2old2", at: NOW - 86_400_000, day: "2026-11-13" }),
    );
    await postRecording(s.deps(), body({ id: "newnewnewnewnewn" }));
    const later = NOW + 90 * 86_400_000 - 1_000;
    expect(await sweepRecordings(s.d1 as never, s.blobs, 90, later)).toBe(2);
    expect(s.objects.size).toBe(1);
    expect((await getDay(s.deps(), DAY)).json.clips).toHaveLength(1);
    expect(await sweepRecordings(s.d1 as never, null, 0, later)).toBe(0);
    expect(await sweepRecordings(s.d1 as never, undefined, 1, later + 2 * 86_400_000)).toBe(1);
  });

  it("pages through more than one pass", async () => {
    const rows = Array.from({ length: SWEEP_PAGE + 3 }, (_, i) => ({
      uid: "u",
      id: `i${i}`,
      day: DAY,
    }));
    const deleted: string[] = [];
    const db: SweepDb = {
      prepare: (sql: string) => ({
        bind: (...v: unknown[]) => ({
          first: async () => null,
          all: async <T>() => ({ results: rows.splice(0, v[1] as number) as T[] }),
          run: async () => void (sql.startsWith("DELETE") && deleted.push(v[1] as string)),
        }),
      }),
    };
    expect(await sweepRecordings(db, null, 1, NOW)).toBe(SWEEP_PAGE + 3);
    expect(deleted).toHaveLength(SWEEP_PAGE + 3);
  });

  it("reads the retention from config, else the default 90", async () => {
    const s = setup();
    expect(await retentionDays(s.d1 as never)).toBe(90);
    s.d1
      .raw()
      .exec(
        `INSERT INTO config_values (key, value_json, updated_at, updated_by) VALUES ('recordings.retentionDays', '30', 0, 'x')`,
      );
    expect(await retentionDays(s.d1 as never)).toBe(30);
    const broken = {
      prepare: () => {
        throw new Error("no d1");
      },
    };
    expect(await retentionDays(broken as never)).toBe(90);
  });
});

describe("the recordings:read token permission", () => {
  it("is a dev account's alone, never offered to anyone else", () => {
    expect(OWNER_SCOPES).toContain("recordings:read");
    expect(parseScopes(["recordings:read"])).toBeNull();
    expect(parseScopes(["recordings:read"], { owner: true })).toEqual(["recordings:read"]);
  });
});

describe("D1 and R2 adapters", () => {
  it("r2RecBlobs passes through", async () => {
    const m = new Map<string, Uint8Array>();
    const b = r2RecBlobs({
      put: async (k, v) => void m.set(k, v),
      get: async (k) => (m.has(k) ? { arrayBuffer: async () => m.get(k)!.slice().buffer } : null),
      delete: async (k) => void m.delete(k),
    });
    await b.put("k", new Uint8Array([1, 2]));
    expect(await b.get("k")).toEqual(new Uint8Array([1, 2]));
    await b.delete("k");
    expect(await b.get("k")).toBeNull();
  });

  it("deleteClip on D1 answers whether a row went", async () => {
    const s = setup();
    await postRecording(s.deps(), body());
    expect(await (s.db as RecDb).deleteClip("u1", "abcdefghijklmnop")).toBe(true);
    expect(await (s.db as RecDb).deleteClip("u1", "abcdefghijklmnop")).toBe(false);
  });
});

describe("the page's rows", () => {
  const days = [
    { day: "2026-11-14", clips: 2, ms: 3_000, bytes: 10 },
    { day: "2026-11-13", clips: 1, ms: 1_000, bytes: 5 },
  ];
  const c = (id: string, day: string, durationMs = 1_000) => ({
    id,
    day,
    at: 0,
    durationMs,
    mode: "active" as const,
    source: "local" as const,
    speaker: null,
    text: "t",
  });
  it("open days list their clips, or a loading row until they come", () => {
    const clips = new Map([["2026-11-14", [c("a", "2026-11-14"), c("b", "2026-11-14")]]]);
    expect(recordingRows(days, new Set(), clips).map((r) => r.key)).toEqual([
      "d:2026-11-14",
      "d:2026-11-13",
    ]);
    expect(
      recordingRows(days, new Set(["2026-11-14", "2026-11-13"]), clips).map((r) => r.key),
    ).toEqual(["d:2026-11-14", "c:a", "c:b", "d:2026-11-13", "l:2026-11-13"]);
  });
  it("deleting a clip updates its day; the last one removes the day", () => {
    const clips = new Map([
      ["2026-11-14", [c("a", "2026-11-14", 2_000), c("b", "2026-11-14")]],
      ["2026-11-13", [c("z", "2026-11-13")]],
    ]);
    const n = withoutClip(days, clips, c("a", "2026-11-14", 2_000));
    expect(n.days[0]).toEqual({ day: "2026-11-14", clips: 1, ms: 1_000, bytes: 10 });
    expect(n.clips.get("2026-11-14")!.map((x) => x.id)).toEqual(["b"]);
    const m = withoutClip(n.days, n.clips, c("z", "2026-11-13"));
    expect(m.days.map((d) => d.day)).toEqual(["2026-11-14"]);
    expect(m.clips.has("2026-11-13")).toBe(false);
  });
  it("clock", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(61_000)).toBe("1:01");
    expect(clock(3_723_000)).toBe("1:02:03");
  });
});

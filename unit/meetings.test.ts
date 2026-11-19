/**
 * Meetings in the account (lib/meetings/*; docs/meetings.md): strict
 * validation, sealing bound to user, meeting, track and seq, own rows only,
 * idempotent pieces, quota, the line protocol (live vs final, replace), the
 * delete + purge and the daily sweep.
 */
import { describe, expect, it } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  DEFAULT_MIME_PREFS,
  MAX_CHUNK_BYTES,
  chunkKey,
  clockOf,
  defaultTitle,
  extOf,
  firstFragment,
  firstGap,
  isAudioTrack,
  isMeetingsPath,
  isMimeOk,
  isTrack,
  meetingPrefix,
  newMeetingId,
  parseChunkHeaders,
  parseMimePrefs,
  parseSeq,
  pickMime,
  recordSupport,
  seekPlan,
  seqName,
  sha256Hex,
  sizeOf,
  type ChunkMeta,
} from "@/lib/meetings/core";
import {
  chunkAad,
  lineAad,
  meetingsKey,
  openChunk,
  openText,
  sealChunk,
  sealText,
  titleAad,
} from "@/lib/meetings/seal";
import {
  type MeetBlobs,
  type MeetDeps,
  bad,
  chunkBytes,
  chunkIndex,
  createMeeting,
  deleteMeeting,
  downloadAv,
  endMeeting,
  getLines,
  getMeeting,
  linesTxt,
  linesVtt,
  listMeetings,
  parseLines,
  patchMeeting,
  putChunk,
  putLines,
  r2MeetBlobs,
  transcriptFile,
  usedBytes,
} from "@/lib/meetings/store";
import { purgeMeeting, sweepMeetings, type SweepDb } from "@/lib/meetings/sweep";
import { CONFIG, defaultConfig } from "@/lib/config";
import { FLAGS } from "@/lib/flags";

const SECRET = "m".repeat(48);
/** The status of a store answer that may also be a body. */
const st = (r: object) => ("status" in r ? r.status : 200);
const NOW = Date.parse("2026-11-19T07:00:00Z");
const enc = new TextEncoder();

function memBlobs(): MeetBlobs & { map: Map<string, Uint8Array>; deletes: number } {
  const map = new Map<string, Uint8Array>();
  const b = {
    map,
    deletes: 0,
    async put(k: string, v: Uint8Array) {
      map.set(k, v);
    },
    async get(k: string) {
      return map.get(k) ?? null;
    },
    async delete(keys: string | string[]) {
      b.deletes++;
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
    async list(o: { prefix: string; cursor?: string; limit?: number }) {
      // As R2: the cursor names a position, stable while objects are deleted.
      const all = [...map.keys()]
        .filter((k) => k.startsWith(o.prefix) && (!o.cursor || k > o.cursor))
        .sort();
      const lim = o.limit ?? 1000;
      const page = all.slice(0, lim);
      const truncated = lim < all.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        cursor: truncated ? page.at(-1) : undefined,
      };
    },
  };
  return b;
}

function setup(uid = "u1", over: Partial<MeetDeps> = {}) {
  const db = createTestD1(testSchema());
  const blobs = memBlobs();
  const d: MeetDeps = {
    uid,
    db: db as never,
    blobs,
    key: () => meetingsKey(SECRET),
    limits: { quotaBytes: 10_000_000, maxMs: 180 * 60_000, chunkMs: 30_000 },
    now: NOW,
    ...over,
  };
  return { db, blobs, d };
}
const body = (o: Record<string, unknown> = {}) => ({
  tap: true,
  title: "Meeting, 19 Nov 2026",
  mimeAv: "video/webm;codecs=vp9,opus",
  mimeAudio: "audio/webm;codecs=opus",
  width: 1920,
  height: 1080,
  hasMic: true,
  hasRoomAudio: true,
  device: "mac",
  ...o,
});
async function newMeeting(d: MeetDeps, o: Record<string, unknown> = {}) {
  const r = await createMeeting(d, body(o));
  expect(r.status).toBe(200);
  return r.json.id as string;
}
async function hdr(bytes: Uint8Array, o: Partial<Record<string, string>> = {}) {
  const h = new Headers({
    "x-lk-sha256": await sha256Hex(bytes),
    "x-lk-start-ms": "0",
    "x-lk-dur-ms": "30000",
    ...o,
  });
  const p = parseChunkHeaders(h);
  if (typeof p === "string") throw new Error(p);
  return p;
}

describe("core", () => {
  it("tracks, ids, keys", () => {
    expect(isTrack("av") && isTrack("me") && isTrack("others")).toBe(true);
    expect(isTrack("room")).toBe(false);
    expect(isAudioTrack("av")).toBe(false);
    expect(isAudioTrack("others")).toBe(true);
    const id = newMeetingId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newMeetingId()).not.toBe(id);
    expect(seqName(7)).toBe("000007");
    expect(chunkKey("u", "m", "others", 12)).toBe("meetings/u/m/others/000012");
    expect(meetingPrefix("u", "m")).toBe("meetings/u/m/");
    expect(parseSeq("0")).toBe(0);
    expect(parseSeq("3600")).toBe(3600);
    expect(parseSeq("3601")).toBeNull();
    expect(parseSeq("-1")).toBeNull();
    expect(parseSeq("1.5")).toBeNull();
  });

  it("parses piece headers strictly", async () => {
    const h = await hdr(enc.encode("x"), { "x-lk-frag-off": "12", "x-lk-frag-ms": "30000" });
    expect(h).toMatchObject({ startMs: 0, durMs: 30000, fragOff: 12, fragMs: 30000 });
    const base = { "x-lk-sha256": "a".repeat(64), "x-lk-start-ms": "0", "x-lk-dur-ms": "1" };
    expect(parseChunkHeaders(new Headers({ ...base, "x-lk-sha256": "z" }))).toBe("bad sha256");
    expect(parseChunkHeaders(new Headers({ ...base, "x-lk-start-ms": "-1" }))).toBe("bad start");
    expect(parseChunkHeaders(new Headers({ ...base, "x-lk-dur-ms": "999999999" }))).toBe("bad dur");
    expect(parseChunkHeaders(new Headers({ ...base, "x-lk-frag-off": "x" }))).toBe("bad frag");
    expect(parseChunkHeaders(new Headers({ ...base, "x-lk-frag-ms": "x" }))).toBe("bad frag");
    expect(parseChunkHeaders(new Headers({ ...base, "x-lk-frag-off": "" }))).toMatchObject({
      fragOff: null,
    });
  });

  it("format preferences", () => {
    const p = parseMimePrefs(DEFAULT_MIME_PREFS)!;
    expect(p.av[0]).toBe("video/mp4;codecs=avc1,mp4a.40.2");
    expect(p.audio).toEqual(["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2"]);
    expect(parseMimePrefs("av: video/webm")).toBeNull();
    expect(parseMimePrefs("av: video/webm || x: audio/webm")).toBeNull();
    expect(parseMimePrefs("av: <script> || audio: audio/webm")).toBeNull();
    expect(parseMimePrefs(1 as never)).toBeNull();
    expect(CONFIG["meetings.mimeTypes"].schema.safeParse("nope").success).toBe(false);
    expect(CONFIG["meetings.mimeTypes"].schema.safeParse(DEFAULT_MIME_PREFS).success).toBe(true);
    expect(pickMime(p.av, (t) => t.startsWith("video/webm"))).toBe("video/webm;codecs=vp9,opus");
    expect(
      pickMime(p.av, () => {
        throw new Error("x");
      }),
    ).toBeNull();
    expect(isMimeOk("audio/webm;codecs=opus")).toBe(true);
    expect(isMimeOk("text/html")).toBe(false);
    expect(extOf("video/mp4;codecs=avc1")).toBe("mp4");
    expect(extOf("video/webm")).toBe("webm");
  });

  it("support: desktop Chrome/Edge only, tab sound only off Windows/ChromeOS", () => {
    const mac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36";
    const env = { hasDisplayMedia: true, hasRecorder: true };
    expect(recordSupport({ ua: mac, ...env })).toEqual({ ok: true, tabSoundOnly: true });
    expect(
      recordSupport({
        ua: mac.replace("Macintosh; Intel Mac OS X 10_15_7", "Windows NT 10.0"),
        ...env,
      }),
    ).toEqual({
      ok: true,
      tabSoundOnly: false,
    });
    expect(recordSupport({ ua: "Mozilla/5.0 (iPhone) Mobile Safari", ...env })).toEqual({
      ok: false,
      reason: "mobile",
    });
    expect(recordSupport({ ua: mac, ...env, mobile: true }).ok).toBe(false);
    expect(recordSupport({ ua: "Mozilla/5.0 (Macintosh) Firefox/140.0", ...env })).toEqual({
      ok: false,
      reason: "browser",
    });
    expect(recordSupport({ ua: mac, hasDisplayMedia: false, hasRecorder: true })).toEqual({
      ok: false,
      reason: "api",
    });
  });

  it("finds the first fragment in WebM and MP4", () => {
    // EBML header junk, then a Cluster (1F43B675), size vint 0x01FFFFFFFFFFFFFF (8 bytes), Timecode E7.
    const webm = new Uint8Array([
      1, 2, 3, 0x1f, 0x43, 0xb6, 0x75, 0x81, 0x00, 0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff, 0xe7, 0x81, 0,
    ]);
    expect(firstFragment(webm, "video/webm")).toBe(9);
    expect(firstFragment(webm, "video/webm", 10)).toBe(-1);
    const zeroSize = new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0x00, 0xe7, 0, 0]);
    expect(firstFragment(zeroSize, "video/webm")).toBe(-1);
    const mp4 = new Uint8Array([
      0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 16, 0x6d, 0x6f, 0x6f, 0x66, 0, 0, 0, 0,
    ]);
    expect(firstFragment(mp4, "video/mp4")).toBe(8);
    expect(firstFragment(new Uint8Array([0x6d, 0x6f, 0x6f, 0x66, 0, 0]), "video/mp4")).toBe(-1);
  });

  it("plans a seek from fragment offsets", () => {
    const c = (seq: number, fragMs: number | null, fragOff: number | null = 5): ChunkMeta => ({
      track: "av",
      seq,
      startMs: seq * 30_000,
      durMs: 30_000,
      bytes: 100,
      fragOff,
      fragMs,
    });
    const list = [c(0, 0, 200), c(1, 31_000), c(2, null, null), c(3, 92_000)];
    expect(seekPlan(list, 0)).toEqual({ seq: 0, offset: 200, atMs: 0 });
    expect(seekPlan(list, 60_000)).toEqual({ seq: 1, offset: 5, atMs: 31_000 });
    expect(seekPlan(list, 100_000)).toEqual({ seq: 3, offset: 5, atMs: 92_000 });
    expect(seekPlan([c(0, 5_000)], 0)).toEqual({ seq: 0, offset: 0, atMs: 0 });
    expect(seekPlan([c(1, 0)], 0)).toBeNull();
    expect(seekPlan([], 0)).toBeNull();
    expect(firstGap(list)).toBe(-1);
    expect(firstGap([c(0, 0), c(2, 0)])).toBe(1);
  });

  it("titles, clocks, sizes, private paths", () => {
    expect(defaultTitle(NOW, "Meeting", "en-GB", "UTC")).toMatch(
      /^Meeting, 19 Nov 2026,? (at )?07:00$/,
    );
    expect(defaultTitle(NOW, "Meeting", "xx-invalid-@@", "Nowhere/Zone")).toBe(
      "Meeting, 2026-11-19 07:00",
    );
    expect(clockOf(65_000)).toBe("1:05");
    expect(clockOf(3_723_000)).toBe("1:02:03");
    expect(clockOf(-5)).toBe("0:00");
    expect(sizeOf(999)).toBe("999 B");
    expect(sizeOf(4_500_000)).toBe("4.5 MB");
    expect(sizeOf(250_000_000)).toBe("250 MB");
    expect(sizeOf(5e15)).toBe("5000 TB");
    expect(isMeetingsPath("/my/meetings")).toBe(true);
    expect(isMeetingsPath("/my/meetings/abc")).toBe(true);
    expect(isMeetingsPath("/ja/my/meetings/new")).toBe(true);
    expect(isMeetingsPath("/my/meetingsx")).toBe(false);
    expect(isMeetingsPath("/my/recordings")).toBe(false);
  });

  it("registry: flag default off for the owner, config keys in range", () => {
    expect(FLAGS["meetings.record"]).toMatchObject({ default: false, audience: "owner" });
    const c = defaultConfig();
    expect(c["meetings.chunkSec"]).toBe(30);
    expect(c["meetings.quotaGB"]).toBe(50);
    expect(c["meetings.retentionDays"]).toBe(0);
    expect(c["meetings.staleMin"]).toBe(30);
  });
});

describe("sealing", () => {
  it("a piece opens only as its own user, meeting, track and seq", async () => {
    const key = await meetingsKey(SECRET);
    expect(await meetingsKey(SECRET)).toBe(key);
    const plain = enc.encode("piece bytes");
    const s = await sealChunk(key, "u1", "m1", "av", 3, plain);
    expect(new TextDecoder().decode(s.slice(0, 4))).toBe("LKM1");
    expect(await openChunk(key, "u1", "m1", "av", 3, s)).toEqual(plain);
    expect(await openChunk(key, "u2", "m1", "av", 3, s)).toBeNull();
    expect(await openChunk(key, "u1", "m2", "av", 3, s)).toBeNull();
    expect(await openChunk(key, "u1", "m1", "me", 3, s)).toBeNull();
    expect(await openChunk(key, "u1", "m1", "av", 4, s)).toBeNull();
    expect(await openChunk(key, "u1", "m1", "av", 3, s.slice(0, 20))).toBeNull();
    const bad = s.slice();
    bad[0] = 0;
    expect(await openChunk(key, "u1", "m1", "av", 3, bad)).toBeNull();
    const other = await meetingsKey("n".repeat(48));
    expect(await openChunk(other, "u1", "m1", "av", 3, s)).toBeNull();
    expect(() => meetingsKey("short")).toThrow();
    expect(() => meetingsKey(undefined)).toThrow();
    expect(chunkAad("u", "m", "av", 1)).toBe(["meeting", "u", "m", "av", "1"].join("\0"));
  });

  it("texts open only under their AAD", async () => {
    const key = await meetingsKey(SECRET);
    const s = await sealText(key, "", titleAad("u1", "m1"));
    expect(await openText(key, s, titleAad("u1", "m1"))).toBe("");
    expect(await openText(key, s, titleAad("u2", "m1"))).toBeNull();
    expect(await openText(key, s, lineAad("u1", "m1", "me", 0))).toBeNull();
    // Sealed JSON that is not a string, and sealed non-JSON.
    const { seal } = await import("@/lib/connections/crypto");
    expect(await openText(key, await seal(key, "1", "a"), "a")).toBeNull();
    expect(await openText(key, await seal(key, "{", "a"), "a")).toBeNull();
  });
});

describe("meetings store", () => {
  it("creates only on a tap, validates every field", async () => {
    const { d } = setup();
    expect((await createMeeting(d, null)).status).toBe(400);
    expect((await createMeeting(d, body({ extra: 1 }))).json.error).toBe("bad-body");
    expect((await createMeeting(d, body({ tap: false }))).json.error).toBe("no-tap");
    expect((await createMeeting(d, body({ title: " " }))).json.error).toBe("bad-title");
    expect((await createMeeting(d, body({ title: "a\nb" }))).json.error).toBe("bad-title");
    expect((await createMeeting(d, body({ mimeAv: "audio/webm" }))).json.error).toBe("bad-mime");
    expect((await createMeeting(d, body({ mimeAudio: "video/webm" }))).json.error).toBe("bad-mime");
    expect((await createMeeting(d, body({ width: -1 }))).json.error).toBe("bad-size");
    expect((await createMeeting(d, body({ hasMic: 1 }))).json.error).toBe("bad-tracks");
    expect((await createMeeting(d, body({ device: "<x>" }))).json.error).toBe("bad-device");
    expect((await createMeeting(d, body({ transcript: "ai" }))).json.error).toBe("bad-transcript");
    const r = await createMeeting(
      d,
      body({ width: null, height: undefined, device: undefined, transcript: "local" }),
    );
    expect(r.json).toMatchObject({ ok: true, startedAt: NOW, chunkMs: 30_000 });
    const g = await getMeeting(d, r.json.id as string);
    expect(g.json.meeting).toMatchObject({
      status: "recording",
      title: "Meeting, 19 Nov 2026",
      hasMic: true,
      transcript: "local",
      transcriptStatus: "waiting",
      width: null,
    });
    expect(bad(400, "a b").json.error).toBe("a-b");
  });

  it("stores pieces sealed, idempotent per seq, counts bytes and length", async () => {
    const { d, blobs } = setup();
    const id = await newMeeting(d);
    const p0 = enc.encode("header+cluster0");
    const h0 = await hdr(p0, { "x-lk-frag-off": "7", "x-lk-frag-ms": "0" });
    expect((await putChunk(d, id, "av", 0, h0, p0)).json).toEqual({ ok: true });
    expect((await putChunk(d, id, "av", 0, h0, p0)).json).toEqual({ ok: true, dup: true });
    const other = enc.encode("different");
    expect((await putChunk(d, id, "av", 0, await hdr(other), other)).status).toBe(409);
    const sealed = blobs.map.get(chunkKey("u1", id, "av", 0))!;
    expect(new TextDecoder().decode(sealed)).not.toContain("header");
    const p1 = enc.encode("me piece");
    expect(
      (await putChunk(d, id, "me", 0, await hdr(p1, { "x-lk-start-ms": "30000" }), p1)).status,
    ).toBe(200);
    expect(await usedBytes(d)).toBe(p0.length + p1.length);
    const g = await getMeeting(d, id);
    expect((g.json.meeting as { durationMs: number }).durationMs).toBe(60_000);
    expect((g.json.chunks as ChunkMeta[]).map((c) => `${c.track}${c.seq}`)).toEqual(["av0", "me0"]);
    const got = await chunkBytes(d, id, "av", 0);
    expect("bytes" in got && new TextDecoder().decode(got.bytes)).toBe("header+cluster0");
    expect("bytes" in got && got.mime).toBe("video/webm;codecs=vp9,opus");
    const me = await chunkBytes(d, id, "me", 0);
    expect("bytes" in me && me).toMatchObject({
      mime: "audio/webm;codecs=opus",
      startMs: 30_000,
      durMs: 30_000,
    });
    expect((await chunkIndex(d, id, "me")).json.chunks).toHaveLength(1);
    expect((await chunkIndex(d, id, null)).json.chunks).toHaveLength(2);
    expect((await chunkIndex(d, id, "room")).status).toBe(400);
    expect((await chunkIndex(d, "x", null)).status).toBe(400);
    expect((await chunkIndex(d, newMeetingId(), null)).status).toBe(404);
    expect(st(await chunkBytes(d, id, "others", 0))).toBe(404);
    expect(st(await chunkBytes(d, "bad", "av", 0))).toBe(400);
    expect(st(await chunkBytes(d, newMeetingId(), "av", 0))).toBe(404);
    blobs.map.delete(chunkKey("u1", id, "me", 0));
    expect(st(await chunkBytes(d, id, "me", 0))).toBe(410);
  });

  it("refuses bad pieces", async () => {
    const { d } = setup("u1", { limits: { quotaBytes: 20, maxMs: 60_000, chunkMs: 30_000 } });
    const id = await newMeeting(d);
    const p = enc.encode("abc");
    const h = await hdr(p);
    expect((await putChunk(d, "nope", "av", 0, h, p)).status).toBe(400);
    expect((await putChunk(d, id, "av", -1, h, p)).status).toBe(400);
    expect((await putChunk(d, id, "av", 0, h, new Uint8Array())).json.error).toBe("empty");
    expect(
      (await putChunk(d, id, "av", 0, h, { length: MAX_CHUNK_BYTES + 1 } as Uint8Array)).status,
    ).toBe(413);
    expect((await putChunk(d, newMeetingId(), "av", 0, h, p)).status).toBe(404);
    expect((await putChunk(d, id, "av", 0, await hdr(enc.encode("x")), p)).json.error).toBe(
      "bad-hash",
    );
    expect(
      (await putChunk(d, id, "av", 0, await hdr(p, { "x-lk-start-ms": "100000" }), p)).json.error,
    ).toBe("too-long");
    const big = enc.encode("x".repeat(25));
    expect((await putChunk(d, id, "av", 0, await hdr(big), big)).json.error).toBe("quota-full");
    // Quota full also refuses a new meeting.
    expect((await putChunk(d, id, "av", 0, h, p)).status).toBe(200);
    const big2 = enc.encode("y".repeat(17));
    expect((await putChunk(d, id, "av", 1, await hdr(big2), big2)).status).toBe(200);
    expect((await createMeeting(d, body())).status).toBe(429);
  });

  it("a failed row write deletes the object; a lost race reads as dup", async () => {
    const { d, blobs, db } = setup();
    const id = await newMeeting(d);
    const p = enc.encode("abc");
    const h = await hdr(p);
    const real = db.batch.bind(db);
    (db as { batch: unknown }).batch = async () => {
      throw new Error("d1 down");
    };
    await expect(putChunk(d, id, "av", 0, h, p)).rejects.toThrow("d1 down");
    expect(blobs.map.size).toBe(0);
    // The race: another PUT stored the same seq between the check and the batch.
    (db as { batch: unknown }).batch = async (s: never[]) => {
      await real(s);
      throw new Error("unique");
    };
    expect((await putChunk(d, id, "av", 0, h, p)).json).toEqual({ ok: true, dup: true });
  });

  it("ends once; leftovers go into an interrupted meeting for a day", async () => {
    const { d } = setup();
    const id = await newMeeting(d);
    expect((await endMeeting(d, "x", {})).status).toBe(400);
    expect((await endMeeting(d, newMeetingId(), {})).status).toBe(404);
    expect((await endMeeting(d, id, { interrupted: true })).json).toEqual({
      ok: true,
      status: "interrupted",
    });
    expect((await endMeeting(d, id, null)).json).toEqual({ ok: true, status: "interrupted" });
    const p = enc.encode("late");
    expect((await putChunk(d, id, "others", 3, await hdr(p), p)).status).toBe(200);
    const later = { ...d, now: NOW + 86_400_001 };
    expect((await putChunk(later, id, "others", 4, await hdr(p), p)).json.error).toBe("closed");
    const id2 = await newMeeting(d);
    expect((await endMeeting(d, id2, {})).json.status).toBe("ended");
    expect((await putChunk(d, id2, "av", 0, await hdr(p), p)).status).toBe(409);
  });

  it("lists newest first with a cursor, own rows only, none being deleted", async () => {
    const { d } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(await newMeeting({ ...d, now: NOW + i * 1000 }, { title: `M${i}` }));
    const other = { ...d, uid: "u2" };
    await newMeeting(other);
    const a = await listMeetings(d, new URLSearchParams("limit=2"));
    expect((a.json.meetings as { title: string }[]).map((m) => m.title)).toEqual(["M4", "M3"]);
    const b = await listMeetings(d, new URLSearchParams(`limit=2&before=${a.json.next}`));
    expect((b.json.meetings as { title: string }[]).map((m) => m.title)).toEqual(["M2", "M1"]);
    await deleteMeeting(d, ids[0]);
    const c = await listMeetings(d, new URLSearchParams(`limit=2&before=${b.json.next}`));
    expect(c.json.meetings).toEqual([]);
    expect(c.json.next).toBeNull();
    expect((await listMeetings(d, new URLSearchParams())).json.meetings).toHaveLength(4);
    expect((await listMeetings(d, new URLSearchParams("limit=0"))).status).toBe(400);
    expect((await listMeetings(d, new URLSearchParams("before=zz"))).status).toBe(400);
    expect((await getMeeting(other, ids[1])).status).toBe(404);
    expect((await getMeeting(d, "short")).status).toBe(400);
  });

  it("renames and changes the transcript choice", async () => {
    const { d } = setup();
    const id = await newMeeting(d);
    expect((await patchMeeting(d, "x", {})).status).toBe(400);
    expect((await patchMeeting(d, id, {})).status).toBe(400);
    expect((await patchMeeting(d, id, { nope: 1 })).status).toBe(400);
    expect((await patchMeeting(d, newMeetingId(), { title: "a" })).status).toBe(404);
    expect((await patchMeeting(d, id, { title: "" })).status).toBe(400);
    expect((await patchMeeting(d, id, { transcript: "x" })).status).toBe(400);
    expect((await patchMeeting(d, id, { title: "Standup", transcript: "local" })).status).toBe(200);
    let m = (await getMeeting(d, id)).json.meeting as Record<string, unknown>;
    expect(m).toMatchObject({ title: "Standup", transcript: "local", transcriptStatus: "waiting" });
    await d.db.prepare("UPDATE meeting SET transcript_status = 'done'").run();
    await patchMeeting(d, id, { transcript: "cloud" });
    m = (await getMeeting(d, id)).json.meeting as Record<string, unknown>;
    expect(m.transcriptStatus).toBe("done");
    await patchMeeting(d, id, { transcript: "none" });
    m = (await getMeeting(d, id)).json.meeting as Record<string, unknown>;
    expect(m.transcriptStatus).toBe("none");
  });

  it("downloads the av pieces in order, one at a time, skipping one that does not open", async () => {
    const { d, blobs } = setup();
    const id = await newMeeting(d);
    for (const [seq, s] of ["aa", "bb", "cc"].entries()) {
      const p = enc.encode(s);
      await putChunk(d, id, "av", seq, await hdr(p), p);
    }
    blobs.map.set(chunkKey("u1", id, "av", 1), new Uint8Array(40));
    const r = await downloadAv(d, id);
    if (!("stream" in r)) throw new Error("no stream");
    expect(await new Response(r.stream).text()).toBe("aacc");
    expect(r.mime).toBe("video/webm");
    expect(r.name).toMatch(/^lianki-meeting-2026-11-19-.{6}\.webm$/);
    expect(st(await downloadAv(d, "x"))).toBe(400);
    expect(st(await downloadAv(d, newMeetingId()))).toBe(404);
    const empty = await newMeeting(d);
    expect(st(await downloadAv(d, empty))).toBe(404);
  });

  it("deletes for good: objects, then rows; another account's meeting untouched", async () => {
    const { d, blobs } = setup();
    const id = await newMeeting(d);
    const p = enc.encode("x");
    await putChunk(d, id, "av", 0, await hdr(p), p);
    await putChunk(d, id, "me", 0, await hdr(p), p);
    await putLines(d, id, {
      source: "final",
      lines: [{ track: "me", startMs: 0, endMs: 10, text: "hi" }],
    });
    const other = { ...d, uid: "u2" };
    const theirs = await newMeeting(other);
    await putChunk(other, theirs, "av", 0, await hdr(p), p);
    expect((await deleteMeeting(other, id)).json.deleted).toBe(0);
    expect((await deleteMeeting(d, "x")).status).toBe(400);
    expect((await deleteMeeting(d, id)).json).toEqual({ ok: true, deleted: 1 });
    expect([...blobs.map.keys()]).toEqual([chunkKey("u2", theirs, "av", 0)]);
    for (const t of ["meeting", "meeting_chunk", "meeting_line"]) {
      const r = await d.db
        .prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = 'u1'`)
        .first<{ n: number }>();
      expect(r?.n).toBe(0);
    }
    expect((await deleteMeeting(d, id)).json.deleted).toBe(0);
  });

  it("purge lists in pages and deletes ≤ 1000 keys a call", async () => {
    const { d, blobs } = setup();
    for (let i = 0; i < 2500; i++)
      blobs.map.set(`meetings/u1/m1/av/${seqName(i)}`, new Uint8Array(1));
    blobs.map.set("meetings/u1/m10/av/000000", new Uint8Array(1));
    expect(await purgeMeeting(d.db as unknown as SweepDb, blobs, "u1", "m1")).toBe(2500);
    expect(blobs.deletes).toBe(3);
    expect(blobs.map.size).toBe(1);
    expect(await purgeMeeting(d.db as unknown as SweepDb, null, "u1", "m1")).toBe(0);
  });
});

describe("lines", () => {
  const L = (
    track: string,
    startMs: number,
    endMs: number,
    text: string,
    o: Record<string, unknown> = {},
  ) => ({
    track,
    startMs,
    endMs,
    text,
    ...o,
  });
  const texts = async (d: MeetDeps, id: string) =>
    ((await getLines(d, id)).json.lines as { text: string; source: string }[]).map(
      (l) => `${l.text}:${l.source}`,
    );

  it("validates", () => {
    expect(parseLines(null)).toBe("bad body");
    expect(parseLines([])).toBe("bad body");
    expect(parseLines({ source: "x", lines: [] })).toBe("bad source");
    expect(parseLines({ source: "live", lines: "x" })).toBe("bad body");
    expect(parseLines({ source: "live", lines: [] })).toBe("no lines");
    expect(parseLines({ source: "live", lines: [], extra: 1 })).toBe("bad body");
    expect(parseLines({ source: "live", lines: Array(201).fill(L("me", 0, 1, "a")) })).toBe(
      "too many",
    );
    expect(parseLines({ source: "live", lines: [L("av", 0, 1, "a")] })).toBe("bad track");
    expect(parseLines({ source: "live", lines: [L("me", 5, 5, "a")] })).toBe("bad time");
    expect(parseLines({ source: "live", lines: [L("me", 0, 1, "a\u0001")] })).toBe("bad text");
    expect(parseLines({ source: "live", lines: [L("me", 0, 1, "a", { speaker: 1 })] })).toBe(
      "bad speaker",
    );
    expect(parseLines({ source: "live", lines: [L("me", 0, 1, "a", { lang: "EN!" })] })).toBe(
      "bad lang",
    );
    expect(parseLines({ source: "live", lines: [L("me", 0, 1, "a", { source: "final" })] })).toBe(
      "bad line",
    );
    expect(parseLines({ source: "live", lines: [L("me", 0, 1, "a"), L("me", 0, 2, "b")] })).toBe(
      "duplicate line",
    );
    expect(
      parseLines({ source: "final", lines: [], replace: { track: "av", startMs: 0, endMs: 1 } }),
    ).toBe("bad replace");
    expect(
      parseLines({
        source: "final",
        lines: [],
        replace: { track: "me", startMs: 0, endMs: 1, x: 1 },
      }),
    ).toBe("bad replace");
    const ok = parseLines({
      source: "final",
      lines: [],
      replace: { track: "me", startMs: 0, endMs: 1 },
    });
    expect(ok).toEqual({
      source: "final",
      lines: [],
      replace: { track: "me", startMs: 0, endMs: 1 },
    });
  });

  it("a final PUT deletes overlapping live rows atomically; GET hides overlapped live rows", async () => {
    const { d } = setup();
    const id = await newMeeting(d);
    await putLines(d, id, {
      source: "live",
      lines: [
        L("me", 0, 1000, "l0"),
        L("me", 1000, 2000, "l1"),
        L("me", 5000, 6000, "l5"),
        L("others", 0, 3000, "o0"),
      ],
    });
    expect(await texts(d, id)).toEqual(["l0:live", "o0:live", "l1:live", "l5:live"]);
    // A final over [500, 1500) on me: l0 and l1 overlap it and go; l5 and others' o0 stay.
    const r = await putLines(d, id, {
      source: "final",
      lines: [L("me", 500, 1500, "f", { speaker: "voice-a", lang: "en" })],
    });
    expect(r.json).toEqual({ ok: true, lines: 1 });
    expect(await texts(d, id)).toEqual(["o0:live", "f:final", "l5:live"]);
    // A live line arriving later under the final's key does not overwrite it, and is hidden while overlapped.
    await putLines(d, id, {
      source: "live",
      lines: [L("me", 500, 900, "late"), L("me", 1400, 1700, "edge")],
    });
    expect(await texts(d, id)).toEqual(["o0:live", "f:final", "l5:live"]);
    const raw = await d.db
      .prepare("SELECT COUNT(*) AS n FROM meeting_line WHERE source = 'live' AND track = 'me'")
      .first<{ n: number }>();
    expect(raw?.n).toBe(2);
    // A final replaces a final at the same key.
    await putLines(d, id, { source: "final", lines: [L("me", 500, 1500, "f2")] });
    expect(await texts(d, id)).toEqual(["o0:live", "f2:final", "l5:live"]);
  });

  it("the batch is atomic: a failing write leaves the live rows", async () => {
    const { d, db } = setup();
    const id = await newMeeting(d);
    await putLines(d, id, { source: "live", lines: [L("me", 0, 1000, "l0")] });
    const real = db.batch.bind(db);
    (db as { batch: unknown }).batch = async (s: unknown[]) => {
      await real([...s, db.prepare("INSERT INTO nope VALUES (1)")] as never);
    };
    await expect(
      putLines(d, id, { source: "final", lines: [L("me", 0, 900, "f")] }),
    ).rejects.toThrow();
    (db as { batch: unknown }).batch = real;
    expect(await texts(d, id)).toEqual(["l0:live"]);
  });

  it("replace clears that track's span, live and final, even with no lines", async () => {
    const { d } = setup();
    const id = await newMeeting(d);
    await putLines(d, id, {
      source: "final",
      lines: [L("me", 0, 1000, "a"), L("me", 1000, 2000, "b"), L("me", 3000, 4000, "c")],
    });
    await putLines(d, id, {
      source: "live",
      lines: [L("me", 2000, 2500, "lv"), L("others", 1000, 2000, "o")],
    });
    await putLines(d, id, {
      source: "final",
      lines: [],
      replace: { track: "me", startMs: 1000, endMs: 3000 },
    });
    expect(await texts(d, id)).toEqual(["a:final", "o:live", "c:final"]);
    // Replace with new lines: a span re-transcribed.
    await putLines(d, id, {
      source: "final",
      lines: [L("me", 0, 1500, "A")],
      replace: { track: "me", startMs: 0, endMs: 3000 },
    });
    expect(await texts(d, id)).toEqual(["A:final", "o:live", "c:final"]);
  });

  it("own meeting only; errors; text sealed at rest; txt and vtt", async () => {
    const { d } = setup();
    const id = await newMeeting(d);
    const other = { ...d, uid: "u2" };
    expect(
      (await putLines(other, id, { source: "live", lines: [L("me", 0, 1, "x")] })).status,
    ).toBe(404);
    expect((await getLines(other, id)).status).toBe(404);
    expect((await putLines(d, "x", {})).status).toBe(400);
    expect((await getLines(d, "x")).status).toBe(400);
    expect(
      (await putLines(d, id, { source: "live", lines: Array(201).fill(L("me", 0, 1, "a")) }))
        .status,
    ).toBe(413);
    expect((await putLines(d, id, { source: "live", lines: [] })).status).toBe(400);
    await putLines(d, id, {
      source: "final",
      lines: [
        L("me", 1500, 3000, "Hello -->"),
        L("others", 61_000, 62_500, "Hi", { speaker: "Ana" }),
      ],
    });
    const raw = await d.db
      .prepare("SELECT text_sealed AS t FROM meeting_line")
      .all<{ t: string }>();
    expect(raw.results.every((r) => r.t.startsWith("v1.") && !r.t.includes("Hello"))).toBe(true);
    const lines = (await getLines(d, id)).json.lines as never[];
    expect(linesTxt(lines)).toBe("00:00:01 [Me] Hello -->\n00:01:01 [Ana] Hi\n");
    expect(linesVtt(lines)).toBe(
      "WEBVTT\n\n00:00:01.500 --> 00:00:03.000\n<v Me>Hello →\n\n00:01:01.000 --> 00:01:02.500\n<v Ana>Hi\n",
    );
    const f = await transcriptFile(d, id, "vtt");
    expect("text" in f && f.name).toMatch(/\.vtt$/);
    const t = await transcriptFile(d, id, "txt");
    expect("text" in t && t.text).toContain("[Ana]");
    expect(st(await transcriptFile(d, "x", "txt"))).toBe(400);
    expect(st(await transcriptFile(d, newMeetingId(), "txt"))).toBe(404);
    // A line that does not open (rotated secret) is left out.
    await d.db.prepare("UPDATE meeting_line SET text_sealed = 'v1.x.y' WHERE track = 'me'").run();
    expect(((await getLines(d, id)).json.lines as unknown[]).length).toBe(1);
  });
});

describe("sweep", () => {
  it("finishes deletes, expires by retention, marks stale meetings interrupted", async () => {
    const { d, blobs } = setup();
    const db = d.db as unknown as SweepDb;
    const p = enc.encode("x");
    const old = await newMeeting({ ...d, now: NOW - 40 * 86_400_000 });
    await putChunk({ ...d, now: NOW - 40 * 86_400_000 }, old, "av", 0, await hdr(p), p);
    const stale = await newMeeting({ ...d, now: NOW - 3_600_000 });
    const fresh = await newMeeting({ ...d, now: NOW - 60_000 });
    const half = await newMeeting(d);
    await d.db.prepare("UPDATE meeting SET status = 'deleting' WHERE id = ?").bind(half).run();
    // Retention off (0, the default): nothing expires.
    let r = await sweepMeetings(db, blobs, NOW);
    expect(r).toEqual({ purged: 1, interrupted: 2, expired: 0 });
    const status = async (id: string) =>
      (
        await d.db
          .prepare("SELECT status FROM meeting WHERE id = ?")
          .bind(id)
          .first<{ status: string }>()
      )?.status;
    expect(await status(stale)).toBe("interrupted");
    expect(await status(old)).toBe("interrupted");
    expect(await status(fresh)).toBe("recording");
    expect(await status(half)).toBeUndefined();
    await d.db
      .prepare(
        "INSERT INTO config_values (key, value_json, updated_at, updated_by) VALUES ('meetings.retentionDays', '30', 0, 'x')",
      )
      .run();
    r = await sweepMeetings(db, blobs, NOW);
    expect(r).toEqual({ purged: 1, interrupted: 0, expired: 1 });
    expect(await status(old)).toBeUndefined();
    expect(blobs.map.size).toBe(0);
  });

  it("reads defaults when the config table cannot be read", async () => {
    const calls: string[] = [];
    const stmt = {
      bind: () => stmt,
      first: async () => {
        throw new Error("no table");
      },
      all: async () => ({ results: [] }),
      run: async () => ({}),
    };
    const db = {
      prepare: (s: string) => {
        calls.push(s);
        return stmt;
      },
      batch: async () => {},
    } as unknown as SweepDb;
    expect(await sweepMeetings(db, null, NOW)).toEqual({ purged: 0, interrupted: 0, expired: 0 });
  });
});

describe("r2 adapter", () => {
  it("maps put/get/delete/list", async () => {
    const store = new Map<string, Uint8Array>();
    const bucket = {
      put: async (k: string, v: Uint8Array) => void store.set(k, v),
      get: async (k: string) => {
        const v = store.get(k);
        return v ? { arrayBuffer: async () => v.buffer as ArrayBuffer } : null;
      },
      delete: async (k: string | string[]) =>
        void (Array.isArray(k) ? k : [k]).forEach((x) => store.delete(x)),
      list: async () => ({ objects: [...store.keys()].map((key) => ({ key })), truncated: false }),
    };
    const b = r2MeetBlobs(bucket);
    await b.put("a", new Uint8Array([1, 2]));
    expect(await b.get("a")).toEqual(new Uint8Array([1, 2]));
    expect(await b.get("b")).toBeNull();
    expect((await b.list({ prefix: "" })).objects).toEqual([{ key: "a" }]);
    await b.delete(["a"]);
    expect(store.size).toBe(0);
  });
});

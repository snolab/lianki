/**
 * The voice-clone reference in the account (lib/voice-clone-ref.ts,
 * app/api/my/voice-clone-ref; docs/voice-clone.md): one WAV and its transcript,
 * strictly checked, sealed at rest with AAD bound to user, kind and revision,
 * own row only, every write a fresh single-use passkey ticket for this account.
 */
import { describe, expect, it } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { importTicketKey } from "@/lib/stt-ticket";
import { type ApprovalDeps, voiceprintApproval } from "@/lib/voiceprint-approval";
import { voiceprintKey } from "@/lib/voiceprint-cloud";
import {
  CLONE_REF_LIMITS,
  type CloneRefBlobs,
  type CloneRefDb,
  type CloneRefDeps,
  type RefRow,
  MAX_PUT_BODY,
  cloneRefKey,
  d1CloneRefDb,
  deleteCloneRef,
  fromBase64,
  getCloneRef,
  objectKey,
  openAudio,
  openText,
  parseCloneRefPut,
  parseWav,
  putCloneRef,
  r2CloneRefBlobs,
  sealAudio,
  sealText,
  toBase64,
} from "@/lib/voice-clone-ref";
import {
  type VoiceprintOp,
  importTicketVerifyKey,
  openPayload,
  signVoiceprintTicket,
  validDevice,
} from "@/lib/voiceprint-ticket";

const SECRET = "x".repeat(48);
const NOW = 1_800_000_000_000;

async function keys() {
  const p = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", p.privateKey);
  const raw = JSON.stringify({ kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x });
  return { key: await importTicketKey(raw), pub: await importTicketVerifyKey(raw) };
}

/** A WAV as a writer makes it; each field overridable to make a bad one. */
function wav(
  o: {
    seconds?: number;
    rate?: number;
    channels?: number;
    bits?: number;
    format?: number;
    align?: number;
    fmtSize?: number;
    list?: boolean;
    extra?: string;
    dataFirst?: boolean;
    dataBytes?: number;
    riffDelta?: number;
  } = {},
): Uint8Array {
  const rate = o.rate ?? 24_000;
  const channels = o.channels ?? 1;
  const bits = o.bits ?? 16;
  const dataBytes = o.dataBytes ?? Math.round((o.seconds ?? 5) * rate) * 2;
  const fmtSize = o.fmtSize ?? 16;
  const chunks: Uint8Array[] = [];
  const chunk = (id: string, body: Uint8Array) => {
    const h = new Uint8Array(8);
    for (let i = 0; i < 4; i++) h[i] = id.charCodeAt(i);
    new DataView(h.buffer).setUint32(4, body.length, true);
    chunks.push(h, body);
    if (body.length & 1) chunks.push(new Uint8Array(1));
  };
  const fmt = new Uint8Array(fmtSize);
  const v = new DataView(fmt.buffer);
  v.setUint16(0, o.format ?? 1, true);
  v.setUint16(2, channels, true);
  v.setUint32(4, rate, true);
  v.setUint32(8, (rate * channels * bits) / 8, true);
  v.setUint16(12, o.align ?? (channels * bits) / 8, true);
  v.setUint16(14, bits, true);
  const data = new Uint8Array(dataBytes).map((_, i) => i % 251);
  if (o.dataFirst) chunk("data", data);
  chunk("fmt ", fmt);
  if (o.list) chunk("LIST", new TextEncoder().encode("INFOISFT"));
  if (o.extra) chunk(o.extra, new Uint8Array(4));
  if (!o.dataFirst) chunk("data", data);
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + len);
  out.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, len + 4 + (o.riffDelta ?? 0), true);
  out.set(new TextEncoder().encode("WAVE"), 8);
  let at = 12;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

describe("the WAV", () => {
  it("takes 24 kHz mono 16-bit PCM between 1 and 30 s", () => {
    expect(parseWav(wav())).toEqual({ sampleRate: 24_000, durationMs: 5_000, bytes: 240_044 });
    expect(parseWav(wav({ seconds: 30 }))).toMatchObject({ durationMs: 30_000 });
    expect(parseWav(wav({ list: true }))).toMatchObject({ durationMs: 5_000 });
    expect(parseWav(wav({ fmtSize: 18 }))).toMatchObject({ durationMs: 5_000 });
  });
  it("refuses anything else whole", () => {
    const cases: [Parameters<typeof wav>[0], string][] = [
      [{ seconds: 0.5 }, "too short"],
      [{ seconds: 30.5 }, "too long"],
      [{ seconds: 32 }, "too large"],
      [{ rate: 44_100, seconds: 2 }, "bad sample rate"],
      [{ rate: 16_000 }, "bad sample rate"],
      [{ channels: 2 }, "not mono"],
      [{ bits: 8 }, "not 16-bit"],
      [{ bits: 24 }, "not 16-bit"],
      [{ format: 3 }, "not pcm"],
      [{ format: 0xfffe }, "not pcm"],
      [{ align: 4 }, "bad fmt"],
      [{ fmtSize: 20 }, "bad fmt"],
      [{ extra: "junk" }, "unexpected chunk"],
      [{ extra: "fmt " }, "duplicate chunk"],
      [{ dataFirst: true }, "data before fmt"],
      [{ dataBytes: 0 }, "bad data"],
      [{ dataBytes: 48_001 }, "bad data"],
      [{ riffDelta: 2 }, "bad riff size"],
    ];
    for (const [o, why] of cases) expect([o, parseWav(wav(o))]).toEqual([o, why]);
    expect(parseWav(new Uint8Array(20))).toBe("not a wav");
    const notRiff = wav();
    notRiff[0] = 0x52 + 1;
    expect(parseWav(notRiff)).toBe("not a wav");
    // A chunk table that runs past the end, or stops in a header.
    const cut = wav().slice(0, 100);
    new DataView(cut.buffer).setUint32(4, cut.length - 8, true);
    expect(parseWav(cut)).toBe("truncated chunk");
    const stub = new Uint8Array([...wav().slice(0, 48), 0x64, 0x61]);
    new DataView(stub.buffer).setUint32(4, stub.length - 8, true);
    expect(parseWav(stub)).toBe("truncated chunk");
    const enc = new TextEncoder();
    const header = new Uint8Array([
      ...wav().slice(0, 36),
      ...enc.encode("LIST"),
      0,
      0,
      0,
      0,
      ...enc.encode("data"),
    ]);
    new DataView(header.buffer).setUint32(4, header.length - 8, true);
    expect(parseWav(header)).toBe("truncated chunk");
    // fmt and an empty LIST: no audio.
    const noData = new Uint8Array(44);
    noData.set(wav().slice(0, 36));
    noData.set(new TextEncoder().encode("LIST"), 36);
    new DataView(noData.buffer).setUint32(4, 36, true);
    expect(parseWav(noData)).toBe("no audio");
  });
  it("base64 round-trips and refuses what is not base64", () => {
    const b = wav({ seconds: 2 });
    expect(fromBase64(toBase64(b))).toEqual(b);
    expect(fromBase64("abc")).toBeNull();
    expect(fromBase64("ab-_")).toBeNull();
    expect(fromBase64("====")).toBeNull();
  });
});

describe("the PUT body", () => {
  const good = () => ({ ticket: "t", text: "今天天气很好。", wav: toBase64(wav()) });
  it("is exactly {ticket, text, wav}", () => {
    const p = parseCloneRefPut(good());
    expect(typeof p).toBe("object");
    expect(p).toMatchObject({ ticket: "t", text: "今天天气很好。", info: { durationMs: 5_000 } });
  });
  it("refuses anything else whole", () => {
    const cases: [unknown, string][] = [
      [null, "bad body"],
      [[], "bad body"],
      [{ ...good(), uid: "someone" }, "bad body"],
      [{ ...good(), ticket: 1 }, "no ticket"],
      [{ ...good(), text: "  " }, "no text"],
      [{ ...good(), text: 3 }, "no text"],
      [{ ...good(), text: "x".repeat(CLONE_REF_LIMITS.maxTextChars + 1) }, "text too long"],
      [{ ...good(), text: "a\u0000b" }, "bad text"],
      [{ ...good(), wav: "" }, "no wav"],
      [{ ...good(), wav: "not base64!" }, "bad wav encoding"],
      [{ ...good(), wav: "A".repeat(MAX_PUT_BODY) }, "too large"],
      [{ ...good(), wav: toBase64(wav({ channels: 2 })) }, "not mono"],
    ];
    for (const [b, why] of cases) expect(parseCloneRefPut(b)).toBe(why);
    // Tab and newlines are text.
    expect(typeof parseCloneRefPut({ ...good(), text: "a\tb\nc\r\n" })).toBe("object");
  });
});

describe("at rest", () => {
  it("opens only with its own user, kind and revision", async () => {
    const key = await cloneRefKey(SECRET);
    const w = wav({ seconds: 2 });
    const s = await sealAudio(key, "u1", "r1", w);
    expect(await openAudio(key, "u1", "r1", s)).toEqual(w);
    expect(await openAudio(key, "u2", "r1", s)).toBeNull();
    expect(await openAudio(key, "u1", "r2", s)).toBeNull();
    // Not the audio in clear.
    expect(new TextDecoder().decode(s).includes("RIFF")).toBe(false);
    const bad = s.slice();
    bad[0] = 0;
    expect(await openAudio(key, "u1", "r1", bad)).toBeNull();
    expect(await openAudio(key, "u1", "r1", s.slice(0, 20))).toBeNull();
    // Another key (rotated AUTH_SECRET, or the voiceprint's): does not open.
    expect(await openAudio(await cloneRefKey("y".repeat(48)), "u1", "r1", s)).toBeNull();
    expect(await openAudio(await voiceprintKey(SECRET), "u1", "r1", s)).toBeNull();
    const t = await sealText(key, "u1", "r1", "hello");
    expect(await openText(key, "u1", "r1", t)).toBe("hello");
    expect(await openText(key, "u2", "r1", t)).toBeNull();
    expect(await openText(key, "u1", "r2", t)).toBeNull();
    expect(cloneRefKey(SECRET)).toBe(cloneRefKey(SECRET));
    expect(() => cloneRefKey("short")).toThrow();
    expect(() => cloneRefKey(undefined)).toThrow();
  });
});

function memDb(): CloneRefDb & { rows: Map<string, RefRow>; spent: Set<string>; fail?: boolean } {
  const rows = new Map<string, RefRow>();
  const spent = new Set<string>();
  const m = {
    rows,
    spent,
    fail: false,
    async get(uid: string) {
      return rows.get(uid) ?? null;
    },
    async put(uid: string, row: RefRow) {
      if (m.fail) throw new Error("d1 down");
      rows.set(uid, row);
    },
    async delete(uid: string) {
      return rows.delete(uid);
    },
    async spend(jti: string) {
      if (spent.has(jti)) return false;
      spent.add(jti);
      return true;
    },
  };
  return m;
}
function memBlobs(): CloneRefBlobs & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(k, b) {
      objects.set(k, b);
    },
    async get(k) {
      return objects.get(k) ?? null;
    },
    async delete(k) {
      objects.delete(k);
    },
  };
}

async function setup() {
  const k = await keys();
  const db = memDb();
  const blobs = memBlobs();
  const deps = (uid: string): CloneRefDeps => ({
    uid,
    db,
    blobs,
    key: () => cloneRefKey(SECRET),
    pub: async () => k.pub,
    now: NOW,
  });
  const ticket = async (
    o: { op?: VoiceprintOp; uid?: string; device?: string; uv?: boolean; now?: number } = {},
  ) =>
    (
      await signVoiceprintTicket(k.key, {
        op: o.op ?? "clone-ref-put",
        device: o.device ?? "*",
        uv: o.uv ?? true,
        uid: o.uid ?? "owner-1",
        now: o.now ?? NOW,
      })
    ).ticket;
  return { k, db, blobs, deps, ticket };
}
const body = (ticket: string, o: Parameters<typeof wav>[0] = {}, text = "我的声音。") => ({
  ticket,
  text,
  wav: toBase64(wav(o)),
});

describe("tickets", () => {
  it("a write takes a live passkey clone-ref ticket for this account, once", async () => {
    const { deps, ticket } = await setup();
    const d = deps("owner-1");
    const refuse = async (t: string, why: string) =>
      expect((await putCloneRef(d, body(t))).json.error).toBe(why.replace(/ /g, "-"));
    await refuse(await ticket({ op: "export" }), "wrong op");
    await refuse(await ticket({ op: "clone-ref-delete" }), "wrong op");
    await refuse(await ticket({ uv: false }), "no passkey");
    await refuse(await ticket({ uid: "intruder" }), "not your ticket");
    await refuse(await ticket({ device: "iphone" }), "wrong device");
    await refuse(await ticket({ now: NOW - 120_000 }), "expired");
    await refuse("garbage", "bad ticket");
    const t = await ticket();
    expect((await putCloneRef(d, body(t))).status).toBe(200);
    await refuse(t, "approval already used");
  });
  it("the passkey approval mints clone-ref tickets only from a fresh assertion, for '*'", async () => {
    const k = await keys();
    const d: ApprovalDeps = {
      key: k.key,
      pub: k.pub,
      userId: "owner-1",
      now: NOW,
      windowMs: 600_000,
      sid: "session-tag",
      rp: { rpID: "lianki.com", origins: ["https://lianki.com"] },
      passkeys: async () => [{ id: "pk", credentialID: "cred", publicKey: "AAAA", counter: 0 }],
      check: async () => ({ verified: true, userVerified: true, newCounter: 1 }),
      saveCounter: async () => {},
      consume: async () => true,
    };
    expect(validDevice("*", "clone-ref-put")).toBe(true);
    expect(validDevice("iphone", "clone-ref-put")).toBe(false);
    expect(
      (await voiceprintApproval({ op: "clone-ref-put", device: "mac", step: "options" }, d)).json
        .error,
    ).toBe("bad device");
    for (const op of ["clone-ref-put", "clone-ref-delete"] as const) {
      const o = await voiceprintApproval({ op, device: "*", step: "options" }, d);
      const v = await voiceprintApproval(
        {
          op,
          device: "*",
          step: "verify",
          token: o.json.token,
          response: { id: "cred" },
          client: "iphone",
        },
        d,
      );
      expect(v.status).toBe(200);
      // No window grant out of a clone-ref approval.
      expect(v.json.grant).toBeUndefined();
      expect(await openPayload(String(v.json.ticket), k.pub)).toMatchObject({
        op,
        device: "*",
        uv: true,
        uid: "owner-1",
      });
    }
    // A grant from an ordinary voiceprint approval does not mint them either.
    const o = await voiceprintApproval({ op: "export", device: "*", step: "options" }, d);
    const v = await voiceprintApproval(
      {
        op: "export",
        device: "*",
        step: "verify",
        token: o.json.token,
        response: { id: "cred" },
        client: "iphone",
      },
      d,
    );
    expect(typeof v.json.grant).toBe("string");
    const g = await voiceprintApproval(
      { op: "clone-ref-put", device: "*", step: "grant", grant: v.json.grant, client: "iphone" },
      d,
    );
    expect(g).toEqual({ status: 403, json: { error: "this op needs a fresh passkey" } });
  });
});

describe("the account's own row", () => {
  it("PUT, GET, replace, DELETE: own row only, sealed in R2 and D1", async () => {
    const { db, blobs, deps, ticket } = await setup();
    const me = deps("owner-1");
    expect(await getCloneRef(me, false)).toEqual({ status: 200, json: { ref: null } });
    const at = new Date(NOW).toISOString();
    const r = await putCloneRef(me, body(await ticket()));
    expect(r).toEqual({
      status: 200,
      json: {
        ok: true,
        ref: {
          durationMs: 5_000,
          sampleRate: 24_000,
          bytes: 240_044,
          createdAt: at,
          updatedAt: at,
        },
      },
    });
    const row = db.rows.get("owner-1")!;
    expect([...blobs.objects.keys()]).toEqual([objectKey("owner-1", row.rev)]);
    // Nothing in clear: not the transcript in D1, not the RIFF header in R2.
    expect(row.textSealed.includes("声音")).toBe(false);
    expect(row.textSealed.startsWith("v1.")).toBe(true);
    expect(await getCloneRef(me, false)).toMatchObject({ json: { ref: { durationMs: 5_000 } } });
    expect((await getCloneRef(me, false)).json.ref).not.toHaveProperty("wav");
    const full = (await getCloneRef(me, true)).json.ref as Record<string, unknown>;
    expect(full.text).toBe("我的声音。");
    expect(fromBase64(String(full.wav))).toEqual(wav());
    // Another account sees nothing, and cannot read or delete his.
    const other = deps("intruder");
    expect(await getCloneRef(other, true)).toEqual({ status: 200, json: { ref: null } });
    const theirs = await ticket({ op: "clone-ref-delete" });
    expect((await deleteCloneRef(other, { ticket: theirs })).json.error).toBe("not-your-ticket");
    expect(db.rows.size).toBe(1);
    // Replace: a new revision; the old object goes; created stays.
    const later = { ...me, now: NOW + 60_000 };
    const r2 = await putCloneRef(later, body(await ticket({ now: NOW + 60_000 }), { seconds: 8 }));
    expect(r2.json.ref).toMatchObject({ durationMs: 8_000, createdAt: at });
    const row2 = db.rows.get("owner-1")!;
    expect(row2.rev).not.toBe(row.rev);
    expect([...blobs.objects.keys()]).toEqual([objectKey("owner-1", row2.rev)]);
    // The old revision's sealed audio does not open as the new one's.
    const key = await cloneRefKey(SECRET);
    const old = await sealAudio(key, "owner-1", row.rev, wav());
    expect(await openAudio(key, "owner-1", row2.rev, old)).toBeNull();
    // AUTH_SECRET rotated, or the object gone: unreadable, never garbage.
    const rot = { ...me, key: () => cloneRefKey("z".repeat(48)) };
    expect((await getCloneRef(rot, true)).json.ref).toMatchObject({ unreadable: true });
    expect((await getCloneRef(rot, true)).json.ref).not.toHaveProperty("wav");
    // Delete: exactly {ticket}, a delete ticket, once.
    expect((await deleteCloneRef(me, null)).json.error).toBe("bad-body");
    expect((await deleteCloneRef(me, { ticket: "t", device: "*" })).json.error).toBe("bad-body");
    expect((await deleteCloneRef(me, { ticket: 1 })).json.error).toBe("no-ticket");
    expect((await deleteCloneRef(me, { ticket: await ticket() })).json.error).toBe("wrong-op");
    const del = await ticket({ op: "clone-ref-delete" });
    expect(await deleteCloneRef(me, { ticket: del })).toEqual({
      status: 200,
      json: { ok: true, deleted: 1 },
    });
    expect(db.rows.size).toBe(0);
    expect(blobs.objects.size).toBe(0);
    expect((await deleteCloneRef(me, { ticket: del })).json.error).toBe("approval-already-used");
    expect(
      await deleteCloneRef(me, { ticket: await ticket({ op: "clone-ref-delete" }) }),
    ).toMatchObject({ json: { deleted: 0 } });
    expect(await getCloneRef(me, true)).toEqual({ status: 200, json: { ref: null } });
  });
  it("a bad body is refused before the ticket is spent; a failed row write leaves no object", async () => {
    const { db, blobs, deps, ticket } = await setup();
    const me = deps("owner-1");
    const t = await ticket();
    expect(await putCloneRef(me, body(t, { channels: 2 }))).toEqual({
      status: 400,
      json: { error: "not-mono" },
    });
    expect((await putCloneRef(me, body(t, { seconds: 32 }))).status).toBe(413);
    expect(db.spent.size).toBe(0);
    db.fail = true;
    await expect(putCloneRef(me, body(t))).rejects.toThrow("d1 down");
    expect(blobs.objects.size).toBe(0);
    expect(db.rows.size).toBe(0);
  });
  it("a missing object reads as unreadable", async () => {
    const { blobs, deps, ticket } = await setup();
    const me = deps("owner-1");
    await putCloneRef(me, body(await ticket()));
    blobs.objects.clear();
    expect((await getCloneRef(me, true)).json.ref).toMatchObject({ unreadable: true });
  });
});

describe("D1 and R2 adapters", () => {
  it("one row per account, upserted, created kept; each jti spent once", async () => {
    const d1 = createTestD1(testSchema());
    const db = d1CloneRefDb(d1 as never);
    const row = (rev: string, at: string): RefRow => ({
      rev,
      textSealed: "v1.a.b",
      durationMs: 5_000,
      sampleRate: 24_000,
      bytes: 240_044,
      createdAt: at,
      updatedAt: at,
    });
    expect(await db.get("u1")).toBeNull();
    await db.put("u1", row("r1", "2026-11-14T00:00:00.000Z"));
    await db.put("u1", row("r2", "2026-11-14T01:00:00.000Z"));
    await db.put("u2", row("r9", "2026-11-14T02:00:00.000Z"));
    expect(await db.get("u1")).toEqual({
      ...row("r2", "2026-11-14T01:00:00.000Z"),
      createdAt: "2026-11-14T00:00:00.000Z",
    });
    expect(await db.delete("u1")).toBe(true);
    expect(await db.delete("u1")).toBe(false);
    expect(await db.get("u2")).toMatchObject({ rev: "r9" });
    expect(await db.spend("j1", 1_800_000_060)).toBe(true);
    expect(await db.spend("j1", 1_800_000_060)).toBe(false);
  });
  it("R2: sealed bytes in, the same bytes out", async () => {
    const store = new Map<string, Uint8Array>();
    const meta: unknown[] = [];
    const blobs = r2CloneRefBlobs({
      async put(k, v, o) {
        store.set(k, v);
        meta.push(o);
      },
      async get(k) {
        const v = store.get(k);
        return v ? { arrayBuffer: async () => v.slice().buffer as ArrayBuffer } : null;
      },
      async delete(k) {
        store.delete(k);
      },
    });
    await blobs.put("k", new Uint8Array([1, 2, 3]));
    expect(await blobs.get("k")).toEqual(new Uint8Array([1, 2, 3]));
    expect(meta).toEqual([{ httpMetadata: { contentType: "application/octet-stream" } }]);
    await blobs.delete("k");
    expect(await blobs.get("k")).toBeNull();
  });
});

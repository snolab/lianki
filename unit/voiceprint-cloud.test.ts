/**
 * The voiceprint in the account (lib/voiceprint-cloud.ts, app/api/my/voiceprint;
 * docs/local-stt.md, "Voiceprint in your account"): features only, encrypted at
 * rest, own rows only, writes only with a passkey ticket for this account, and
 * the panel's save / restore / delete (packages/debug-chat/src/voiceprint.ts).
 */
import { describe, expect, it } from "bun:test";
import { importTicketKey } from "@/lib/stt-ticket";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { sealKey, unseal } from "@/lib/connections/crypto";
import { type ApprovalDeps, voiceprintApproval } from "@/lib/voiceprint-approval";
import {
  type CloudDeps,
  type VoiceprintDb,
  checkCloudTicket,
  d1VoiceprintDb,
  deletePrints,
  listPrints,
  openPrint,
  parsePrint,
  parsePut,
  putPrints,
  sealPrint,
  voiceprintKey,
} from "@/lib/voiceprint-cloud";
import { importTicketVerifyKey, openPayload, signVoiceprintTicket } from "@/lib/voiceprint-ticket";
import {
  recordingDevice,
  recordingName,
  wavSamples,
  type CloudDeps as PageCloud,
  type EnrolDeps,
  type EnrolView,
  createEnrolment,
  featuresOnly,
} from "@/packages/debug-chat/src/voiceprint";

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

const vec = (dim: number, k: number) => Array.from({ length: dim }, (_, i) => ((i + k) % 7) / 10);
function print(o: Record<string, unknown> = {}) {
  const n = 10;
  return {
    device: "iphone",
    model: "campp",
    dim: 192,
    n,
    created: "2026-11-10T23:00:00+0900",
    updated: "2026-11-10T23:00:00+0900",
    self: { min: 0.4, median: 0.6 },
    speechS: Array.from({ length: n }, () => 2.5),
    centroid: vec(192, 0),
    embeddings: Array.from({ length: n }, (_, i) => vec(192, i)),
    ...o,
  };
}

function memDb(): VoiceprintDb & {
  rows: Map<string, Record<string, unknown>>;
  spent: Set<string>;
} {
  const rows = new Map<string, Record<string, unknown>>();
  const spent = new Set<string>();
  return {
    rows,
    spent,
    async list(uid) {
      return [...rows.values()].filter((r) => r.uid === uid) as never;
    },
    async put(uid, rs) {
      for (const r of rs) rows.set(`${uid}|${r.device}|${r.model}`, { ...r, uid });
    },
    async delete(uid, device) {
      let n = 0;
      for (const [k, r] of rows)
        if (r.uid === uid && (device === null || r.device === device)) {
          rows.delete(k);
          n++;
        }
      return n;
    },
    async spend(jti) {
      if (spent.has(jti)) return false;
      spent.add(jti);
      return true;
    },
  };
}

async function setup() {
  const k = await keys();
  const db = memDb();
  const deps = (uid: string): CloudDeps => ({
    uid,
    db,
    key: () => voiceprintKey(SECRET),
    pub: async () => k.pub,
    now: NOW,
  });
  const ticket = (o: Partial<Parameters<typeof signVoiceprintTicket>[1]> = {}) =>
    signVoiceprintTicket(k.key, {
      op: "export",
      device: "*",
      uv: true,
      uid: "owner-1",
      now: NOW,
      ...o,
    }).then((t) => t.ticket);
  return { k, db, deps, ticket };
}

describe("encryption at rest", () => {
  it("round-trips, and only for its own row", async () => {
    const key = await voiceprintKey(SECRET);
    const p = parsePrint(print());
    if (typeof p === "string") throw new Error(p);
    const payload = await sealPrint(key, "owner-1", p);
    expect(payload).not.toContain("0.1");
    const row = { device: "iphone", model: "campp", payload };
    const f = await openPrint(key, "owner-1", row);
    expect(f?.embeddings).toEqual(p.embeddings);
    expect(f?.centroid).toEqual(p.centroid);
    // Moved to another account or device: does not open.
    expect(await openPrint(key, "someone-else", row)).toBeNull();
    expect(await openPrint(key, "owner-1", { ...row, device: "android" })).toBeNull();
    // Another secret, or the connections key from the same secret: does not open.
    expect(await openPrint(await voiceprintKey("y".repeat(48)), "owner-1", row)).toBeNull();
    const conn = await sealKey("google-refresh", SECRET);
    expect(await unseal(conn, payload, "voiceprint\0owner-1\0iphone\0campp", 600_000)).toBeNull();
  });
  it("refuses a missing or short secret (no fallback key)", () => {
    expect(() => voiceprintKey(undefined)).toThrow();
    expect(() => voiceprintKey("short")).toThrow();
  });
});

describe("features only", () => {
  it("takes a print exactly as the Mac exports it", () => {
    expect(typeof parsePrint(print())).toBe("object");
    expect(typeof parsePrint(print({ self: null, created: undefined }))).toBe("object");
  });
  it("refuses any extra key, audio above all", () => {
    for (const extra of [
      { audio: true },
      { wav: "UklGRg==" },
      { audioUrl: "https://x" },
      { text: "hello" },
      { path: "~/.config/lianki-stt/voiceprints/iphone.audio/00.wav" },
    ])
      expect(parsePrint(print(extra))).toMatch(/^not features/);
  });
  it("refuses bad shapes", () => {
    expect(parsePrint(print({ dim: 3 }))).toBe("bad centroid");
    expect(parsePrint(print({ n: 11 }))).toBe("bad embeddings");
    expect(parsePrint(print({ n: 21 }))).toBe("bad n");
    expect(parsePrint(print({ device: "../x" }))).toBe("bad device");
    expect(parsePrint(print({ model: "x" }))).toBe("bad model");
    expect(parsePrint(print({ centroid: vec(192, 0).map(() => Number.NaN) }))).toBe("bad centroid");
    expect(parsePrint(print({ self: { min: 0.1, median: 0.2, extra: 1 } }))).toBe("bad self");
    const { embeddings: _, ...noEmb } = print();
    expect(parsePrint(noEmb)).toBe("missing embeddings");
  });
  it("a PUT body is exactly {ticket, prints}", () => {
    expect(parsePut({ ticket: "t", prints: [print()], audio: "x" })).toBe("bad body");
    expect(parsePut({ ticket: "t", prints: [] })).toBe("no prints");
    expect(parsePut({ ticket: "t", prints: [print(), print()] })).toBe("duplicate print");
    expect(typeof parsePut({ ticket: "t", prints: [print(), print({ device: "android" })] })).toBe(
      "object",
    );
  });
});

describe("the ticket", () => {
  it("must be a passkey ticket for this op, this account and device, live", async () => {
    const { k, ticket } = await setup();
    const want = { op: "export" as const, uid: "owner-1", devices: ["iphone"], now: NOW };
    expect("jti" in (await checkCloudTicket(await ticket(), k.pub, want))).toBe(true);
    expect(await checkCloudTicket(await ticket({ uid: "other" }), k.pub, want)).toEqual({
      error: "not your ticket",
    });
    expect(await checkCloudTicket(await ticket({ uid: undefined }), k.pub, want)).toEqual({
      error: "not your ticket",
    });
    expect(await checkCloudTicket(await ticket({ uv: false }), k.pub, want)).toEqual({
      error: "no passkey",
    });
    expect(await checkCloudTicket(await ticket({ op: "delete" }), k.pub, want)).toEqual({
      error: "wrong op",
    });
    expect(await checkCloudTicket(await ticket({ device: "android" }), k.pub, want)).toEqual({
      error: "wrong device",
    });
    expect(await checkCloudTicket(await ticket({ now: NOW - 120_000 }), k.pub, want)).toEqual({
      error: "expired",
    });
    const other = await keys();
    expect(await checkCloudTicket(await ticket(), other.pub, want)).toEqual({
      error: "bad ticket",
    });
  });
  it("the passkey approval mints export and restore tickets carrying the account", async () => {
    const k = await keys();
    const d: ApprovalDeps = {
      key: k.key,
      pub: k.pub,
      userId: "owner-1",
      now: NOW,
      rp: { rpID: "lianki.com", origins: ["https://lianki.com"] },
      passkeys: async () => [{ id: "pk", credentialID: "cred", publicKey: "AAAA", counter: 0 }],
      check: async () => ({ verified: true, userVerified: true, newCounter: 1 }),
      saveCounter: async () => {},
      consume: async () => true,
    };
    for (const op of ["export", "restore"] as const) {
      const o = await voiceprintApproval({ op, device: "*", step: "options" }, d);
      expect(o.status).toBe(200);
      const v = await voiceprintApproval(
        { op, device: "*", step: "verify", token: o.json.token, response: { id: "cred" } },
        d,
      );
      expect(v.status).toBe(200);
      const p = await openPayload(String(v.json.ticket), k.pub);
      expect(p).toMatchObject({ op, device: "*", uv: true, uid: "owner-1" });
    }
    // Status needs no passkey and carries no account: it can never write.
    const s = await voiceprintApproval({ op: "status" }, d);
    expect((await openPayload(String(s.json.ticket), k.pub))?.uv).toBe(false);
  });
});

describe("the account's own rows", () => {
  it("PUT, GET, DELETE: own rows only, each ticket once", async () => {
    const { db, deps, ticket } = await setup();
    const t = await ticket();
    const r = await putPrints(deps("owner-1"), { ticket: t, prints: [print()] });
    expect(r).toMatchObject({ status: 200, json: { ok: true, saved: 1 } });
    // The same approval again: refused.
    expect((await putPrints(deps("owner-1"), { ticket: t, prints: [print()] })).status).toBe(401);
    // Another account with the owner's ticket: refused, nothing written for it.
    const t2 = await ticket();
    expect((await putPrints(deps("intruder"), { ticket: t2, prints: [print()] })).json.error).toBe(
      "not your ticket",
    );
    expect((await listPrints(deps("intruder"), true)).json.prints).toEqual([]);
    // Stored sealed: no feature number in the row.
    const row = [...db.rows.values()][0]!;
    expect(Object.keys(row).sort()).toEqual(
      ["device", "dim", "model", "n", "payload", "uid", "updatedAt"].sort(),
    );
    const listed = (await listPrints(deps("owner-1"), false)).json.prints as Record<
      string,
      unknown
    >[];
    expect(listed).toEqual([
      { device: "iphone", model: "campp", dim: 192, n: 10, updatedAt: new Date(NOW).toISOString() },
    ]);
    const full = (await listPrints(deps("owner-1"), true)).json.prints as Record<string, unknown>[];
    expect(full[0]!.embeddings).toEqual(print().embeddings);
    // A row that no longer opens (AUTH_SECRET rotated) reads as unreadable, never as garbage.
    const rot = { ...deps("owner-1"), key: () => voiceprintKey("z".repeat(48)) };
    expect((await listPrints(rot, true)).json.prints).toEqual([{ ...listed[0], unreadable: true }]);
    // Delete: a one-device ticket cannot delete all; the intruder deletes nothing of his.
    const one = await ticket({ op: "delete", device: "android" });
    expect((await deletePrints(deps("owner-1"), { ticket: one, device: "*" })).status).toBe(401);
    const all = await ticket({ op: "delete", device: "*" });
    expect((await deletePrints(deps("intruder"), { ticket: all, device: "*" })).status).toBe(401);
    expect(db.rows.size).toBe(1);
    const all2 = await ticket({ op: "delete", device: "*" });
    expect(await deletePrints(deps("owner-1"), { ticket: all2, device: "*" })).toMatchObject({
      status: 200,
      json: { deleted: 1 },
    });
    expect(db.rows.size).toBe(0);
  });
  it("an enrol ticket (re-compute) stores only its own device's print", async () => {
    const { db, deps, ticket } = await setup();
    const other = await ticket({ op: "enrol", device: "iphone" });
    const r1 = await putPrints(deps("owner-1"), {
      ticket: other,
      prints: [print({ device: "android" })],
    });
    expect(r1.json.error).toBe("wrong device");
    const t = await ticket({ op: "enrol", device: "iphone" });
    expect((await putPrints(deps("owner-1"), { ticket: t, prints: [print()] })).status).toBe(200);
    expect(db.rows.size).toBe(1);
    // A status or restore ticket never writes.
    for (const op of ["restore", "delete"] as const)
      expect(
        (await putPrints(deps("owner-1"), { ticket: await ticket({ op }), prints: [print()] })).json
          .error,
      ).toBe("wrong op");
  });
  it("refuses a PUT with audio before spending the ticket", async () => {
    const { db, deps, ticket } = await setup();
    const r = await putPrints(deps("owner-1"), {
      ticket: await ticket(),
      prints: [print({ audio: true })],
    });
    expect(r.status).toBe(400);
    expect(db.spent.size).toBe(0);
    expect(db.rows.size).toBe(0);
  });
});

/** A 16 kHz mono 16-bit WAV of `s` seconds, as voiceprint.py writes them. */
function wav(s: number): ArrayBuffer {
  const n = 16_000 * s;
  const b = new ArrayBuffer(44 + n * 2);
  const v = new DataView(b);
  const str = (o: number, t: string) =>
    [...t].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16_000, true);
  v.setUint32(28, 32_000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(8000 * Math.sin(i / 10)), true);
  return b;
}
const tick = async (k = 6) => {
  for (let i = 0; i < k; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("recordings in My Files", () => {
  it("names are stable per device, day and sentence; wavs decode, anything else does not", () => {
    expect(
      recordingName({ device: "iphone", name: "07.wav", created: "2026-11-10T23:00:00+0900" }),
    ).toBe("voiceprint iphone 2026-11-10 07.wav");
    expect(recordingDevice("voiceprint iphone 2026-11-10 07.wav")).toBe("iphone");
    expect(recordingDevice("holiday.wav")).toBeNull();
    expect(wavSamples(wav(1))?.length).toBe(16_000);
    expect(wavSamples(new TextEncoder().encode("not a wav at all, really not").buffer)).toBeNull();
  });
});

// The panel helper, shared with the failure cases below.
let panelFor: (o?: {
  cloudRows?: number;
  local?: boolean;
  macRecs?: number;
  files?: string[];
  fail?: string;
}) => { c: ReturnType<typeof createEnrolment> } = () => {
  throw new Error("not yet");
};
describe("the panel", () => {
  function panel(
    o: {
      cloudRows?: number;
      local?: boolean;
      macRecs?: number;
      files?: string[];
      fail?: string;
    } = {},
  ) {
    const sent: Record<string, unknown>[] = [];
    const tickets: string[] = [];
    const puts: { ticket: string; prints: Record<string, unknown>[] }[] = [];
    const deletes: string[] = [];
    const files = new Map<string, string>((o.files ?? []).map((n, i) => [`f${i}`, n]));
    const uploads: string[] = [];
    const removed: string[] = [];
    const utters: { n: number; enrol: string }[] = [];
    let rows = o.cloudRows ?? 0;
    const cloud: PageCloud = {
      list: async () => {
        if (o.fail === "list") throw new Error("HTTP 500");
        return {
          prints: Array.from({ length: rows }, () => ({ device: "iphone", model: "campp", n: 10 })),
          recordings: files.size,
          extractor: "mac",
        };
      },
      recordings: {
        list: async () => [...files].map(([id, name]) => ({ id, name })),
        upload: async (name) => {
          uploads.push(name);
          files.set(`u${uploads.length}`, name);
        },
        download: async () => wav(3),
        delete: async (id) => {
          if (o.fail === "remove") throw new Error("r2 down");
          removed.push(id);
          files.delete(id);
        },
      },
      features: async () => [{ ...print(), updatedAt: "x" }],
      put: async (ticket, prints) => {
        if (o.fail === "put") throw new Error("approval already used");
        puts.push({ ticket, prints });
        rows = prints.length;
        return prints.length;
      },
      delete: async (ticket) => {
        if (o.fail === "cloud-delete") throw new Error("HTTP 503");
        deletes.push(ticket);
        rows = 0;
        return 1;
      },
    };
    const deps: EnrolDeps = {
      device: "iphone",
      async request(m) {
        sent.push(m);
        if (o.local === false) throw new Error("local stt not connected");
        if (m.op === "status")
          return { ok: true, prints: [{ device: "iphone", model: "campp", n: 10 }] };
        // A Mac that (wrongly) adds more than features: the page drops it before the PUT.
        if (m.op === "export")
          return {
            ok: true,
            prints: [{ ...print(), audio: true, extra: 1 }],
            ...(m.recordings
              ? {
                  recordings: Array.from({ length: o.macRecs ?? 0 }, (_, i) => ({
                    device: "iphone",
                    name: `${String(i).padStart(2, "0")}.wav`,
                    created: "2026-11-10T23:00:00+0900",
                    wav: Buffer.from(new Uint8Array(wav(1))).toString("base64"),
                  })),
                }
              : {}),
          };
        if (m.op === "start") return { ok: true, enrolment: "E9" };
        if (m.op === "commit") return { ok: true, n: 10, prints: m.export ? [print()] : undefined };
        if (m.op === "restore")
          return o.fail === "restore"
            ? { ok: false, error: "bad embeddings" }
            : { ok: true, restored: [{ device: "iphone" }] };
        if (m.op === "delete")
          return o.fail === "mac-delete"
            ? { ok: false, error: "ticket replayed" }
            : { ok: true, deleted: 2 };
        return { ok: true };
      },
      async ticket(op, device) {
        tickets.push(`${op}:${device}`);
        return `T-${op}-${tickets.length}`;
      },
      capture() {},
      async utter(_audio, enrol) {
        utters.push({ n: utters.length + 1, enrol });
        return {
          text: "",
          model: "m",
          ms: 1,
          endToFinalMs: 1,
          enrol: { ok: true, n: utters.length },
        };
      },
      cloud,
    };
    const views: EnrolView[] = [];
    const c = createEnrolment(deps, (v) => views.push(v));
    return { c, sent, tickets, puts, deletes, views, uploads, removed, utters, files };
  }
  panelFor = panel;

  it("save to my account: one passkey ticket, the Mac's features only, the same ticket to lianki.com", async () => {
    const h = panel();
    await h.c.open();
    expect(h.c.view()).toMatchObject({ step: "status", cloud: { prints: [] } });
    h.c.saveToAccount();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.tickets).toEqual(["status:*", "export:*"]);
    const exp = h.sent.find((m) => m.op === "export")!;
    expect(exp).toMatchObject({ t: "voiceprint", device: "*", ticket: "T-export-2" });
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.ticket).toBe("T-export-2");
    expect(Object.keys(h.puts[0]!.prints[0]!)).not.toContain("audio");
    expect(Object.keys(h.puts[0]!.prints[0]!)).not.toContain("extra");
    expect(h.c.view()).toMatchObject({ cloudOp: { kind: "save", state: "done", n: 1 } });
  });

  it("restore from my account: features from the account to the Mac with a restore ticket", async () => {
    const h = panel({ cloudRows: 1 });
    await h.c.open();
    h.c.restoreFromAccount();
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    const m = h.sent.find((x) => x.op === "restore")!;
    expect(m.ticket).toBe("T-restore-2");
    const p = (m.prints as Record<string, unknown>[])[0]!;
    expect(Object.keys(p)).not.toContain("updatedAt");
    expect(h.c.view()).toMatchObject({
      step: "status",
      cloudOp: { kind: "restore", state: "done" },
    });
  });

  it("delete: one confirming tap and one passkey delete on the Mac and in the account", async () => {
    const h = panel({ cloudRows: 1 });
    await h.c.open();
    h.c.askDelete();
    expect(h.c.view()).toMatchObject({ step: "confirm-delete", local: true });
    await h.c.confirmDelete();
    expect(h.tickets).toEqual(["status:*", "delete:*"]);
    expect(h.sent.find((m) => m.op === "delete")?.ticket).toBe("T-delete-2");
    expect(h.deletes).toEqual(["T-delete-2"]);
    expect(h.c.view()).toEqual({ step: "deleted", files: 2 });
  });

  it("the Mac away: the account copy still shows and can be deleted", async () => {
    const h = panel({ cloudRows: 1, local: false });
    await h.c.open();
    expect(h.c.view()).toMatchObject({ step: "status", local: false, cloud: { prints: [{}] } });
    h.c.saveToAccount(); // needs the Mac: nothing happens
    expect(h.tickets).toEqual(["status:*"]);
    h.c.askDelete();
    await h.c.confirmDelete();
    expect(h.sent.filter((m) => m.op === "delete")).toEqual([]);
    expect(h.deletes).toHaveLength(1);
  });

  it("featuresOnly keeps exactly the feature keys", () => {
    expect(Object.keys(featuresOnly({ ...print(), audio: 1, wav: "x" })).sort()).toEqual(
      Object.keys(print()).sort(),
    );
  });

  it("save also puts the Mac's kept recordings into My Files, each once; the Mac keeps them", async () => {
    const h = panel({ macRecs: 3, files: ["voiceprint iphone 2026-11-10 01.wav"] });
    await h.c.open();
    h.c.saveToAccount();
    await tick();
    expect(h.sent.find((m) => m.op === "export")?.recordings).toBe(true);
    expect(h.uploads).toEqual([
      "voiceprint iphone 2026-11-10 00.wav",
      "voiceprint iphone 2026-11-10 02.wav",
    ]);
    expect(h.c.view()).toMatchObject({ cloudOp: { kind: "save", state: "done", files: 2 } });
    // Nothing asked the Mac to delete anything.
    expect(h.sent.some((m) => m.op === "delete")).toBe(false);
  });

  it("re-compute: the recordings through the Mac extractor, one enrol ticket for the PUT", async () => {
    const files = Array.from(
      { length: 12 },
      (_, i) => `voiceprint iphone 2026-11-10 ${String(i).padStart(2, "0")}.wav`,
    );
    const h = panel({ cloudRows: 1, files });
    await h.c.open();
    h.c.recompute();
    await tick(40);
    expect(h.tickets).toEqual(["status:*", "enrol:iphone"]);
    expect(h.sent.find((m) => m.op === "start")).toMatchObject({
      device: "iphone",
      keepAudio: false,
      ticket: "T-enrol-2",
    });
    expect(h.utters).toHaveLength(12);
    expect(h.utters.every((u) => u.enrol === "E9")).toBe(true);
    expect(h.sent.find((m) => m.op === "commit")).toMatchObject({ enrolment: "E9", export: true });
    expect(h.puts.map((x) => x.ticket)).toEqual(["T-enrol-2"]);
    expect(h.c.view()).toMatchObject({ cloudOp: { kind: "recompute", state: "done", n: 1 } });
  });

  it("deleting the voiceprint offers to delete the recordings, and deletes them only on that tap", async () => {
    const h = panel({
      cloudRows: 1,
      files: ["voiceprint iphone 2026-11-10 00.wav", "voiceprint iphone 2026-11-10 01.wav"],
    });
    await h.c.open();
    h.c.askDelete();
    await h.c.confirmDelete();
    expect(h.removed).toEqual([]);
    expect(h.c.view()).toMatchObject({ step: "deleted", recordings: { n: 2, state: "offer" } });
    await h.c.deleteRecordings();
    expect(h.removed.sort()).toEqual(["f0", "f1"]);
    expect(h.c.view()).toMatchObject({ step: "deleted", recordings: { n: 2, state: "done" } });
  });
});

describe("the panel when something fails", () => {
  // The same helper, reached through a fresh describe: failures show, nothing else moves.
  const files2 = ["voiceprint iphone 2026-11-10 00.wav", "voiceprint iphone 2026-11-10 01.wav"];
  it("a refused save says why and keeps the button", async () => {
    const h = panelFor({ fail: "put" });
    await h.c.open();
    h.c.saveToAccount();
    await tick();
    expect(h.c.view()).toMatchObject({
      cloudOp: { kind: "save", state: "failed", error: "approval already used" },
    });
  });
  it("restore and re-compute with nothing there fail softly", async () => {
    const h = panelFor({ cloudRows: 1, files: ["holiday.wav"] });
    await h.c.open();
    h.c.recompute();
    await tick();
    expect(h.c.view()).toMatchObject({ cloudOp: { kind: "recompute", state: "failed" } });
  });
  it("the account delete failing still deletes on the Mac and says so", async () => {
    const h = panelFor({ cloudRows: 1, fail: "cloud-delete" });
    await h.c.open();
    h.c.askDelete();
    await h.c.confirmDelete();
    expect(h.c.view()).toMatchObject({ step: "deleted", files: 2, cloudError: "HTTP 503" });
  });
  it("the Mac refusing the delete is an error", async () => {
    const h = panelFor({ cloudRows: 1, fail: "mac-delete" });
    await h.c.open();
    h.c.askDelete();
    await h.c.confirmDelete();
    expect(h.c.view()).toMatchObject({ step: "error" });
  });
  it("the account unreachable: the panel shows the Mac's side only", async () => {
    const h = panelFor({ fail: "list" });
    await h.c.open();
    expect(h.c.view()).toMatchObject({ step: "status", local: true });
    expect((h.c.view() as { cloud?: unknown }).cloud).toBeUndefined();
    const away = panelFor({ fail: "list", local: false });
    await away.c.open();
    expect((away.c.view() as { cloud?: unknown }).cloud).toBeUndefined();
  });
  it("a restore the Mac refuses says why", async () => {
    const h = panelFor({ cloudRows: 1, fail: "restore" });
    await h.c.open();
    h.c.restoreFromAccount();
    await tick();
    expect(h.c.view()).toMatchObject({
      cloudOp: { kind: "restore", state: "failed", error: "bad embeddings" },
    });
  });
  it("too few usable recordings: the enrolment on the Mac is dropped, nothing stored", async () => {
    const h = panelFor({ cloudRows: 1, files: files2 });
    await h.c.open();
    h.c.recompute();
    await tick(20);
    expect(h.c.view()).toMatchObject({ cloudOp: { kind: "recompute", state: "failed" } });
  });
  it("skipping a sentence while reading moves on, nothing is sent to the account", async () => {
    const h = panelFor({ cloudRows: 1 });
    await h.c.open();
    h.c.enrol();
    await h.c.consent();
    expect(h.c.view()).toMatchObject({ step: "recording", index: 0 });
    h.c.skip();
    expect(h.c.view()).toMatchObject({ step: "recording", index: 1, kept: 0 });
  });
  it("deleting the recordings can fail and be tried again", async () => {
    const h = panelFor({ cloudRows: 1, files: files2, fail: "remove" });
    await h.c.open();
    h.c.askDelete();
    await h.c.confirmDelete();
    await h.c.deleteRecordings();
    expect(h.c.view()).toMatchObject({ recordings: { state: "failed", error: "r2 down" } });
  });
});

describe("the D1 store (migration 0071)", () => {
  it("puts, lists, replaces, deletes by account, and spends a jti once", async () => {
    const d1 = createTestD1(testSchema());
    const db = d1VoiceprintDb(d1 as never);
    const row = (device: string, n = 10) => ({
      device,
      model: "campp",
      dim: 192,
      n,
      updatedAt: "2026-11-11T00:00:00.000Z",
      payload: "v1.x.y",
    });
    await db.put("u1", [row("iphone"), row("android")]);
    await db.put("u2", [row("iphone")]);
    await db.put("u1", [row("iphone", 12)]); // replaces, no duplicate
    expect((await db.list("u1")).map((r) => `${r.device}:${r.n}`)).toEqual([
      "android:10",
      "iphone:12",
    ]);
    expect(await db.delete("u1", "android")).toBe(1);
    expect(await db.delete("u1", null)).toBe(1);
    expect(await db.list("u1")).toEqual([]);
    expect((await db.list("u2")).length).toBe(1);
    expect(await db.spend("jti-1", 1_800_000_060)).toBe(true);
    expect(await db.spend("jti-1", 1_800_000_060)).toBe(false);
  });
});

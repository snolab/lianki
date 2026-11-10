/**
 * The voiceprint in the account (lib/voiceprint-cloud.ts, app/api/my/voiceprint;
 * docs/local-stt.md, "Voiceprint in your account"): features only, encrypted at
 * rest, own rows only, writes only with a passkey ticket for this account, and
 * the panel's save / restore / delete (packages/debug-chat/src/voiceprint.ts).
 */
import { describe, expect, it } from "bun:test";
import { importTicketKey } from "@/lib/stt-ticket";
import { sealKey, unseal } from "@/lib/connections/crypto";
import { type ApprovalDeps, voiceprintApproval } from "@/lib/voiceprint-approval";
import {
  type CloudDeps,
  type VoiceprintDb,
  checkCloudTicket,
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

describe("the panel", () => {
  function panel(o: { cloudRows?: number; local?: boolean } = {}) {
    const sent: Record<string, unknown>[] = [];
    const tickets: string[] = [];
    const puts: { ticket: string; prints: Record<string, unknown>[] }[] = [];
    const deletes: string[] = [];
    let rows = o.cloudRows ?? 0;
    const cloud: PageCloud = {
      list: async () => ({
        prints: Array.from({ length: rows }, () => ({ device: "iphone", model: "campp", n: 10 })),
      }),
      features: async () => [{ ...print(), updatedAt: "x" }],
      put: async (ticket, prints) => {
        puts.push({ ticket, prints });
        rows = prints.length;
        return prints.length;
      },
      delete: async (ticket) => {
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
        if (m.op === "export") return { ok: true, prints: [{ ...print(), audio: true, extra: 1 }] };
        if (m.op === "restore") return { ok: true, restored: [{ device: "iphone" }] };
        if (m.op === "delete") return { ok: true, deleted: 2 };
        return { ok: true };
      },
      async ticket(op, device) {
        tickets.push(`${op}:${device}`);
        return `T-${op}-${tickets.length}`;
      },
      capture() {},
      cloud,
    };
    const views: EnrolView[] = [];
    const c = createEnrolment(deps, (v) => views.push(v));
    return { c, sent, tickets, puts, deletes, views };
  }

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
});

import { describe, expect, it } from "bun:test";
import {
  SitePermissionAuthority,
  type SitePermissionAuthorityStorage,
  type SitePermissionGrant,
  type SitePermissionReceipt,
  type SitePermissionState,
} from "../lib/site-permission-authority";
import type { SitePermissionAction, SiteReadAction } from "../lib/site-permission-wire";
const origin = "https://example.test";
const sub = "account_a";
const now = 1_000_000;
const receipt = (id: number, at = now): SitePermissionReceipt => ({
  jti: String(id).padStart(22, "0"),
  exp: Math.floor(at / 1000) + 60,
});
const set = (enabled: boolean, site = origin): SitePermissionAction => ({
  op: "set",
  origin: site,
  scope: "page.read",
  enabled,
});
const read = (revision = 1, site = origin): SiteReadAction => ({
  op: "consume",
  origin: site,
  scope: "page.read",
  revision,
  requestId: "selection_123",
  selection: {
    text: "Synthetic chosen passage",
    title: "Synthetic title",
    url: site + "/article?private=synthetic#fragment",
  },
});
class Memory implements SitePermissionAuthorityStorage {
  data = new Map<string, SitePermissionState>();
  writes = 0;
  failGet = false;
  failPut = false;
  beforePut?: () => Promise<void>;
  async get<T>(key: string): Promise<T | undefined> {
    if (this.failGet) throw Error("synthetic storage read failure");
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: SitePermissionState) {
    await this.beforePut?.();
    if (this.failPut) throw Error("synthetic storage write failure");
    this.data.set(key, structuredClone(value));
    this.writes++;
  }
}
const fixture = () => {
  const storage = new Memory();
  return { storage, authority: new SitePermissionAuthority(storage, { now: () => now }) };
};
const grant = (site: string, revision: number, enabled = true): SitePermissionGrant => ({
  origin: site,
  scope: "page.read",
  enabled,
  revision,
});
describe("serialized exact-site page.read authority", () => {
  it("defaults to deny, inspects missing grants without creating one and lists only the caller", async () => {
    const { storage, authority } = fixture();
    expect(await authority.execute(sub, read(), receipt(1))).toEqual({
      ok: false,
      error: "denied",
    });
    expect(await authority.execute(sub, { op: "inspect", origin }, receipt(2))).toEqual({
      ok: true,
      kind: "grant",
      grant: grant(origin, 0, false),
    });
    expect(await authority.execute(sub, { op: "list" }, receipt(3))).toEqual({
      ok: true,
      kind: "list",
      grants: [],
    });
    await authority.execute(sub, set(true), receipt(4));
    expect(await authority.execute("account_b", { op: "list" }, receipt(5))).toEqual({
      ok: true,
      kind: "list",
      grants: [],
    });
    expect(storage.data.get("siteperms:account_b")?.grants).toEqual([]);
    expect(await authority.execute("account_b", read(), receipt(6))).toEqual({
      ok: false,
      error: "denied",
    });
  });
  it("serializes grant then revoke then consume: revocation wins before old actions can succeed", async () => {
    const { storage, authority } = fixture();
    const results = await Promise.all([
      authority.execute(sub, set(true), receipt(1)),
      authority.execute(sub, set(false), receipt(2)),
      authority.execute(sub, read(1), receipt(3)),
    ]);
    expect(results).toEqual([
      { ok: true, kind: "grant", grant: grant(origin, 1) },
      { ok: true, kind: "grant", grant: grant(origin, 2, false) },
      { ok: false, error: "denied" },
    ]);
    expect(storage.data.get("siteperms:" + sub)?.revision).toBe(2);
    expect(storage.writes).toBe(3);
  });
  it("permits a consume ordered before revoke, never the same old revision after confirmed revoke", async () => {
    const { storage, authority } = fixture();
    await authority.execute(sub, set(true), receipt(1));
    const [selection, revoked] = await Promise.all([
      authority.execute(sub, read(1), receipt(2)),
      authority.execute(sub, set(false), receipt(3)),
    ]);
    expect(selection).toEqual({
      ok: true,
      kind: "selection",
      selection: { ...read().selection, url: origin + "/article" },
      revision: 1,
    });
    expect(revoked).toEqual({ ok: true, kind: "grant", grant: grant(origin, 2, false) });
    expect(await authority.execute(sub, read(1), receipt(4))).toEqual({
      ok: false,
      error: "denied",
    });
    expect(JSON.stringify([...storage.data.values()])).not.toContain("Synthetic chosen passage");
    expect(JSON.stringify([...storage.data.values()])).not.toContain("Synthetic title");
  });
  it("every set advances the account revision, preserving other sites and disabled records", async () => {
    const { authority } = fixture();
    await authority.execute(sub, set(false), receipt(1));
    expect(await authority.execute(sub, set(false), receipt(2))).toEqual({
      ok: true,
      kind: "grant",
      grant: grant(origin, 2, false),
    });
    const other = "https://other.test";
    expect(await authority.execute(sub, set(true, other), receipt(3))).toEqual({
      ok: true,
      kind: "grant",
      grant: grant(other, 3),
    });
    expect(await authority.execute(sub, { op: "inspect", origin }, receipt(4))).toEqual({
      ok: true,
      kind: "grant",
      grant: grant(origin, 2, false),
    });
    expect(await authority.execute(sub, read(3, other), receipt(5))).toMatchObject({
      ok: true,
      kind: "selection",
      revision: 3,
    });
  });
  it("rejects wrong site, revision, account and unknown scopes without widening a grant", async () => {
    const { authority } = fixture();
    await authority.execute(sub, set(true), receipt(1));
    for (const [index, action] of [
      read(0),
      read(2),
      read(1, "https://sub.example.test"),
      read(1, "https://example.test.evil.test"),
    ].entries())
      expect(await authority.execute(sub, action, receipt(index + 2))).toEqual({
        ok: false,
        error: "denied",
      });
    expect(await authority.execute("account_b", read(), receipt(6))).toEqual({
      ok: false,
      error: "denied",
    });
    expect(
      await authority.execute(sub, { ...read(), scope: "page.execute" } as never, receipt(7)),
    ).toEqual({ ok: false, error: "invalid" });
    expect(
      await authority.execute(sub, { ...set(true), token: "synthetic" } as never, receipt(8)),
    ).toEqual({ ok: false, error: "invalid" });
    for (const who of ["", "../account_a", "a".repeat(65), "account a"])
      expect(await authority.execute(who, { op: "list" }, receipt(9))).toEqual({
        ok: false,
        error: "invalid",
      });
  });
  it("consumes receipts for every operation including list, inspect and denied actions", async () => {
    const { authority } = fixture();
    for (const [index, action] of [
      { op: "list" },
      { op: "inspect", origin },
      set(true),
      read(999),
    ].entries()) {
      const proof = receipt(index + 1);
      await authority.execute(sub, action as SitePermissionAction, proof);
      expect(await authority.execute(sub, { op: "list" }, proof)).toEqual({
        ok: false,
        error: "replay",
      });
    }
    await authority.execute(sub, set(false), receipt(5));
    const denied = receipt(6);
    expect(await authority.execute(sub, read(3), denied)).toEqual({ ok: false, error: "denied" });
    await authority.execute(sub, set(true), receipt(7));
    expect(await authority.execute(sub, read(3), denied)).toEqual({ ok: false, error: "replay" });
  });
  it("accepts only unexpired exact22 receipt ids and at most sixty seconds of remaining validity", async () => {
    const { authority, storage } = fixture();
    for (const proof of [
      { ...receipt(1), jti: "short" },
      { ...receipt(1), jti: "!".repeat(22) },
      { ...receipt(1), exp: now / 1000 },
      { ...receipt(1), exp: now / 1000 - 1 },
      { ...receipt(1), exp: now / 1000 + 61 },
      { ...receipt(1), exp: Infinity },
      { ...receipt(1), exp: now / 1000 + 0.5 },
    ])
      expect(await authority.execute(sub, { op: "list" }, proof)).toEqual({
        ok: false,
        error: "invalid",
      });
    expect(storage.writes).toBe(0);
    expect(await authority.execute(sub, { op: "list" }, receipt(2))).toMatchObject({ ok: true });
    const invalidClock = new SitePermissionAuthority(storage, { now: () => NaN });
    expect(await invalidClock.execute(sub, { op: "list" }, receipt(3))).toEqual({
      ok: false,
      error: "invalid",
    });
  });
  it("does not answer success before persistence and rechecks expiry after queueing", async () => {
    const storage = new Memory();
    let time = now;
    let release!: () => void;
    storage.beforePut = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const authority = new SitePermissionAuthority(storage, { now: () => time });
    let settled = false;
    const first = authority.execute(sub, set(true), receipt(1)).then((result) => {
      settled = true;
      return result;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(storage.writes).toBe(0);
    const queued = authority.execute(sub, read(), { ...receipt(2), exp: now / 1000 + 1 });
    time += 2000;
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await queued).toEqual({ ok: false, error: "invalid" });
  });
  it("fails closed on reads/writes and keeps the queue usable without mutating stored grants", async () => {
    const { authority, storage } = fixture();
    storage.failGet = true;
    expect(await authority.execute(sub, set(true), receipt(1))).toEqual({
      ok: false,
      error: "unavailable",
    });
    storage.failGet = false;
    storage.failPut = true;
    expect(await authority.execute(sub, set(true), receipt(1))).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(storage.data.size).toBe(0);
    storage.failPut = false;
    await authority.execute(sub, set(true), receipt(1));
    storage.failPut = true;
    expect(await authority.execute(sub, set(false), receipt(2))).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(storage.data.get("siteperms:" + sub)?.grants[0]).toEqual(grant(origin, 1));
    storage.failPut = false;
    expect(await authority.execute(sub, read(), receipt(2))).toMatchObject({
      ok: true,
      kind: "selection",
    });
  });
  it("bounds retained grant records including disabled sites and still permits existing revocation", async () => {
    const { authority, storage } = fixture();
    const grants = Array.from({ length: 128 }, (_, i) =>
      grant(`https://site-${i}.test`, i + 1, i === 0),
    );
    storage.data.set("siteperms:" + sub, { revision: 128, grants, used: [] });
    const proof = receipt(1);
    expect(await authority.execute(sub, set(true), proof)).toEqual({ ok: false, error: "busy" });
    expect(await authority.execute(sub, { op: "list" }, proof)).toEqual({
      ok: false,
      error: "replay",
    });
    expect(await authority.execute(sub, set(false, "https://site-0.test"), receipt(2))).toEqual({
      ok: true,
      kind: "grant",
      grant: grant("https://site-0.test", 129, false),
    });
    expect(storage.data.get("siteperms:" + sub)?.grants).toHaveLength(128);
    expect(storage.data.get("siteperms:" + sub)?.grants[1]).toEqual(grants[1]);
  });
  it("never evicts live receipts at capacity, but prunes expired receipts on the next persisted operation", async () => {
    const { authority, storage } = fixture();
    const used = Array.from({ length: 1024 }, (_, i) => receipt(i));
    storage.data.set("siteperms:" + sub, { revision: 0, grants: [], used });
    expect(await authority.execute(sub, { op: "list" }, receipt(2000))).toEqual({
      ok: false,
      error: "busy",
    });
    expect(storage.writes).toBe(0);
    expect(storage.data.get("siteperms:" + sub)?.used).toEqual(used);
    storage.data.set("siteperms:" + sub, {
      revision: 0,
      grants: [],
      used: used.map((item) => ({ ...item, exp: now / 1000 })),
    });
    expect(await authority.execute(sub, { op: "list" }, receipt(2000))).toEqual({
      ok: true,
      kind: "list",
      grants: [],
    });
    expect(storage.data.get("siteperms:" + sub)?.used).toEqual([receipt(2000)]);
  });
  it("does not alias returned grants or caller-owned queued selections into persistent state", async () => {
    const { authority, storage } = fixture();
    const result = await authority.execute(sub, set(true), receipt(1));
    if (result.ok && result.kind === "grant") result.grant.enabled = false;
    const listed = await authority.execute(sub, { op: "list" }, receipt(2));
    if (listed.ok && listed.kind === "list") listed.grants[0].enabled = false;
    expect(storage.data.get("siteperms:" + sub)?.grants[0].enabled).toBe(true);
    const action = read();
    const pending = authority.execute(sub, action, receipt(3));
    action.selection.text = "changed after enqueue";
    expect(await pending).toMatchObject({
      ok: true,
      kind: "selection",
      selection: { text: "Synthetic chosen passage" },
    });
  });
  it("rejects corrupt persisted state rather than resetting it or reviving permission", async () => {
    const { authority, storage } = fixture();
    const invalid = [
      null,
      { revision: -1, grants: [], used: [] },
      { revision: 0, grants: {}, used: [] },
      { revision: 1, grants: [grant(origin, 1), grant(origin, 1)], used: [] },
      { revision: 1, grants: [grant(origin, 2)], used: [] },
      { revision: 1, grants: [{ ...grant(origin, 1), scope: "page.execute" }], used: [] },
      { revision: 1, grants: [grant(origin + "/", 1)], used: [] },
      { revision: 0, grants: [], used: [receipt(1), receipt(1)] },
      { revision: 0, grants: [], used: [{ jti: "short", exp: now / 1000 + 10 }] },
    ];
    for (const value of invalid) {
      storage.data.set("siteperms:" + sub, value as never);
      expect(await authority.execute(sub, { op: "list" }, receipt(2))).toEqual({
        ok: false,
        error: "unavailable",
      });
    }
    expect(storage.writes).toBe(0);
    storage.data.set("siteperms:" + sub, {
      revision: Number.MAX_SAFE_INTEGER,
      grants: [],
      used: [],
    });
    expect(await authority.execute(sub, set(true), receipt(3))).toEqual({
      ok: false,
      error: "busy",
    });
  });
});

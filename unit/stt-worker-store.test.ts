/**
 * Who may use Lianki's speech servers, and which speech servers may register
 * (lib/stt-worker/store.ts, db/migrations/0073_stt_worker.sql): default deny,
 * every change audited with ids only, a revoked worker refused at once, and the
 * admin page/API's 404 for anyone else.
 */
import { describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  addSttWorker,
  allowSttUser,
  disallowSttUser,
  listSttAccess,
  listSttWorkers,
  revokeSttWorker,
  searchUsers,
  sttAllowed,
  sttWorkerByKey,
  type SttDb,
} from "@/lib/stt-worker/store";
import { DEV_PAGE_PERMISSION } from "@/lib/dev-page-permissions";

const KEY = "A".repeat(43);
const KEY2 = "B".repeat(43);

async function db() {
  const d1 = createTestD1(testSchema());
  await (d1 as unknown as { exec(q: string): Promise<unknown> }).exec(`
    INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('u1', 'Ann', 'ann@x.com', 1, '2026', '2026'),
             ('u2', NULL, 'bob@x.com', 1, '2026', '2026');
  `);
  return d1 as unknown as SttDb;
}

async function auditKinds(d: SttDb) {
  const { results } = await d
    .prepare(
      "SELECT kind, actor, subject, detail FROM security_audit WHERE kind LIKE 'stt-%' ORDER BY id",
    )
    .bind()
    .all<{ kind: string; actor: string; subject: string; detail: string | null }>();
  return results;
}

describe("the allowlist", () => {
  test("default deny; add by email (any case) or id; remove; each change audited once", async () => {
    const d = await db();
    expect(await sttAllowed(d, "u1")).toBe(false);
    expect(await sttAllowed(d, "")).toBe(false);
    expect(await allowSttUser(d, "ANN@x.com", "admin", 1000)).toBe("u1");
    expect(await allowSttUser(d, "u1", "admin", 2000)).toBe("u1"); // again: no second row, no audit
    expect(await allowSttUser(d, "nobody@x.com", "admin")).toBeNull();
    expect(await sttAllowed(d, "u1")).toBe(true);
    expect(await sttAllowed(d, "u2")).toBe(false);
    expect(await listSttAccess(d)).toEqual([
      { userId: "u1", name: "Ann", addedBy: "admin", addedAt: 1000 },
    ]);
    expect(JSON.stringify(await listSttAccess(d))).not.toContain("@");
    expect(await disallowSttUser(d, "u1", "admin")).toBe(true);
    expect(await disallowSttUser(d, "u1", "admin")).toBe(false);
    expect(await sttAllowed(d, "u1")).toBe(false);
    const audit = await auditKinds(d);
    expect(audit.map((a) => [a.kind, a.subject])).toEqual([
      ["stt-access.allow", "u1"],
      ["stt-access.disallow", "u1"],
    ]);
    expect(JSON.stringify(audit)).not.toContain("ann@x.com");
  });

  test("a failed read is no", async () => {
    const broken = {
      prepare() {
        throw new Error("no table");
      },
    } as unknown as SttDb;
    expect(await sttAllowed(broken, "u1")).toBe(false);
    expect(await sttWorkerByKey(broken, KEY)).toBeNull();
  });
});

describe("speech servers", () => {
  test("added with a valid id and key only, once; found by key while live; revoked at once", async () => {
    const d = await db();
    expect(await addSttWorker(d, { id: "Bad Id", pubkey: KEY, name: "x" }, "cli")).toBe(false);
    expect(await addSttWorker(d, { id: "mac", pubkey: "short", name: "x" }, "cli")).toBe(false);
    expect(await addSttWorker(d, { id: "mac", pubkey: KEY, name: "x", capacity: -1 }, "cli")).toBe(
      false,
    );
    expect(await addSttWorker(d, { id: "mac", pubkey: KEY, name: "The Mac" }, "cli", 5)).toBe(true);
    expect(await addSttWorker(d, { id: "mac", pubkey: KEY2, name: "dup id" }, "cli")).toBe(false);
    expect(await addSttWorker(d, { id: "mac2", pubkey: KEY, name: "dup key" }, "cli")).toBe(false);
    expect(await sttWorkerByKey(d, KEY)).toMatchObject({
      id: "mac",
      ownerUserId: null,
      capacity: null,
    });
    expect(await sttWorkerByKey(d, KEY2)).toBeNull();
    expect(await sttWorkerByKey(d, "not a key")).toBeNull();
    expect(await revokeSttWorker(d, "mac", "admin", 9)).toBe(true);
    expect(await revokeSttWorker(d, "mac", "admin")).toBe(false);
    expect(await sttWorkerByKey(d, KEY)).toBeNull();
    expect((await listSttWorkers(d))[0]).toMatchObject({ id: "mac", revokedAt: 9 });
    const audit = await auditKinds(d);
    expect(audit.map((a) => [a.kind, a.subject])).toEqual([
      ["stt-worker.add", "mac"],
      ["stt-worker.revoke", "mac"],
    ]);
    expect(JSON.stringify(audit)).not.toContain(KEY);
  });

  test("a personal worker keeps its account (per-account registry)", async () => {
    const d = await db();
    await addSttWorker(
      d,
      { id: "ann-mac", pubkey: KEY, name: "Ann's Mac", ownerUserId: "u1", capacity: 1 },
      "cli",
    );
    expect(await sttWorkerByKey(d, KEY)).toMatchObject({ ownerUserId: "u1", capacity: 1 });
  });
});

describe("the admin page", () => {
  test("is an admin page", () => {
    expect(DEV_PAGE_PERMISSION["stt-access"]).toBe("admin");
  });
});

describe("searchUsers: the admin's picker", () => {
  test("by part of a name or email, case-insensitive; too short or wildcards find nothing extra", async () => {
    const d = await db();
    expect((await searchUsers(d, "ann")).map((u) => u.id)).toEqual(["u1"]);
    expect((await searchUsers(d, "BOB@")).map((u) => u.email)).toEqual(["bob@x.com"]);
    expect((await searchUsers(d, "x.com")).length).toBe(2);
    expect(await searchUsers(d, "a")).toEqual([]);
    expect(await searchUsers(d, "%%")).toEqual([]);
    expect(await searchUsers(d, "__")).toEqual([]);
  });
  test("an id from the search adds the account, as an email does", async () => {
    const d = await db();
    const [u] = await searchUsers(d, "bob");
    expect(await allowSttUser(d, u!.id, "u1")).toBeTruthy();
    expect(await sttAllowed(d, "u2")).toBe(true);
  });
});

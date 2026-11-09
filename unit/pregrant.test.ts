import { describe, expect, spyOn, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  PREGRANT,
  applyPregrants,
  checkInput,
  claimPregrants,
  listPending,
  parsePregrantList,
  pregrantHash,
  previewPregrants,
  revokePregrant,
  validEmail,
  type PregrantDb,
} from "@/lib/referrals/pregrant";

/**
 * Pre-grants: Pro days given to an address before it has an account. What
 * matters: only a VERIFIED address claims, each grant applies once, and an
 * expired or revoked one never does. Fake addresses only.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-09T09:00:00Z");
const ADMIN = { id: "admin-1" };
const KEY = "key-0001-abcd";

function setup() {
  const d1 = createTestD1(testSchema());
  const db = d1 as unknown as PregrantDb;
  const addUser = (
    id: string,
    email: string,
    o: { verified?: boolean; proEndsAt?: string | null; createdAt?: string } = {},
  ) =>
    d1
      .raw()
      .prepare(
        "INSERT INTO user (id, email, emailVerified, createdAt, updatedAt, proEndsAt, email_canonical) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(
        id,
        email,
        o.verified === false ? 0 : 1,
        o.createdAt ?? NOW.toISOString(),
        NOW.toISOString(),
        o.proEndsAt ?? null,
      );
  const setCanonical = (id: string, c: string) =>
    d1.raw().prepare("UPDATE user SET email_canonical = ? WHERE id = ?").run(c, id);
  const user = (id: string) =>
    d1.raw().prepare("SELECT proEndsAt, emailVerified FROM user WHERE id = ?").get(id) as {
      proEndsAt: string | null;
    };
  const all = (sql: string, ...a: string[]) =>
    d1
      .raw()
      .prepare(sql)
      .all(...a)
      .map((r) => ({ ...r })) as Record<string, unknown>[];
  return { d1, db, addUser, setCanonical, user, all };
}

const apply = (db: PregrantDb, text: string, o: Record<string, unknown> = {}, now = NOW) =>
  applyPregrants(db, ADMIN, { text, days: 30, key: KEY, ...o }, now);

describe("parsing", () => {
  test("valid addresses only, trimmed and lowercased", () => {
    expect(validEmail("  Friend@Example.ORG ")).toBe("friend@example.org");
    for (const bad of ["", "no-at", "a@b", "a b@c.de", "a@@c.de", "<a@c.de>", "a@c.d"])
      expect(validEmail(bad)).toBeNull();
    expect(validEmail(`${"a".repeat(250)}@x.com`)).toBeNull();
  });

  test("lines, CSV, defaults, header and comments", () => {
    const rows = parsePregrantList(
      [
        "email,days,note",
        "# a comment",
        "",
        "one@example.org",
        "two@example.org,90",
        "three@example.org,7,teacher, Osaka",
        "four@example.org\t14",
        "bad",
        "five@example.org,0",
        "six@example.org,abc",
        "seven@example.org,,",
      ].join("\n"),
      { days: 30, note: " default " },
    );
    expect(rows.map((r) => [r.line, r.email, r.days, r.note, r.error ?? null])).toEqual([
      [4, "one@example.org", 30, "default", null],
      [5, "two@example.org", 90, "default", null],
      [6, "three@example.org", 7, "teacher, Osaka", null],
      [7, "four@example.org", 14, "default", null],
      [8, null, 30, "default", "email"],
      [9, "five@example.org", null, "default", "days"],
      [10, "six@example.org", null, "default", "days"],
      [11, "seven@example.org", 30, "default", null],
    ]);
  });

  test("no default note, and a long note is cut", () => {
    const [r] = parsePregrantList(`a@example.org,5,${"n".repeat(300)}`, { days: 1 });
    expect(r.note?.length).toBe(PREGRANT.maxNote);
    expect(parsePregrantList("b@example.org", { days: 1 })[0].note).toBeNull();
  });

  test("checkInput", () => {
    expect(checkInput({ days: 30, text: "a" }, NOW)).toBeNull();
    expect(checkInput({ days: 0 }, NOW)).toBe("days");
    expect(checkInput({ days: 1.5 }, NOW)).toBe("days");
    expect(checkInput({ days: PREGRANT.maxDays + 1 }, NOW)).toBe("days");
    expect(checkInput({ days: 3, grantExpiresAt: "nope" }, NOW)).toBe("expiry");
    expect(checkInput({ days: 3, grantExpiresAt: "2026-01-01T00:00:00Z" }, NOW)).toBe("expiry");
    expect(checkInput({ days: 3, grantExpiresAt: "2027-01-01T00:00:00Z", key: KEY }, NOW)).toBe(
      null,
    );
    expect(checkInput({ days: 3, key: "" }, NOW)).toBe("key");
    expect(checkInput({ days: 3, key: "bad key!" }, NOW)).toBe("key");
    expect(checkInput({ days: 3, text: "a\n".repeat(PREGRANT.maxLines) }, NOW)).toBe("too many");
  });

  test("the hash is of the canonical address, and differs from the address", async () => {
    expect(await pregrantHash("F.r.i.e.n.d+x@gmail.com")).toBe(
      await pregrantHash("friend@googlemail.com"),
    );
    expect(await pregrantHash("a@example.org")).not.toContain("a@example.org");
  });
});

describe("preview", () => {
  test("invalid, duplicate (canonical), pending, account, ok", async () => {
    const { db, addUser, setCanonical } = setup();
    addUser("u1", "Has.Account@gmail.com");
    setCanonical("u1", "hasaccount@gmail.com");
    addUser("u2", "plain@example.org"); // email_canonical not filled yet
    await apply(db, "waiting@example.org");
    const rows = await previewPregrants(
      db,
      [
        "new@example.org",
        "nope",
        "N.e.w@example.org", // a different address on a non-gmail domain
        "new@example.org,5",
        "hasaccount+x@gmail.com",
        "PLAIN@example.org",
        "waiting@example.org",
      ].join("\n"),
      { days: 30 },
    );
    expect(rows.map((r) => [r.email, r.status, r.account?.id ?? null])).toEqual([
      ["new@example.org", "ok", null],
      [null, "invalid", null],
      ["n.e.w@example.org", "ok", null],
      ["new@example.org", "duplicate", null],
      ["hasaccount+x@gmail.com", "account", "u1"],
      ["plain@example.org", "account", "u2"],
      ["waiting@example.org", "pending", null],
    ]);
  });

  test("an account match prefers the exact address over an older alias", async () => {
    const { db, addUser, setCanonical } = setup();
    addUser("old", "a.b@gmail.com", { createdAt: "2026-01-01T00:00:00Z" });
    addUser("new", "ab@gmail.com", { createdAt: "2026-02-01T00:00:00Z" });
    setCanonical("old", "ab@gmail.com");
    setCanonical("new", "ab@gmail.com");
    const [exact] = await previewPregrants(db, "ab@gmail.com", { days: 1 });
    expect(exact.account?.id).toBe("new");
    const [alias] = await previewPregrants(db, "a.b.@gmail.com", { days: 1 });
    expect(alias.account?.id).toBe("old");
  });
});

describe("apply", () => {
  test("creates pending rows, skips the rest, audits with a masked address", async () => {
    const { db, all, addUser } = setup();
    addUser("u1", "taken@example.org");
    const r = await apply(db, "a@example.org,10,friend\nb@example.org\nbad\ntaken@example.org", {
      grantExpiresAt: "2026-12-31T23:59:59+09:00",
    });
    expect([r.created, r.granted, r.skipped]).toEqual([2, 0, 2]);
    expect(r.rows.map((x) => x.result)).toEqual(["created", "created", "skipped", "skipped"]);
    const pending = await listPending(db);
    expect(pending.map((p) => [p.email, p.days, p.note, p.grantExpiresAt])).toEqual(
      expect.arrayContaining([
        ["a@example.org", 10, "friend", "2026-12-31T14:59:59.000Z"],
        ["b@example.org", 30, null, "2026-12-31T14:59:59.000Z"],
      ]),
    );
    const rows = all("SELECT email_hash, granted_by FROM pending_membership");
    expect(rows.every((x) => x.granted_by === "admin-1")).toBe(true);
    expect(rows.some((x) => x.email_hash === "a@example.org")).toBe(false);
    const audits = all(
      "SELECT kind, actor, detail FROM security_audit WHERE kind LIKE 'pregrant.%' ORDER BY id",
    );
    expect(audits).toEqual([
      { kind: "pregrant.create", actor: "admin-1", detail: "a***@example.org 10d" },
      { kind: "pregrant.create", actor: "admin-1", detail: "b***@example.org 30d" },
    ]);
  });

  test("applying the same list twice makes one open row per person", async () => {
    const { db, all } = setup();
    await apply(db, "a@example.org");
    const again = await apply(db, "a@example.org");
    expect(again.rows[0].status).toBe("pending");
    expect(again.created).toBe(0);
    expect(all("SELECT id FROM pending_membership")).toHaveLength(1);
  });

  test("the open-row index stops a racing second insert", async () => {
    const { db, d1 } = setup();
    await apply(db, "a@example.org");
    // Simulate the race: the preview saw nothing pending, but the row exists.
    const orig = d1.prepare.bind(d1);
    const spy = spyOn(d1, "prepare").mockImplementation((q: string) =>
      q.startsWith("SELECT id FROM pending_membership") ? orig("SELECT ? AS id WHERE 0") : orig(q),
    );
    const r = await apply(db, "a@example.org");
    spy.mockRestore();
    expect(r.rows[0].status).toBe("ok");
    expect([r.created, r.skipped]).toEqual([0, 1]);
  });

  test("a non-unique insert error is thrown", async () => {
    const { db, d1 } = setup();
    d1.raw().exec("DROP TABLE pending_membership");
    await expect(apply(db, "a@example.org")).rejects.toThrow();
  });

  test("direct grant to an existing account: once per key, through membership_grant", async () => {
    const { db, addUser, user, all } = setup();
    addUser("u1", "taken@example.org", { proEndsAt: "2026-12-01T00:00:00.000Z" });
    addUser("u2", "other@example.org");
    const text = "taken@example.org,20\nother@example.org";
    const r = await apply(db, text, { direct: [" Taken@example.org "] });
    expect([r.created, r.granted, r.skipped]).toEqual([0, 1, 1]);
    expect(user("u1").proEndsAt).toBe("2026-12-21T00:00:00.000Z");
    expect(user("u2").proEndsAt).toBeNull();
    // A retried request with the same key grants nothing more.
    const retry = await apply(db, text, { direct: ["taken@example.org"] });
    expect(retry.granted).toBe(0);
    expect(user("u1").proEndsAt).toBe("2026-12-21T00:00:00.000Z");
    expect(all("SELECT reason, refId, days FROM membership_grant")).toEqual([
      { reason: "pregrant-direct", refId: `pregrant-direct:${KEY}:u1`, days: 20 },
    ]);
    expect(all("SELECT kind, subject FROM security_audit WHERE kind LIKE 'pregrant.%'")).toEqual([
      { kind: "pregrant.direct", subject: "u1" },
    ]);
  });
});

describe("revoke", () => {
  test("revokes an open row once; never a claimed one", async () => {
    const { db, addUser, all } = setup();
    await apply(db, "a@example.org\nb@example.org");
    const [a, b] = (await listPending(db)).sort((x, y) => x.email.localeCompare(y.email));
    expect(await revokePregrant(db, ADMIN, a.id, NOW)).toBe(true);
    expect(await revokePregrant(db, ADMIN, a.id, NOW)).toBe(false);
    expect(await revokePregrant(db, ADMIN, "missing", NOW)).toBe(false);
    addUser("ub", "b@example.org");
    await claimPregrants(db, "ub", NOW);
    expect(await revokePregrant(db, ADMIN, b.id, NOW)).toBe(false);
    expect(await listPending(db)).toEqual([]);
    expect(all("SELECT kind FROM security_audit WHERE kind = 'pregrant.revoke'")).toHaveLength(1);
  });

  test("a revoked address can be pre-granted again", async () => {
    const { db } = setup();
    await apply(db, "a@example.org");
    await revokePregrant(db, ADMIN, (await listPending(db))[0].id, NOW);
    expect((await apply(db, "a@example.org")).created).toBe(1);
  });
});

describe("claim on sign-in", () => {
  test("a verified address claims: Pro extended, row stamped, audited", async () => {
    const { db, addUser, user, all } = setup();
    await apply(db, "friend@gmail.com,45");
    addUser("u1", "Fr.iend+lianki@gmail.com");
    expect(await claimPregrants(db, "u1", NOW)).toBe(45);
    expect(user("u1").proEndsAt).toBe(new Date(NOW.getTime() + 45 * DAY).toISOString());
    const [row] = all("SELECT claimed_at, claimed_user_id FROM pending_membership");
    expect(row).toEqual({ claimed_at: NOW.toISOString(), claimed_user_id: "u1" });
    const [grant] = all("SELECT reason, refId, kind, days, userId FROM membership_grant");
    expect(grant.reason).toBe("pregrant");
    expect(String(grant.refId)).toMatch(/^pregrant:[0-9a-f-]{36}$/);
    expect([grant.kind, grant.days, grant.userId]).toEqual(["pro", 45, "u1"]);
    expect(
      all("SELECT kind, actor, detail FROM security_audit WHERE kind = 'pregrant.claim'"),
    ).toEqual([{ kind: "pregrant.claim", actor: "u1", detail: "45d" }]);
    expect(await listPending(db)).toEqual([]);
  });

  test("stacks on Pro that is still running", async () => {
    const { db, addUser, user } = setup();
    await apply(db, "a@example.org,10");
    addUser("u1", "a@example.org", { proEndsAt: "2027-01-01T00:00:00.000Z" });
    await claimPregrants(db, "u1", NOW);
    expect(user("u1").proEndsAt).toBe("2027-01-11T00:00:00.000Z");
  });

  test("an unverified address never claims; it does once verified", async () => {
    const { db, d1, addUser, user } = setup();
    await apply(db, "a@example.org");
    addUser("u1", "a@example.org", { verified: false });
    expect(await claimPregrants(db, "u1", NOW)).toBe(0);
    expect(user("u1").proEndsAt).toBeNull();
    expect(await listPending(db)).toHaveLength(1);
    d1.raw().prepare("UPDATE user SET emailVerified = 1 WHERE id = 'u1'").run();
    expect(await claimPregrants(db, "u1", NOW)).toBe(30);
  });

  test("idempotent: a second sign-in, or another alias account, gets nothing", async () => {
    const { db, addUser, user, all } = setup();
    await apply(db, "ab@gmail.com");
    addUser("u1", "ab@gmail.com");
    addUser("u2", "a.b@gmail.com");
    expect(await claimPregrants(db, "u1", NOW)).toBe(30);
    expect(await claimPregrants(db, "u1", NOW)).toBe(0);
    expect(await claimPregrants(db, "u2", NOW)).toBe(0);
    expect(user("u2").proEndsAt).toBeNull();
    expect(all("SELECT id FROM membership_grant")).toHaveLength(1);
  });

  test("an already-granted refId (a race) does not grant twice", async () => {
    const { db, d1, addUser, user } = setup();
    await apply(db, "a@example.org");
    addUser("u1", "a@example.org");
    const [p] = await listPending(db);
    d1.raw()
      .prepare(
        "INSERT INTO membership_grant (id, userId, kind, days, reason, refId, createdAt) VALUES ('g', 'u1', 'pro', 30, 'pregrant', ?, 'x')",
      )
      .run(`pregrant:${p.id}`);
    expect(await claimPregrants(db, "u1", NOW)).toBe(0);
    expect(user("u1").proEndsAt).toBeNull();
  });

  test("expired and revoked grants never apply", async () => {
    const { db, addUser, user, all } = setup();
    await apply(db, "late@example.org", {
      grantExpiresAt: new Date(NOW.getTime() + DAY).toISOString(),
    });
    await apply(db, "gone@example.org");
    const gone = (await listPending(db)).find((p) => p.email === "gone@example.org")!;
    await revokePregrant(db, ADMIN, gone.id, NOW);
    addUser("late", "late@example.org");
    addUser("gone", "gone@example.org");
    const later = new Date(NOW.getTime() + 2 * DAY);
    expect(await claimPregrants(db, "late", later)).toBe(0);
    expect(await claimPregrants(db, "gone", later)).toBe(0);
    expect(user("late").proEndsAt).toBeNull();
    expect(user("gone").proEndsAt).toBeNull();
    expect(all("SELECT id FROM membership_grant")).toEqual([]);
    // The lapsed one still shows (to be revoked); the revoked one does not.
    expect((await listPending(db)).map((p) => p.email)).toEqual(["late@example.org"]);
  });

  test("a row revoked between the read and the take is not granted", async () => {
    const { db, d1, addUser, user } = setup();
    await apply(db, "a@example.org");
    addUser("u1", "a@example.org");
    const orig = d1.prepare.bind(d1);
    const spy = spyOn(d1, "prepare").mockImplementation((q: string) => {
      if (q.includes("SET claimed_at = ?1"))
        d1.raw().exec("UPDATE pending_membership SET revoked_at = 'x'");
      return orig(q);
    });
    expect(await claimPregrants(db, "u1", NOW)).toBe(0);
    spy.mockRestore();
    expect(user("u1").proEndsAt).toBeNull();
  });

  test("a failed grant gives the row back for the next sign-in", async () => {
    const { db, d1, addUser } = setup();
    await apply(db, "a@example.org");
    addUser("u1", "a@example.org");
    const batch = spyOn(d1, "batch").mockImplementation(async () => {
      throw new Error("D1 down");
    });
    await expect(claimPregrants(db, "u1", NOW)).rejects.toThrow("D1 down");
    batch.mockRestore();
    expect(await listPending(db)).toHaveLength(1);
    expect(await claimPregrants(db, "u1", NOW)).toBe(30);
  });

  test("no user, or no email: nothing", async () => {
    const { db } = setup();
    expect(await claimPregrants(db, "nobody", NOW)).toBe(0);
  });
});

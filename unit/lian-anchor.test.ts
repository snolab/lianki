import { describe, expect, test } from "bun:test";
import { GENESIS, studyDayLeaf, verifyChain, verifyProof } from "@lianki/lian";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  MAX_DAYS_PER_RUN,
  type LianDb,
  anchorDue,
  closedThrough,
  headAnchor,
  listAnchors,
  myLeafDays,
  proofFor,
} from "@/lib/lian/anchor";

async function seed() {
  const d1 = createTestD1(testSchema()) as unknown as LianDb;
  await d1.exec(`
    INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('u-ann', 'Ann', 'Ann@x.com', 1, '2025-01-01', '2025-01-01'),
             ('u-bob', 'Bob', 'bob@x.com', 1, '2025-01-01', '2025-01-01'),
             ('u-cat', 'Cat', 'cat@x.com', 1, '2025-01-01', '2025-01-01');
    INSERT INTO study_day (email, day, tz, first_at, reviews) VALUES
      ('ann@x.com', '2026-11-01', 'Asia/Tokyo', '2026-11-01T01:00:00Z', 12),
      ('bob@x.com', '2026-11-01', 'America/New_York', '2026-11-01T15:00:00Z', 3),
      ('cat@x.com', '2026-11-01', 'UTC', '2026-11-01T09:00:00Z', 40),
      ('ann@x.com', '2026-11-03', 'Asia/Tokyo', '2026-11-03T01:00:00Z', 5),
      ('ghost@x.com', '2026-11-03', 'UTC', '2026-11-03T01:00:00Z', 9);
  `);
  return d1;
}

const raw = (d1: LianDb) => (d1 as unknown as { raw(): import("node:sqlite").DatabaseSync }).raw();
const count = (d1: LianDb, t: string) =>
  Number((raw(d1).prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);

// The cron fires at 00:05 UTC on the 5th: the 3rd has ended in every zone.
const CRON = new Date("2026-11-05T00:05:00Z");

describe("which days are due", () => {
  test("a day is closed once it has ended in UTC−12 (36 h after it began in UTC)", () => {
    expect(closedThrough(new Date("2026-11-05T00:05:00Z"))).toBe("2026-11-03");
    expect(closedThrough(new Date("2026-11-04T11:59:00Z"))).toBe("2026-11-02");
    expect(closedThrough(new Date("2026-11-04T12:00:00Z"))).toBe("2026-11-03");
  });
});

describe("the daily anchor (cron)", () => {
  test("anchors every closed day from the first study day, no gaps, in order", async () => {
    const d1 = await seed();
    const { anchored, through } = await anchorDue(d1, CRON);
    expect(through).toBe("2026-11-03");
    expect(anchored.map((a) => [a.day, a.leafCount])).toEqual([
      ["2026-11-01", 3],
      ["2026-11-02", 0], // nobody studied: anchored empty, so the chain has no gap
      ["2026-11-03", 1], // the ghost (no user row) has no leaf
    ]);
    expect(anchored[0].prevHash).toBe(GENESIS);
    expect(anchored[1].prevHash).toBe(anchored[0].chainHash);
    const all = (await listAnchors(d1)).reverse();
    expect(await verifyChain(all)).toMatchObject({ ok: true, days: 3 });
    expect(count(d1, "lian_salt")).toBe(3);
  });

  test("re-running changes nothing; a later run appends only the new day", async () => {
    const d1 = await seed();
    await anchorDue(d1, CRON);
    const before = raw(d1).prepare("SELECT * FROM lian_anchor ORDER BY day").all();
    const leaves = raw(d1).prepare("SELECT * FROM lian_leaf ORDER BY day, idx").all();
    const salts = raw(d1).prepare("SELECT * FROM lian_salt ORDER BY user_id").all();
    expect((await anchorDue(d1, CRON)).anchored).toEqual([]);
    expect((await anchorDue(d1, new Date(CRON.getTime() + 3_600_000))).anchored).toEqual([]);
    expect(raw(d1).prepare("SELECT * FROM lian_anchor ORDER BY day").all()).toEqual(before);
    expect(raw(d1).prepare("SELECT * FROM lian_leaf ORDER BY day, idx").all()).toEqual(leaves);
    expect(raw(d1).prepare("SELECT * FROM lian_salt ORDER BY user_id").all()).toEqual(salts);

    // A late row for an anchored day changes nothing either.
    raw(d1).exec(
      "UPDATE study_day SET reviews = 999 WHERE email = 'ann@x.com' AND day = '2026-11-01'",
    );
    raw(d1).exec(
      "INSERT INTO study_day VALUES ('bob@x.com', '2026-11-04', 'UTC', '2026-11-04T05:00:00Z', 2)",
    );
    const next = await anchorDue(d1, new Date("2026-11-06T00:05:00Z"));
    expect(next.anchored.map((a) => a.day)).toEqual(["2026-11-04"]);
    expect(next.anchored[0].prevHash).toBe(before[2].chain_hash as string);
    expect(raw(d1).prepare("SELECT * FROM lian_anchor WHERE day < '2026-11-04'").all()).toEqual(
      before,
    );
  });

  test("an anchored day is never rewritten: updates, deletes and re-inserts are refused", async () => {
    const d1 = await seed();
    await anchorDue(d1, CRON);
    expect(() => raw(d1).exec("UPDATE lian_anchor SET merkle_root = 'x'")).toThrow(/append-only/);
    expect(() => raw(d1).exec("DELETE FROM lian_anchor")).toThrow(/append-only/);
    expect(() => raw(d1).exec("UPDATE lian_leaf SET leaf_hash = 'x'")).toThrow(/append-only/);
    expect(() => raw(d1).exec("DELETE FROM lian_leaf")).toThrow(/append-only/);
    const { anchorDay } = await import("@/lib/lian/anchor");
    await expect(anchorDay(d1, "2026-11-01", GENESIS, CRON)).rejects.toThrow();
    expect(count(d1, "lian_anchor")).toBe(3);
    expect(count(d1, "lian_leaf")).toBe(4);
  });

  test("nothing to do before any study day, or before the first day closes", async () => {
    const empty = createTestD1(testSchema()) as unknown as LianDb;
    expect((await anchorDue(empty, CRON)).anchored).toEqual([]);
    expect(await headAnchor(empty)).toBeNull();
    const d1 = await seed();
    expect((await anchorDue(d1, new Date("2026-11-02T11:00:00Z"))).anchored).toEqual([]);
  });

  test("catches up at most MAX_DAYS_PER_RUN days a run", async () => {
    const d1 = await seed();
    const far = new Date(Date.parse("2026-11-01T00:00:00Z") + 80 * 86_400_000);
    expect((await anchorDue(d1, far)).anchored.length).toBe(MAX_DAYS_PER_RUN);
    expect((await anchorDue(d1, far)).anchored.length).toBe(MAX_DAYS_PER_RUN);
    expect(await verifyChain((await listAnchors(d1, { limit: 1000 })).reverse())).toMatchObject({
      ok: true,
      days: 2 * MAX_DAYS_PER_RUN,
    });
  });

  test("many users in a day: inserts are chunked under D1's parameter limit", async () => {
    const d1 = createTestD1(testSchema()) as unknown as LianDb;
    const db = raw(d1);
    for (let i = 0; i < 75; i++) {
      db.exec(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u${i}', 'n', 'u${i}@x.com', 1, 'x', 'x')`,
      );
      db.exec(`INSERT INTO study_day VALUES ('u${i}@x.com', '2026-11-01', 'UTC', 'x', ${i + 1})`);
    }
    const { anchored } = await anchorDue(d1, new Date("2026-11-03T00:05:00Z"));
    expect(anchored[0].leafCount).toBe(75);
    const p = await proofFor(d1, "u42", "2026-11-01");
    expect(p!.preimage.summary).toEqual({ reviews: 43 });
    expect(await verifyProof(p!.leafHash, p!.proof, anchored[0].merkleRoot)).toBe(true);
  });
});

describe("a user's own proof", () => {
  test("proves the caller's leaf to the anchored root and chain", async () => {
    const d1 = await seed();
    const { anchored } = await anchorDue(d1, CRON);
    const p = await proofFor(d1, "u-ann", "2026-11-01");
    expect(p).not.toBeNull();
    expect(p!.preimage).toMatchObject({
      userId: "u-ann",
      day: "2026-11-01",
      summary: { reviews: 12 },
    });
    expect(await studyDayLeaf(p!.preimage)).toBe(p!.leafHash);
    expect(await verifyProof(p!.leafHash, p!.proof, p!.merkleRoot)).toBe(true);
    expect(p!.merkleRoot).toBe(anchored[0].merkleRoot);
    expect(p!.chainHash).toBe(anchored[0].chainHash);
    expect(p!.leafCount).toBe(3);
  });

  test("contains only the caller's own data — no other user's id, salt or counts", async () => {
    const d1 = await seed();
    await anchorDue(d1, CRON);
    const p = JSON.stringify(await proofFor(d1, "u-ann", "2026-11-01"));
    const salts = raw(d1).prepare("SELECT user_id, salt FROM lian_salt").all() as {
      user_id: string;
      salt: string;
    }[];
    for (const s of salts.filter((s) => s.user_id !== "u-ann")) {
      expect(p).not.toContain(s.user_id);
      expect(p).not.toContain(s.salt);
    }
    expect(p).not.toContain("bob@x.com");
    expect(p).not.toContain('"reviews":40');
  });

  test("nothing for a day without the caller's leaf, a day not anchored, or bad input", async () => {
    const d1 = await seed();
    await anchorDue(d1, CRON);
    expect(await proofFor(d1, "u-bob", "2026-11-03")).toBeNull();
    expect(await proofFor(d1, "u-ann", "2026-11-04")).toBeNull();
    expect(await proofFor(d1, "u-ann", "11/1/2026")).toBeNull();
    expect(await proofFor(d1, "", "2026-11-01")).toBeNull();
    expect(await myLeafDays(d1, "u-ann")).toEqual(["2026-11-03", "2026-11-01"]);
    expect(await myLeafDays(d1, "u-bob")).toEqual(["2026-11-01"]);
  });
});

describe("the public anchor list", () => {
  test("has no user data, only day, hashes and counts", async () => {
    const d1 = await seed();
    await anchorDue(d1, CRON);
    const list = await listAnchors(d1);
    const json = JSON.stringify(list);
    for (const s of ["u-ann", "u-bob", "u-cat", "ann@x.com", "bob@x.com", "Asia/Tokyo"])
      expect(json).not.toContain(s);
    for (const r of raw(d1).prepare("SELECT salt FROM lian_salt").all() as { salt: string }[])
      expect(json).not.toContain(r.salt);
    for (const a of list)
      expect(Object.keys(a).sort()).toEqual(
        ["chainHash", "createdAt", "day", "leafCount", "merkleRoot", "prevHash", "version"].sort(),
      );
  });

  test("newest first, with limit and before", async () => {
    const d1 = await seed();
    await anchorDue(d1, CRON);
    expect((await listAnchors(d1)).map((a) => a.day)).toEqual([
      "2026-11-03",
      "2026-11-02",
      "2026-11-01",
    ]);
    expect((await listAnchors(d1, { limit: 1 })).map((a) => a.day)).toEqual(["2026-11-03"]);
    expect((await listAnchors(d1, { before: "2026-11-03" })).map((a) => a.day)).toEqual([
      "2026-11-02",
      "2026-11-01",
    ]);
    expect((await listAnchors(d1, { limit: NaN, before: "junk" })).length).toBe(3);
  });
});

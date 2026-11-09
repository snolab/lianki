import { describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import {
  cachedReadBlobSizes,
  compactBytes,
  listReadBlobSizes,
  READ_SIZES_TTL_MS,
  resetReadBlobCache,
} from "@/lib/repos/devUserFiles";
import { listDevUsers, monthlySignups } from "@/lib/repos/devUsersD1";

describe("monthlySignups", () => {
  test("counts accounts per JST month in one aggregate", async () => {
    const d1 = createTestD1(testSchema()) as unknown as D1Like;
    await d1.exec(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('a', NULL, 'a@x.com', 1, '2026-10-31T14:59:59.000Z', '2026'),
               ('b', NULL, 'b@x.com', 1, '2026-10-31T15:00:00.000Z', '2026'),
               ('c', NULL, 'c@x.com', 1, '2026-11-08T01:00:00.000Z', '2026'),
               ('d', NULL, 'd@x.com', 1, '2026-09-01', '2026'),
               ('e', NULL, 'e@x.com', 1, 'not a date', '2026');
    `);
    expect(await monthlySignups(d1)).toEqual([
      { month: "2026-09", n: 1 },
      { month: "2026-10", n: 1 },
      { month: "2026-11", n: 2 },
    ]);
  });
});

describe("listDevUsers", () => {
  test("joins each account with its activity and data, most recently seen first", async () => {
    const d1 = createTestD1(testSchema()) as unknown as D1Like;
    const now = new Date("2026-10-29T00:00:00Z");
    await d1.exec(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, proEndsAt)
        VALUES ('u1', 'Ann', 'ann@x.com', 1, '2026-01-01', '2026-01-01', '2026-11-05T09:11:15Z'),
               ('u2', NULL, 'bob@x.com', 1, '2026-02-01', '2026-02-01', NULL),
               ('u3', NULL, 'cat@x.com', 1, '2026-03-01', '2026-03-01', NULL);
      INSERT INTO session (id, userId, token, expiresAt, createdAt, updatedAt)
        VALUES ('s1', 'u2', 't1', '2027', '2026-10-01', '2026-10-28'),
               ('s2', 'u2', 't2', '2027', '2026-09-01', '2026-09-02');
      INSERT INTO word_cards (email, list_id, term, back, card, card_due, updated_at)
        VALUES ('bob@x.com', 'l', 'chat', 'cat', '{}', '2026', '2026');
      INSERT INTO word_reviews (email, list_id, term, rating, state, reviewed_at)
        VALUES ('bob@x.com', 'l', 'chat', 3, 0, '2026-10-27T00:00:00Z'),
               ('bob@x.com', 'l', 'chat', 3, 0, '2026-01-01T00:00:00Z');
      INSERT INTO fsrs_notes (id, email, url, card, card_due, deleted_at)
        VALUES ('n1', 'ann@x.com', 'https://a', '{}', '2026', NULL),
               ('n2', 'ann@x.com', 'https://b', '{}', '2026', '2026');
      INSERT INTO read_materials (id, user_id, title, created_at, updated_at)
        VALUES ('r1', 'cat@x.com', 'T', '2026', '2026');
    `);
    const rows = await listDevUsers(d1, now);
    expect(rows.map((r) => r.email)).toEqual(["bob@x.com", "cat@x.com", "ann@x.com"]);
    const [bob, cat, ann] = rows;
    expect(bob).toMatchObject({ sessions: 2, lastSeen: "2026-10-28", words: 1, wordReviews: 2 });
    expect(bob.reviews7d).toBe(1);
    expect(bob.bytes).toBeGreaterThan(0);
    expect(ann).toMatchObject({ pages: 1, sessions: 0, proEndsAt: "2026-11-05T09:11:15Z" });
    expect(cat.reads).toBe(1);
  });
});

describe("file bytes per account", () => {
  test("compactBytes", () => {
    expect(compactBytes(0)).toBe("0 B");
    expect(compactBytes(812)).toBe("812 B");
    expect(compactBytes(3482)).toBe("3.4 KB");
    expect(compactBytes(12 * 1048576)).toBe("12 MB");
    expect(compactBytes(2 * 1024 ** 3)).toBe("2 GB");
    expect(compactBytes(1.25 * 1024 ** 3)).toBe("1.3 GB");
  });

  test("listReadBlobSizes pages through the read/ prefix and stops at the cap", async () => {
    const pages = [
      { objects: [{ key: "read/r1", size: 40_000 }], truncated: true, cursor: "c1" },
      { objects: [{ key: "read/r2", size: 50_000 }], truncated: true, cursor: "c2" },
      { objects: [{ key: "read/r3", size: 1 }], truncated: false },
    ];
    const prefixes: string[] = [];
    const bucket = {
      list: async (o: { prefix: string; cursor?: string }) => {
        prefixes.push(o.prefix);
        return pages[o.cursor ? Number(o.cursor.slice(1)) : 0];
      },
    };
    const all = await listReadBlobSizes(bucket);
    expect(all.complete).toBe(true);
    expect([...all.sizes]).toEqual([
      ["r1", 40_000],
      ["r2", 50_000],
      ["r3", 1],
    ]);
    expect(new Set(prefixes)).toEqual(new Set(["read/"]));
    const capped = await listReadBlobSizes(bucket, 2);
    expect(capped.complete).toBe(false);
    expect(capped.sizes.size).toBe(2);
  });

  test("cachedReadBlobSizes lists once per TTL and survives an R2 failure", async () => {
    resetReadBlobCache();
    let calls = 0;
    const bucket = () => ({
      list: async () => {
        calls++;
        return { objects: [{ key: "read/r1", size: 7 }], truncated: false };
      },
    });
    await cachedReadBlobSizes(bucket, 1_000);
    const again = await cachedReadBlobSizes(bucket, 1_000 + READ_SIZES_TTL_MS - 1);
    expect(calls).toBe(1);
    expect(again.sizes.get("r1")).toBe(7);
    await cachedReadBlobSizes(bucket, 1_000 + READ_SIZES_TTL_MS);
    expect(calls).toBe(2);
    resetReadBlobCache();
    const failed = await cachedReadBlobSizes(() => {
      throw new Error("no binding");
    });
    expect(failed).toMatchObject({ complete: false });
    expect(failed.sizes.size).toBe(0);
    resetReadBlobCache();
  });

  test("sums inbox, avatar and R2 reading texts per account", async () => {
    const d1 = createTestD1(testSchema()) as unknown as D1Like;
    await d1.exec(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('u1', 'Ann', 'ann@x.com', 1, '2026-01-01', '2026-01-01'),
               ('u2', NULL, 'bob@x.com', 1, '2026-02-01', '2026-02-01');
      INSERT INTO inbox_usage (user_id, bytes_stored, settled_ms, updated_ms) VALUES ('u1', 3000, 0, 0);
      INSERT INTO user_avatar (userId, r2Key, size, updatedMs) VALUES ('u1', 'a/u1', 500, 0);
      INSERT INTO read_materials (id, user_id, title, r2_key, created_at, updated_at)
        VALUES ('r1', 'bob@x.com', 'T', 'read/r1', '2026', '2026'),
               ('r2', 'u2', 'T', 'read/r2', '2026', '2026'),
               ('r3', 'u2', 'T', NULL, '2026', '2026');
    `);
    const sizes = new Map([
      ["r1", 40_000],
      ["r2", 50_000],
      ["gone", 9],
    ]);
    const rows = await listDevUsers(d1, new Date("2026-10-29T00:00:00Z"), sizes);
    const by = Object.fromEntries(rows.map((r) => [r.email, r]));
    expect(by["ann@x.com"]).toMatchObject({ files: 3500, inboxBytes: 3000 });
    expect(by["bob@x.com"]).toMatchObject({ files: 90_000, inboxBytes: 0 });
    const none = await listDevUsers(d1);
    expect(none.find((r) => r.email === "bob@x.com")?.files).toBe(0);
  });
});

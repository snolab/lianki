import { describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { listDevUsers } from "@/lib/repos/devUsersD1";

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

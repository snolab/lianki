import { describe, test, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import type { D1Like } from "@/lib/d1/types";
import { tierFor, d1MembershipStore, getUserMembership, startTrial } from "@/lib/membership";

const SCHEMA = readFileSync(join(process.cwd(), "db/migrations/0001_init.sql"), "utf8");

let d1: TestD1Database;
beforeEach(() => {
  d1 = createTestD1(SCHEMA);
});

function insertUser(id: string, fields: { trialEndsAt?: string; proEndsAt?: string } = {}) {
  const now = new Date().toISOString();
  d1.raw()
    .prepare(
      "INSERT INTO user (id, email, emailVerified, createdAt, updatedAt, trialEndsAt, proEndsAt) VALUES (?, ?, 1, ?, ?, ?, ?)",
    )
    .run(id, `${id}@example.com`, now, now, fields.trialEndsAt ?? null, fields.proEndsAt ?? null);
}

const future = () => new Date(Date.now() + 86_400_000).toISOString();
const past = () => new Date(Date.now() - 86_400_000).toISOString();

// ── Pure tier resolution ───────────────────────────────────────────────────────

describe("tierFor", () => {
  test("pro outranks trial when both are active", () => {
    expect(tierFor(new Date(Date.now() + 1000), new Date(Date.now() + 1000))).toBe("pro");
  });
  test("trial when only the trial is active", () => {
    expect(tierFor(new Date(Date.now() + 1000), undefined)).toBe("trial");
  });
  test("free when both are expired or absent", () => {
    expect(tierFor(new Date(Date.now() - 1000), new Date(Date.now() - 1000))).toBe("free");
    expect(tierFor(undefined, undefined)).toBe("free");
  });
});

// ── Full orchestration on the D1 backend (guards the DB_BACKEND=d1 path) ─────────

describe("membership on D1", () => {
  const store = () => d1MembershipStore(d1 as unknown as D1Like);

  test("getUserMembership throws for an unknown user", async () => {
    await expect(getUserMembership("ghost", store())).rejects.toThrow("User not found");
  });

  test("auto-grants a 90-day trial on first read and persists it", async () => {
    insertUser("u1");
    const m = await getUserMembership("u1", store());
    expect(m.tier).toBe("trial");
    expect(m.trialEndsAt).toBeInstanceOf(Date);
    const days = Math.round((m.trialEndsAt!.getTime() - Date.now()) / 86_400_000);
    expect(days).toBe(90);

    // Persisted: a second read returns the same trial, not a fresh grant.
    const again = await getUserMembership("u1", store());
    expect(again.tier).toBe("trial");
    expect(again.trialEndsAt!.toISOString()).toBe(m.trialEndsAt!.toISOString());
  });

  test("reports pro when proEndsAt is in the future", async () => {
    insertUser("u2", { proEndsAt: future() });
    expect((await getUserMembership("u2", store())).tier).toBe("pro");
  });

  test("reports free when trial/pro are expired (no auto re-grant)", async () => {
    insertUser("u3", { trialEndsAt: past() });
    expect((await getUserMembership("u3", store())).tier).toBe("free");
  });

  test("startTrial sets a 90-day trial that getUserMembership then reflects", async () => {
    insertUser("u4", { trialEndsAt: past() }); // currently free
    await startTrial("u4", store());
    expect((await getUserMembership("u4", store())).tier).toBe("trial");
  });
});

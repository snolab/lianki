import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { PLUS_ALIAS_DOMAINS, canonicalEmail } from "@/lib/canonical-email";
import { setEmailCanonical } from "@/lib/canonical-email-d1";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { d1MembershipStore, getUserMembership } from "@/lib/membership";
import {
  claimInvite,
  createGiftCode,
  getOrCreateInviteCode,
  redeemGiftCode,
} from "@/lib/referrals/store";
import { accountKey } from "@/lib/security/throttle";
import { personKey } from "@/lib/rateLimit";

/**
 * The canonical email decides only "is this the same person?" for the trial,
 * invites, gift codes and per-person limits (owner, 2026-11-05). Accounts and
 * sign-in keep the address as given.
 */
describe("canonicalEmail", () => {
  test("gmail ignores dots and +tags; googlemail is gmail", () => {
    expect(canonicalEmail("a.b.c@gmail.com")).toBe("abc@gmail.com");
    expect(canonicalEmail("abc+lianki@gmail.com")).toBe("abc@gmail.com");
    expect(canonicalEmail("a.b+x+y@googlemail.com")).toBe("ab@gmail.com");
  });
  test("case and surrounding space never matter", () => {
    expect(canonicalEmail("  A.B@GMail.COM ")).toBe("ab@gmail.com");
    expect(canonicalEmail("Someone@Example.com")).toBe("someone@example.com");
  });
  test("other domains keep dots and +tags", () => {
    expect(canonicalEmail("a.b+x@example.com")).toBe("a.b+x@example.com");
    expect(canonicalEmail("a.b@qq.com")).toBe("a.b@qq.com");
  });
  test("known plus-alias providers drop the +tag but keep dots", () => {
    expect(canonicalEmail("a.b+x@outlook.com")).toBe("a.b@outlook.com");
    expect(canonicalEmail("a+x@icloud.com")).toBe("a@icloud.com");
  });
  test("odd input is left alone", () => {
    expect(canonicalEmail("+x@gmail.com")).toBe("+x@gmail.com");
    expect(canonicalEmail("nope")).toBe("nope");
    expect(canonicalEmail("a@b@gmail.com")).toBe("a@b@gmail.com");
  });
});

describe("the migration backfill matches canonicalEmail", () => {
  const sql = readFileSync(join(process.cwd(), "db/migrations/0043_email_canonical.sql"), "utf8");
  test("every plus-alias domain is in the SQL", () => {
    for (const d of PLUS_ALIAS_DOMAINS) expect(sql).toContain(`'${d}'`);
  });
  test("same result for every sample", () => {
    const emails = [
      "A.B+x@Gmail.com",
      "ab@googlemail.com",
      "x.y+z@example.com",
      "x.y+z@outlook.com",
      "q+1@pm.me",
      "+z@gmail.com",
      "bad",
      "a@b@c.com",
      "Plain@Example.org",
    ];
    const db = new Database(":memory:");
    db.run("CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE)");
    emails.forEach((e, i) => db.run("INSERT INTO user VALUES (?, ?)", [String(i), e]));
    db.exec(sql);
    const rows = db.query("SELECT email, email_canonical FROM user").all() as {
      email: string;
      email_canonical: string;
    }[];
    for (const r of rows) expect(r.email_canonical).toBe(canonicalEmail(r.email));
  });
});

describe("per-person limits", () => {
  test("dot and +tag variants share a counter key", async () => {
    expect(await accountKey("send", "a.b+1@gmail.com")).toBe(
      await accountKey("send", "ab@gmail.com"),
    );
    expect(personKey("tts", "A.b@googlemail.com")).toBe(personKey("tts", "ab@gmail.com"));
    expect(await accountKey("send", "a.b@example.com")).not.toBe(
      await accountKey("send", "ab@example.com"),
    );
  });
});

const NOW = new Date("2026-11-01T00:00:00Z");
const DAY = 86_400_000;

function setup() {
  const d1 = createTestD1(testSchema());
  const add = (id: string, email: string, f: { createdAt?: Date; trialEndsAt?: string } = {}) => {
    const at = (f.createdAt ?? NOW).toISOString();
    d1.raw()
      .prepare(
        "INSERT INTO user (id, email, emailVerified, createdAt, updatedAt, trialEndsAt) VALUES (?, ?, 1, ?, ?, ?)",
      )
      .run(id, email, at, at, f.trialEndsAt ?? null);
    // What the better-auth user.create hook (or the migration's backfill) does.
    return setEmailCanonical(d1 as unknown as D1Like, id, email);
  };
  const row = (id: string) =>
    d1.raw().prepare("SELECT * FROM user WHERE id = ?").get(id) as {
      email: string;
      trialEndsAt: string | null;
      proEndsAt: string | null;
      updatedAt: string;
    };
  const store = () => d1MembershipStore(d1 as unknown as D1Like);
  return { d1, add, row, store };
}

describe("the trial, once per person", () => {
  test("a dot or +tag variant of an account that had a trial gets none", async () => {
    const { add, store } = setup();
    await add("first", "ab@gmail.com");
    expect((await getUserMembership("first", store())).tier).toBe("trial");
    for (const [id, email] of [
      ["dots", "a.b@gmail.com"],
      ["plus", "ab+again@gmail.com"],
      ["google", "A.B@googlemail.com"],
    ]) {
      await add(id, email);
      const m = await getUserMembership(id, store());
      expect(m.tier).toBe("free");
      // Recorded as used, so it stays free on every later read.
      expect((await getUserMembership(id, store())).tier).toBe("free");
    }
  });

  test("another domain's dotted address is another person", async () => {
    const { add, store } = setup();
    await add("a", "ab@example.com");
    await add("b", "a.b@example.com");
    expect((await getUserMembership("a", store())).tier).toBe("trial");
    expect((await getUserMembership("b", store())).tier).toBe("trial");
  });

  test("existing accounts that already share a canonical email are untouched", async () => {
    const { add, row, store } = setup();
    const t1 = new Date(NOW.getTime() + 90 * DAY).toISOString();
    const t2 = new Date(NOW.getTime() + 60 * DAY).toISOString();
    await add("old1", "ab@gmail.com", { trialEndsAt: t1 });
    await add("old2", "a.b@gmail.com", { trialEndsAt: t2 });
    const before = [row("old1"), row("old2")];
    await getUserMembership("old1", store());
    await getUserMembership("old2", store());
    for (const [i, id] of ["old1", "old2"].entries()) {
      const r = row(id);
      expect(r.email).toBe(before[i].email);
      expect(r.trialEndsAt).toBe(before[i].trialEndsAt);
      expect(r.proEndsAt).toBe(before[i].proEndsAt);
    }
  });
});

describe("invites and gift codes, once per person", () => {
  test("an alias of the inviter cannot claim their invite", async () => {
    const { d1, add } = setup();
    await add("inviter", "ab@gmail.com");
    await add("alias", "a.b+x@gmail.com");
    const code = await getOrCreateInviteCode(d1, "inviter", NOW);
    expect(await claimInvite(d1, "alias", code, NOW)).toEqual({
      status: "rejected",
      reason: "self",
    });
  });

  test("a second account of someone is not new", async () => {
    const { d1, add } = setup();
    await add("inviter", "someone@example.com");
    await add("p1", "ab@gmail.com", { createdAt: new Date(NOW.getTime() - DAY) });
    await add("p2", "a.b@gmail.com");
    const code = await getOrCreateInviteCode(d1, "inviter", NOW);
    expect(await claimInvite(d1, "p2", code, NOW)).toEqual({
      status: "rejected",
      reason: "not new",
    });
  });

  test("a gift code redeemed by one account is spent for its aliases", async () => {
    const { d1, add } = setup();
    await add("owner", "owner@example.com");
    await add("p1", "ab@gmail.com");
    await add("p2", "a.b+gift@googlemail.com");
    const code = await createGiftCode(d1, "owner", { days: 30, maxUses: 10 }, NOW);
    expect((await redeemGiftCode(d1, "p1", code, NOW)).status).toBe("redeemed");
    expect(await redeemGiftCode(d1, "p2", code, NOW)).toEqual({
      status: "rejected",
      reason: "already redeemed",
    });
  });
});

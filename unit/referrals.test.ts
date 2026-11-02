import { describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  YEARLY_CAP_DAYS,
  cappedDays,
  maskEmail,
  newCode,
  normaliseCode,
} from "@/lib/referrals/rules";
import {
  claimInvite,
  createGiftCode,
  getOrCreateInviteCode,
  inviteSummary,
  listGiftCodes,
  redeemGiftCode,
  reviewDays,
  rewardPurchase,
  settleAsInvitee,
} from "@/lib/referrals/store";

/**
 * Invites and gift codes. The rewards are free Pro, so what matters is that
 * each is given once, only for real use, and never past the yearly cap.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-01T00:00:00Z");
const iso = (d: Date) => d.toISOString();
const plus = (days: number, from = NOW) => new Date(from.getTime() + days * DAY);

function setup() {
  const d1 = createTestD1(testSchema());
  const add = (id: string, createdAt = NOW, extra: { proEndsAt?: string } = {}) =>
    d1
      .raw()
      .prepare(
        "INSERT INTO user (id, email, createdAt, updatedAt, proEndsAt) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, `${id}@x.com`, iso(createdAt), iso(createdAt), extra.proEndsAt ?? null);
  const user = (id: string) =>
    d1.raw().prepare("SELECT * FROM user WHERE id = ?").get(id) as {
      trialEndsAt: string | null;
      proEndsAt: string | null;
    };
  /** One word review per given day offset from `from`. */
  const reviewOn = (id: string, offsets: number[], from = NOW) => {
    for (const o of offsets) {
      d1.raw()
        .prepare(
          "INSERT INTO word_reviews (email, list_id, term, rating, state, reviewed_at) VALUES (?, 'l', 't', 3, 0, ?)",
        )
        .run(`${id}@x.com`, iso(plus(o, from)));
    }
  };
  return { d1, add, user, reviewOn };
}

describe("rules", () => {
  test("codes are unambiguous and normalise", () => {
    const c = newCode();
    expect(c).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(normaliseCode(" ab12cd34 ")).toBe("AB12CD34");
    expect(normaliseCode("../x")).toBeNull();
    expect(normaliseCode(42)).toBeNull();
  });
  test("the cap gives what is left, never less than 0", () => {
    expect(cappedDays(30, 0)).toBe(30);
    expect(cappedDays(30, YEARLY_CAP_DAYS - 10)).toBe(10);
    expect(cappedDays(30, YEARLY_CAP_DAYS + 5)).toBe(0);
  });
  test("emails are masked for the inviter", () => {
    expect(maskEmail("alice@gmail.com")).toBe("a***@gmail.com");
    expect(maskEmail("nope")).toBe("***");
  });
});

describe("invite codes", () => {
  test("one per user, stable", async () => {
    const { d1, add } = setup();
    add("a");
    const c = await getOrCreateInviteCode(d1, "a", NOW);
    expect(await getOrCreateInviteCode(d1, "a", NOW)).toBe(c);
  });
});

describe("claiming an invite", () => {
  test("a new account gets 30 extra trial days on top of the 90", async () => {
    const { d1, add, user } = setup();
    add("a");
    add("b");
    const code = await getOrCreateInviteCode(d1, "a", NOW);
    const r = await claimInvite(d1, "b", code, plus(0.5));
    expect(r.status).toBe("claimed");
    expect(user("b").trialEndsAt).toBe(iso(plus(120)));
  });

  test("stacks on a trial already granted", async () => {
    const { d1, add, user } = setup();
    add("a");
    add("b");
    d1.raw()
      .prepare("UPDATE user SET trialEndsAt = ? WHERE id = 'b'")
      .run(iso(plus(90)));
    await claimInvite(d1, "b", await getOrCreateInviteCode(d1, "a", NOW), NOW);
    expect(user("b").trialEndsAt).toBe(iso(plus(120)));
  });

  test("refused: unknown code, yourself, an old account, a second invite", async () => {
    const { d1, add } = setup();
    add("a");
    add("old", plus(-10));
    add("b");
    add("c");
    const code = await getOrCreateInviteCode(d1, "a", NOW);
    const codeC = await getOrCreateInviteCode(d1, "c", NOW);
    expect(await claimInvite(d1, "b", "NOPE2345", NOW)).toEqual({
      status: "rejected",
      reason: "unknown code",
    });
    expect(await claimInvite(d1, "a", code, NOW)).toEqual({ status: "rejected", reason: "self" });
    expect(await claimInvite(d1, "old", code, NOW)).toEqual({
      status: "rejected",
      reason: "not new",
    });
    await claimInvite(d1, "b", code, NOW);
    expect(await claimInvite(d1, "b", codeC, NOW)).toEqual({
      status: "rejected",
      reason: "already invited",
    });
  });
});

describe("activation", () => {
  test("counts distinct review days across words and page cards", async () => {
    const { d1, add, reviewOn } = setup();
    add("b");
    reviewOn("b", [0, 0.1, 1]);
    d1.raw()
      .prepare(
        "INSERT INTO fsrs_notes (id, email, url, card, log, card_due) VALUES ('n', 'b@x.com', 'u', '{}', ?, ?)",
      )
      .run(JSON.stringify([{ review: iso(plus(1)) }, { review: iso(plus(2)) }]), iso(NOW));
    expect(await reviewDays(d1, "b@x.com", NOW, plus(30))).toBe(3);
  });

  test("7 study days in the first month earn the inviter 30 days of Pro, once", async () => {
    const { d1, add, user, reviewOn } = setup();
    add("a");
    add("b");
    await claimInvite(d1, "b", await getOrCreateInviteCode(d1, "a", NOW), NOW);
    reviewOn("b", [0, 1, 2, 3, 4, 5]);
    await settleAsInvitee(d1, "b", plus(6));
    expect(user("a").proEndsAt).toBeNull(); // 6 days: not yet

    reviewOn("b", [6]);
    await settleAsInvitee(d1, "b", plus(7));
    expect(user("a").proEndsAt).toBe(iso(plus(37)));
    await settleAsInvitee(d1, "b", plus(8));
    const s = await inviteSummary(d1, "a", plus(8));
    expect(user("a").proEndsAt).toBe(iso(plus(37)));
    expect(s).toMatchObject({ invited: 1, activated: 1, earnedLastYear: 30 });
    expect(s.friends[0]).toMatchObject({ email: "b***@x.com", activated: true });
  });

  test("study days after the first month do not count", async () => {
    const { d1, add, user, reviewOn } = setup();
    add("a");
    add("b");
    await claimInvite(d1, "b", await getOrCreateInviteCode(d1, "a", NOW), NOW);
    reviewOn("b", [0, 1, 2, 31, 32, 33, 34, 35]);
    await inviteSummary(d1, "a", plus(40));
    expect(user("a").proEndsAt).toBeNull();
  });

  test("the yearly cap stops rewards but still settles them", async () => {
    const { d1, add, user, reviewOn } = setup();
    add("a");
    d1.raw()
      .prepare(
        "INSERT INTO membership_grant (id, userId, kind, days, reason, refId, createdAt) VALUES ('g', 'a', 'pro', ?, 'referral-activated', 'earlier', ?)",
      )
      .run(YEARLY_CAP_DAYS - 10, iso(plus(-100)));
    add("b");
    await claimInvite(d1, "b", await getOrCreateInviteCode(d1, "a", NOW), NOW);
    reviewOn("b", [0, 1, 2, 3, 4, 5, 6]);
    const s = await inviteSummary(d1, "a", plus(7));
    expect(s.activated).toBe(1);
    expect(user("a").proEndsAt).toBe(iso(plus(17))); // only the 10 days left
  });
});

describe("purchase bonus", () => {
  test("the inviter gets 30 days on the invitee's first pass only", async () => {
    const { d1, add, user } = setup();
    add("a");
    add("b");
    await claimInvite(d1, "b", await getOrCreateInviteCode(d1, "a", NOW), NOW);
    expect(await rewardPurchase(d1, "b", plus(3))).toBe(true);
    expect(await rewardPurchase(d1, "b", plus(4))).toBe(false);
    expect(user("a").proEndsAt).toBe(iso(plus(33)));
  });
  test("nothing for a buyer nobody invited", async () => {
    const { d1, add } = setup();
    add("b");
    expect(await rewardPurchase(d1, "b", NOW)).toBe(false);
  });
});

describe("gift codes", () => {
  test("N days of Pro, M uses, once per person", async () => {
    const { d1, add, user } = setup();
    add("x");
    add("y");
    add("z");
    const code = await createGiftCode(
      d1,
      "owner@x.com",
      { days: 7, maxUses: 2, note: "friends" },
      NOW,
    );
    expect(await redeemGiftCode(d1, "x", code, NOW)).toEqual({
      status: "redeemed",
      days: 7,
      credits: 0,
    });
    expect(await redeemGiftCode(d1, "x", code, NOW)).toEqual({
      status: "rejected",
      reason: "already redeemed",
    });
    expect(await redeemGiftCode(d1, "y", code, NOW)).toEqual({
      status: "redeemed",
      days: 7,
      credits: 0,
    });
    expect(await redeemGiftCode(d1, "z", code, NOW)).toEqual({
      status: "rejected",
      reason: "used up",
    });
    expect(user("x").proEndsAt).toBe(iso(plus(7)));
    expect((await listGiftCodes(d1))[0]).toMatchObject({
      code,
      uses: 2,
      maxUses: 2,
      note: "friends",
    });
  });

  test("stacks on running Pro; unknown and expired codes are refused", async () => {
    const { d1, add, user } = setup();
    add("x", NOW, { proEndsAt: iso(plus(10)) });
    const code = await createGiftCode(d1, "o", { days: 7, maxUses: 5 }, NOW);
    await redeemGiftCode(d1, "x", code, NOW);
    expect(user("x").proEndsAt).toBe(iso(plus(17)));
    const old = await createGiftCode(d1, "o", { days: 7, maxUses: 5, expiresAt: plus(1) }, NOW);
    expect(await redeemGiftCode(d1, "x", old, plus(2))).toEqual({
      status: "rejected",
      reason: "expired",
    });
    expect(await redeemGiftCode(d1, "x", "NOPE2345", NOW)).toEqual({
      status: "rejected",
      reason: "unknown code",
    });
  });
});

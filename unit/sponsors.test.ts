import { describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { hmacSha256Hex } from "@/lib/payments/stripe";
import {
  GRACE_DAYS,
  addMonths,
  isSponsorshipAction,
  monthlyGrantsPro,
  oneTimeDays,
  periodGrantEnd,
  periodIndex,
  verifyGithubSignature,
  type SponsorshipEventLike,
} from "@/lib/payments/sponsors";
import {
  applySponsorshipEvent,
  handleSponsorsWebhook,
  settleSponsorship,
  settleUserSponsorships,
  type D1WithBatch,
  type SponsorshipRow,
} from "@/lib/payments/sponsors-store";

/**
 * GitHub Sponsors → Pro. GitHub takes the money; what can go wrong here is a
 * paying sponsor who gets nothing, or a redelivery that grants twice.
 */
const DAY = 24 * 60 * 60 * 1000;
const START = new Date("2026-11-01T00:00:00Z");
const plus = (days: number, from = START) => new Date(from.getTime() + days * DAY);
const SECRET = "test-secret";

function setup() {
  const d1 = createTestD1(testSchema());
  const db = d1 as unknown as D1WithBatch;
  const addUser = (id: string, proEndsAt: string | null = null) =>
    d1
      .raw()
      .prepare(
        "INSERT INTO user (id, email, createdAt, updatedAt, proEndsAt) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, `${id}@x.com`, START.toISOString(), START.toISOString(), proEndsAt);
  const linkGithub = (userId: string, githubId: string) =>
    d1
      .raw()
      .prepare(
        "INSERT INTO account (id, userId, accountId, providerId, createdAt, updatedAt) VALUES (?, ?, ?, 'github', ?, ?)",
      )
      .run(`a-${userId}-${githubId}`, userId, githubId, START.toISOString(), START.toISOString());
  const proEnd = (id: string) => {
    const r = d1.raw().prepare("SELECT proEndsAt FROM user WHERE id = ?").get(id) as {
      proEndsAt: string | null;
    };
    return r.proEndsAt ? new Date(r.proEndsAt) : null;
  };
  const grants = () =>
    d1
      .raw()
      .prepare("SELECT userId, days, reason, refId FROM membership_grant ORDER BY createdAt, refId")
      .all() as { userId: string; days: number; reason: string; refId: string }[];
  const sponsorship = (id = "S1") =>
    d1.raw().prepare("SELECT * FROM github_sponsorship WHERE id = ?").get(id) as
      | SponsorshipRow
      | undefined;
  return { d1, db, addUser, linkGithub, proEnd, grants, sponsorship };
}

function event(
  action: string,
  o: {
    id?: string;
    githubId?: number;
    cents?: number;
    oneTime?: boolean;
    startedAt?: Date;
    effective?: Date;
    fromCents?: number;
  } = {},
): SponsorshipEventLike {
  return {
    action,
    effective_date: o.effective?.toISOString(),
    sponsorship: {
      node_id: o.id ?? "S1",
      created_at: (o.startedAt ?? START).toISOString(),
      sponsor: { id: o.githubId ?? 42 },
      tier: { monthly_price_in_cents: o.cents ?? 500, is_one_time: o.oneTime ?? false },
    },
    changes: o.fromCents != null ? { tier: { from: { monthly_price_in_cents: o.fromCents } } } : {},
  };
}

describe("rules", () => {
  test("the $5 monthly threshold", () => {
    expect(monthlyGrantsPro(499)).toBe(false);
    expect(monthlyGrantsPro(500)).toBe(true);
  });
  test("one-time days take the largest step at or below the price", () => {
    expect(oneTimeDays(100)).toBe(0);
    expect(oneTimeDays(500)).toBe(30);
    expect(oneTimeDays(999)).toBe(30);
    expect(oneTimeDays(1000)).toBe(62);
    expect(oneTimeDays(100_000)).toBe(366);
  });
  test("months clamp to the month's last day", () => {
    const jan31 = new Date("2027-01-31T12:00:00Z");
    expect(addMonths(jan31, 1).toISOString()).toBe("2027-02-28T12:00:00.000Z");
    expect(addMonths(jan31, 2).toISOString()).toBe("2027-03-31T12:00:00.000Z");
    expect(addMonths(new Date("2026-12-15T00:00:00Z"), 1).toISOString()).toBe(
      "2027-01-15T00:00:00.000Z",
    );
  });
  test("period index counts whole months from the start", () => {
    expect(periodIndex(START, plus(-3))).toBe(0);
    expect(periodIndex(START, START)).toBe(0);
    expect(periodIndex(START, plus(29))).toBe(0);
    expect(periodIndex(START, new Date("2026-12-01T00:00:00Z"))).toBe(1);
    expect(periodIndex(START, new Date("2026-11-30T23:59:59Z"))).toBe(0);
    expect(periodIndex(new Date("2026-11-15T10:00:00Z"), new Date("2026-12-15T09:00:00Z"))).toBe(0);
    expect(periodIndex(START, new Date("2027-03-02T00:00:00Z"))).toBe(4);
  });
  test("a period's grant ends a week after the period", () => {
    expect(periodGrantEnd(START, 0)).toEqual(plus(30 + GRACE_DAYS));
  });
  test("only sponsorship actions are handled", () => {
    expect(isSponsorshipAction("created")).toBe(true);
    expect(isSponsorshipAction("deleted")).toBe(false);
    expect(isSponsorshipAction(undefined)).toBe(false);
  });
});

describe("signature", () => {
  const body = '{"action":"created"}';
  test("accepts the right HMAC, in either case", async () => {
    const sig = await hmacSha256Hex(SECRET, body);
    expect(await verifyGithubSignature(body, `sha256=${sig}`, SECRET)).toBe(true);
    expect(await verifyGithubSignature(body, `sha256=${sig.toUpperCase()}`, SECRET)).toBe(true);
  });
  test("rejects a wrong secret, a changed body, and malformed headers", async () => {
    const sig = await hmacSha256Hex(SECRET, body);
    expect(await verifyGithubSignature(body, `sha256=${sig}`, "other")).toBe(false);
    expect(await verifyGithubSignature(body + " ", `sha256=${sig}`, SECRET)).toBe(false);
    expect(await verifyGithubSignature(body, sig, SECRET)).toBe(false);
    expect(await verifyGithubSignature(body, "sha256=abc", SECRET)).toBe(false);
    expect(await verifyGithubSignature(body, null, SECRET)).toBe(false);
  });
});

describe("the endpoint", () => {
  const signed = async (body: string, eventName = "sponsorship") => ({
    body,
    event: eventName,
    signature: `sha256=${await hmacSha256Hex(SECRET, body)}`,
  });
  test("503 without the secret, before touching the database", async () => {
    const res = await handleSponsorsWebhook(await signed("{}"), undefined, () => {
      throw new Error("no db");
    });
    expect(res.status).toBe(503);
  });
  test("401 on a bad signature", async () => {
    const req = { ...(await signed("{}")), signature: "sha256=" + "0".repeat(64) };
    expect((await handleSponsorsWebhook(req, SECRET, () => setup().db)).status).toBe(401);
  });
  test("200 to ping and to other events", async () => {
    const { db } = setup();
    expect(
      (await handleSponsorsWebhook(await signed("{}", "ping"), SECRET, () => db)).body,
    ).toEqual({ pong: true });
    const other = await handleSponsorsWebhook(await signed("{}", "push"), SECRET, () => db);
    expect(other.status).toBe(200);
    expect(other.body.ignored).toBe(true);
  });
  test("400 on a signed body that is not JSON", async () => {
    const { db } = setup();
    expect((await handleSponsorsWebhook(await signed("nope"), SECRET, () => db)).status).toBe(400);
  });
  test("a signed sponsorship event grants Pro", async () => {
    const { db, addUser, linkGithub, proEnd } = setup();
    addUser("u1");
    linkGithub("u1", "42");
    const res = await handleSponsorsWebhook(
      await signed(JSON.stringify(event("created"))),
      SECRET,
      () => db,
      plus(1),
    );
    expect(res).toEqual({
      status: 200,
      body: { received: true, status: "granted", sponsorshipId: "S1" },
    });
    expect(proEnd("u1")).toEqual(plus(37));
  });
});

describe("monthly sponsorships", () => {
  test("created grants the first period plus grace, as a github-sponsors grant", async () => {
    const { db, addUser, linkGithub, proEnd, grants } = setup();
    addUser("u1");
    linkGithub("u1", "42");
    const r = await applySponsorshipEvent(db, event("created"), START);
    expect(r).toEqual({ status: "granted", sponsorshipId: "S1" });
    expect(proEnd("u1")).toEqual(plus(37));
    expect(grants()).toEqual([
      { userId: "u1", days: 37, reason: "github-sponsors", refId: "S1:2026-11-01" },
    ]);
  });

  test("a redelivered created is a no-op", async () => {
    const { db, addUser, linkGithub, proEnd, grants } = setup();
    addUser("u1");
    linkGithub("u1", "42");
    await applySponsorshipEvent(db, event("created"), START);
    const again = await applySponsorshipEvent(db, event("created"), plus(2));
    expect(again.status).toBe("recorded");
    expect(proEnd("u1")).toEqual(plus(37));
    expect(grants()).toHaveLength(1);
  });

  test("edited extends into a new period, at most once per period", async () => {
    const { db, addUser, linkGithub, proEnd, grants } = setup();
    addUser("u1");
    linkGithub("u1", "42");
    await applySponsorshipEvent(db, event("created"), START);
    const dec5 = new Date("2026-12-05T00:00:00Z");
    expect((await applySponsorshipEvent(db, event("edited"), dec5)).status).toBe("granted");
    expect((await applySponsorshipEvent(db, event("edited"), plus(1, dec5))).status).toBe(
      "recorded",
    );
    expect(proEnd("u1")).toEqual(new Date("2027-01-08T00:00:00Z"));
    expect(grants().map((g) => g.refId)).toEqual(["S1:2026-11-01", "S1:2026-12-01"]);
  });

  test("a membership status read carries it into the next period", async () => {
    const { db, addUser, linkGithub, proEnd } = setup();
    addUser("u1");
    linkGithub("u1", "42");
    await applySponsorshipEvent(db, event("created"), START);
    expect(await settleUserSponsorships(db, "u1", plus(10))).toBe(0);
    expect(await settleUserSponsorships(db, "u1", new Date("2026-12-03T00:00:00Z"))).toBe(1);
    expect(proEnd("u1")).toEqual(new Date("2027-01-08T00:00:00Z"));
  });

  test("never shortens Pro that already runs further", async () => {
    const { db, addUser, linkGithub, proEnd, grants } = setup();
    addUser("u1", plus(200).toISOString());
    linkGithub("u1", "42");
    expect((await applySponsorshipEvent(db, event("created"), START)).status).toBe("granted");
    expect(proEnd("u1")).toEqual(plus(200));
    expect(grants()[0].days).toBe(0);
  });

  test("a tier under $5 grants nothing", async () => {
    const { db, addUser, linkGithub, proEnd } = setup();
    addUser("u1");
    linkGithub("u1", "42");
    expect((await applySponsorshipEvent(db, event("created", { cents: 300 }), START)).status).toBe(
      "recorded",
    );
    expect(proEnd("u1")).toBeNull();
  });

  test("tier_changed takes the new price at once", async () => {
    const { db, addUser, linkGithub, proEnd, sponsorship } = setup();
    addUser("u1");
    linkGithub("u1", "42");
    await applySponsorshipEvent(db, event("created", { cents: 300 }), START);
    expect(proEnd("u1")).toBeNull();
    const up = await applySponsorshipEvent(db, event("tier_changed", { cents: 1000 }), plus(3));
    expect(up.status).toBe("granted");
    expect(sponsorship()?.priceCents).toBe(1000);
    expect(proEnd("u1")).toEqual(plus(37));
  });

  test("a downgrade under $5 stops extending but keeps what was given", async () => {
    const { db, addUser, linkGithub, proEnd } = setup();
    addUser("u1");
    linkGithub("u1", "42");
    await applySponsorshipEvent(db, event("created", { cents: 1000 }), START);
    // Scheduled: nothing changes until it takes effect.
    await applySponsorshipEvent(
      db,
      event("pending_tier_change", { cents: 100, fromCents: 1000 }),
      plus(5),
    );
    expect(await settleUserSponsorships(db, "u1", new Date("2026-12-02T00:00:00Z"))).toBe(1);
    await applySponsorshipEvent(
      db,
      event("tier_changed", { cents: 100 }),
      plus(1, new Date("2027-01-01T00:00:00Z")),
    );
    expect(await settleUserSponsorships(db, "u1", new Date("2027-01-05T00:00:00Z"))).toBe(0);
    expect(proEnd("u1")).toEqual(new Date("2027-01-08T00:00:00Z"));
  });

  test("a pending tier change seen first keeps the old price", async () => {
    const { db, addUser, sponsorship } = setup();
    addUser("u1");
    await applySponsorshipEvent(db, event("pending_tier_change", { cents: 100, fromCents: 800 }));
    expect(sponsorship()?.priceCents).toBe(800);
  });

  test("cancelled stops extending; the days already given stay", async () => {
    const { db, addUser, linkGithub, proEnd, sponsorship } = setup();
    addUser("u1");
    linkGithub("u1", "42");
    await applySponsorshipEvent(db, event("created"), START);
    const dec = new Date("2026-12-01T00:00:00Z");
    expect((await applySponsorshipEvent(db, event("cancelled"), dec)).status).toBe("recorded");
    expect(sponsorship()?.status).toBe("cancelled");
    expect(await settleUserSponsorships(db, "u1", plus(3, dec))).toBe(0);
    expect(proEnd("u1")).toEqual(plus(37));
    // A redelivered `created` does not bring it back…
    await applySponsorshipEvent(db, event("created"), plus(4, dec));
    expect(sponsorship()?.status).toBe("cancelled");
    // …but sponsoring again later does.
    const again = await applySponsorshipEvent(
      db,
      event("created", { startedAt: plus(10, dec) }),
      plus(10, dec),
    );
    expect(again.status).toBe("granted");
    expect(sponsorship()?.status).toBe("active");
  });

  test("a redelivered cancelled keeps the first end", async () => {
    const { db, addUser, sponsorship } = setup();
    addUser("u1");
    await applySponsorshipEvent(db, event("cancelled"), plus(3));
    await applySponsorshipEvent(db, event("cancelled"), plus(9));
    expect(sponsorship()?.endsAt).toBe(plus(3).toISOString());
  });

  test("pending_cancellation pays to the effective date, not past it", async () => {
    const { db, addUser, linkGithub, proEnd, sponsorship } = setup();
    addUser("u1");
    linkGithub("u1", "42");
    await applySponsorshipEvent(db, event("created"), START);
    const dec1 = new Date("2026-12-01T00:00:00Z");
    await applySponsorshipEvent(db, event("pending_cancellation", { effective: dec1 }), plus(10));
    expect(sponsorship()?.endsAt).toBe(dec1.toISOString());
    // The `cancelled` never arrives; the next period still earns nothing.
    expect(await settleUserSponsorships(db, "u1", plus(2, dec1))).toBe(0);
    expect(proEnd("u1")).toEqual(plus(37));
  });

  test("a pending_cancellation without a date is only recorded", async () => {
    const { db, addUser, sponsorship } = setup();
    addUser("u1");
    await applySponsorshipEvent(db, event("pending_cancellation"));
    expect(sponsorship()?.endsAt).toBeNull();
  });
});

describe("one-time sponsorships", () => {
  test("grant their days once, stacking on running Pro", async () => {
    const { db, addUser, linkGithub, proEnd, grants } = setup();
    addUser("u1", plus(10).toISOString());
    linkGithub("u1", "42");
    const ev = event("created", { oneTime: true, cents: 1000 });
    expect((await applySponsorshipEvent(db, ev, START)).status).toBe("granted");
    expect((await applySponsorshipEvent(db, ev, plus(40))).status).toBe("recorded");
    expect(await settleUserSponsorships(db, "u1", plus(400))).toBe(0);
    expect(proEnd("u1")).toEqual(plus(72));
    expect(grants()).toEqual([
      { userId: "u1", days: 62, reason: "github-sponsors", refId: "S1:once" },
    ]);
  });
  test("under the smallest step, nothing", async () => {
    const { db, addUser, linkGithub, proEnd } = setup();
    addUser("u1");
    linkGithub("u1", "42");
    await applySponsorshipEvent(db, event("created", { oneTime: true, cents: 100 }), START);
    expect(proEnd("u1")).toBeNull();
  });
});

describe("sponsors without a Lianki account", () => {
  test("wait, then are claimed when that GitHub account signs in", async () => {
    const { db, addUser, linkGithub, proEnd, sponsorship } = setup();
    expect((await applySponsorshipEvent(db, event("created", { githubId: 7 }), START)).status).toBe(
      "pending",
    );
    expect(sponsorship()?.userId).toBeNull();
    addUser("u2");
    // Signed in some other way: nothing to claim yet.
    expect(await settleUserSponsorships(db, "u2", plus(2))).toBe(0);
    linkGithub("u2", "7");
    expect(await settleUserSponsorships(db, "u2", plus(3))).toBe(1);
    expect(sponsorship()?.userId).toBe("u2");
    expect(proEnd("u2")).toEqual(plus(37));
    // Claimed once: the webhook now finds the user directly.
    const later = await applySponsorshipEvent(db, event("edited", { githubId: 7 }), plus(5));
    expect(later.status).toBe("recorded");
  });

  test("a claimed sponsorship is not taken by another account", async () => {
    const { db, addUser, linkGithub, sponsorship } = setup();
    addUser("u1");
    linkGithub("u1", "7");
    await applySponsorshipEvent(db, event("created", { githubId: 7 }), START);
    addUser("u3");
    linkGithub("u3", "7");
    await settleUserSponsorships(db, "u3", plus(1));
    expect(sponsorship()?.userId).toBe("u1");
  });

  test("a cancelled sponsorship claimed later grants nothing", async () => {
    const { db, addUser, linkGithub, proEnd } = setup();
    await applySponsorshipEvent(db, event("created", { githubId: 7 }), START);
    await applySponsorshipEvent(db, event("cancelled", { githubId: 7 }), plus(30));
    addUser("u2");
    linkGithub("u2", "7");
    expect(await settleUserSponsorships(db, "u2", plus(31))).toBe(0);
    expect(proEnd("u2")).toBeNull();
  });
});

describe("guards", () => {
  test("unknown actions and malformed payloads are ignored", async () => {
    const { db } = setup();
    expect(await applySponsorshipEvent(db, { ...event("created"), action: "deleted" })).toEqual({
      status: "ignored",
      reason: "unknown action",
    });
    expect(await applySponsorshipEvent(db, { action: "created", sponsorship: {} })).toEqual({
      status: "ignored",
      reason: "malformed",
    });
    const bad = event("created");
    bad.sponsorship!.created_at = "not a date";
    expect((await applySponsorshipEvent(db, bad)).status).toBe("ignored");
  });
  test("a sponsorship whose user is gone grants nothing", async () => {
    const { db } = setup();
    const row: SponsorshipRow = {
      id: "S9",
      githubId: "9",
      userId: "ghost",
      oneTime: 0,
      priceCents: 500,
      startedAt: START.toISOString(),
      status: "active",
      endsAt: null,
      createdAt: START.toISOString(),
      updatedAt: START.toISOString(),
    };
    expect(await settleSponsorship(db, row, START)).toBe(false);
    expect(await settleSponsorship(db, { ...row, userId: null }, START)).toBe(false);
  });
});

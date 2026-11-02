import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { getBalance, ledger } from "@/lib/payments/credits-store";
import { PASSES } from "@/lib/payments/passes";
import { providerMode, providerOpenTo, providersFor } from "@/lib/payments/providers";
import { stripeProvider } from "@/lib/payments/providers/stripe";
import {
  createCheckoutSession,
  hmacSha256Hex,
  readStripeEvent,
  stripeEnabled,
  stripeMode,
  stripeOpenTo,
} from "@/lib/payments/stripe";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";
import { handleProviderWebhook } from "@/lib/payments/webhook";
import { claimInvite, getOrCreateInviteCode } from "@/lib/referrals/store";

/**
 * Stripe's test/live switch. What matters: nothing charges real money unless
 * the owner set a live key AND STRIPE_LIVE=1; any other combination is off; a
 * test-mode payment is offered to, and credits, the owner only — marked as test
 * mode — and a signed event for the other mode credits nothing.
 */
const NOW = new Date("2026-11-01T00:00:00.000Z");
const OWNER = "owner@x.com";
const WH = "whsec_unit";

const saved = { ...process.env };
const realFetch = globalThis.fetch;
afterEach(() => {
  process.env = { ...saved };
  globalThis.fetch = realFetch;
});

function env(mode: "test" | "live" | "none", key?: string) {
  delete process.env.STRIPE_LIVE;
  process.env.OWNER_EMAILS = OWNER;
  if (mode === "none") {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    return;
  }
  process.env.STRIPE_SECRET_KEY = key ?? (mode === "live" ? "sk_live_x" : "sk_test_x");
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  if (mode === "live") process.env.STRIPE_LIVE = "1";
}

function setup() {
  const d1 = createTestD1(testSchema());
  for (const [id, email] of [
    ["owner", OWNER],
    ["u", "u@x.com"],
    ["inviter", "i@x.com"],
  ])
    d1.raw()
      .prepare("INSERT INTO user (id, email, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
      .run(id, email, NOW.toISOString(), NOW.toISOString());
  return d1;
}

const pass = (userId: string, id = `cs_${userId}`) => ({
  id,
  payment_status: "paid",
  amount_total: 600,
  currency: "jpy",
  client_reference_id: userId,
  metadata: { userId, passId: "pro-1m" },
});
const topup = (userId: string, id = `cs_t_${userId}`) => ({
  id,
  payment_status: "paid",
  amount_total: 1200,
  currency: "jpy",
  metadata: { userId, kind: "topup", amount: "1200" },
});

async function delivery(
  object: unknown,
  { livemode = false, type = "checkout.session.completed", secret = WH } = {},
) {
  const body = JSON.stringify({ id: "evt_1", type, livemode, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  return new Request("https://lianki.com/api/payments/stripe-webhook", {
    method: "POST",
    body,
    headers: { "stripe-signature": `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}` },
  });
}

describe("stripeMode", () => {
  test("test needs sk_test_ and no flag; live needs sk_live_ and STRIPE_LIVE=1; else off", () => {
    const base = { STRIPE_SECRET_KEY: "sk_test_a", STRIPE_WEBHOOK_SECRET: "w" };
    expect(stripeMode({})).toBeNull();
    expect(stripeMode({ STRIPE_SECRET_KEY: "sk_test_a" })).toBeNull();
    expect(stripeMode({ STRIPE_WEBHOOK_SECRET: "w" })).toBeNull();
    expect(stripeMode({ ...base, STRIPE_WEBHOOK_SECRET: "  " })).toBeNull();
    expect(stripeMode(base)).toBe("test");
    expect(stripeMode({ ...base, STRIPE_SECRET_KEY: "  sk_test_a  " })).toBe("test");
    expect(stripeMode({ ...base, STRIPE_LIVE: "1" })).toBeNull(); // test key, live flag
    expect(stripeMode({ ...base, STRIPE_SECRET_KEY: "sk_live_a" })).toBeNull(); // live key, no flag
    expect(stripeMode({ ...base, STRIPE_SECRET_KEY: "sk_live_a", STRIPE_LIVE: "1" })).toBe("live");
    expect(stripeMode({ ...base, STRIPE_SECRET_KEY: "sk_live_a", STRIPE_LIVE: " 1 " })).toBe(
      "live",
    );
    for (const flag of ["true", "yes", "0", ""])
      expect(stripeMode({ ...base, STRIPE_SECRET_KEY: "sk_live_a", STRIPE_LIVE: flag })).toBeNull();
    // Any key whose prefix does not prove its mode is off either way —
    // restricted keys included (the code uses a full secret key only).
    for (const k of ["rk_test_a", "rk_live_a", "pk_live_a", "pk_test_a", "sk_a", "SK_LIVE_A"]) {
      expect(stripeMode({ ...base, STRIPE_SECRET_KEY: k })).toBeNull();
      expect(stripeMode({ ...base, STRIPE_SECRET_KEY: k, STRIPE_LIVE: "1" })).toBeNull();
    }
    expect(stripeEnabled(base)).toBe(true);
    expect(stripeEnabled({ ...base, STRIPE_LIVE: "1" })).toBe(false);
  });

  test("test mode is the owner's alone; live is everyone's", () => {
    const t = { STRIPE_SECRET_KEY: "sk_test_a", STRIPE_WEBHOOK_SECRET: "w", OWNER_EMAILS: OWNER };
    expect(stripeOpenTo(OWNER, t)).toBe(true);
    expect(stripeOpenTo(" Owner@X.com ", t)).toBe(true);
    expect(stripeOpenTo("u@x.com", t)).toBe(false);
    expect(stripeOpenTo(null, t)).toBe(false);
    expect(stripeOpenTo(OWNER, { ...t, OWNER_EMAILS: "" })).toBe(false);
    const live = { ...t, STRIPE_SECRET_KEY: "sk_live_a", STRIPE_LIVE: "1" };
    expect(stripeOpenTo("u@x.com", live)).toBe(true);
    expect(stripeOpenTo(null, live)).toBe(true);
    expect(stripeOpenTo(OWNER, { ...t, STRIPE_LIVE: "1" })).toBe(false);
    // The wallet's provider list follows the same rule.
    expect(providerMode(stripeProvider, t)).toBe("test");
    expect(providerOpenTo(stripeProvider, "u@x.com", t)).toBe(false);
    expect(providersFor(OWNER, t).map((p) => p.id)).toEqual(["stripe"]);
    expect(providersFor("u@x.com", live).map((p) => p.id)).toEqual(["stripe"]);
  });
});

describe("createCheckoutSession", () => {
  const input = {
    purchase: { kind: "pass" as const, pass: PASSES["pro-1m"] },
    userId: "u1",
    successUrl: "https://x/ok",
    cancelUrl: "https://x/no",
  };
  const answer = (livemode: unknown) => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return Response.json({ url: "https://checkout.stripe.com/c/pay/cs_1", livemode });
    }) as unknown as typeof fetch;
    return calls;
  };

  test("off: never calls Stripe", async () => {
    env("test", "rk_live_x");
    const calls = answer(true);
    await expect(createCheckoutSession(input)).rejects.toThrow("Stripe is off");
    expect(calls).toHaveLength(0);
  });

  test("a session in the other mode is refused", async () => {
    env("test");
    answer(true);
    await expect(createCheckoutSession(input)).rejects.toThrow("mode mismatch");
    env("live");
    answer(false);
    await expect(createCheckoutSession(input)).rejects.toThrow("mode mismatch");
    answer(undefined);
    await expect(createCheckoutSession(input)).rejects.toThrow("mode mismatch");
    answer(true);
    expect(await createCheckoutSession(input)).toBe("https://checkout.stripe.com/c/pay/cs_1");
  });
});

describe("readStripeEvent", () => {
  test("null without a secret, on a bad signature, or a body that is not an object", async () => {
    env("none");
    expect(await readStripeEvent(await delivery(pass("u")))).toBeNull();
    env("test");
    expect(await readStripeEvent(await delivery(pass("u"), { secret: "other" }))).toBeNull();
    for (const body of ["not json", "null", "42"]) {
      const t = Math.floor(Date.now() / 1000);
      const req = new Request("https://x", {
        method: "POST",
        body,
        headers: { "stripe-signature": `t=${t},v1=${await hmacSha256Hex(WH, `${t}.${body}`)}` },
      });
      expect(await readStripeEvent(req)).toBeNull();
    }
    expect((await readStripeEvent(await delivery(pass("u"))))?.livemode).toBe(false);
  });
});

describe("handleStripeWebhook", () => {
  let d1: ReturnType<typeof setup>;
  beforeEach(() => {
    d1 = setup();
  });
  const payments = () =>
    d1.raw().prepare("SELECT id, userId, testMode FROM payment ORDER BY id").all() as {
      id: string;
      userId: string;
      testMode: number;
    }[];
  const pro = (id: string) =>
    (d1.raw().prepare("SELECT proEndsAt FROM user WHERE id = ?").get(id) as { proEndsAt: string })
      .proEndsAt;

  test("off (no secrets, or keys that do not prove the mode) → 503, nothing written", async () => {
    for (const [mode, key] of [
      ["none", undefined],
      ["test", "sk_live_x"],
      ["test", "rk_test_x"],
      ["live", "sk_test_x"],
    ] as const) {
      env(mode, key);
      const r = await handleStripeWebhook(d1, await delivery(pass("owner")), NOW);
      expect(r.status).toBe(503);
    }
    expect(payments()).toEqual([]);
  });

  test("a bad signature → 400", async () => {
    env("test");
    const r = await handleStripeWebhook(d1, await delivery(pass("owner"), { secret: "x" }), NOW);
    expect(r).toEqual({ status: 400, body: { error: "Bad signature" } });
  });

  test("an event for the other mode credits nothing and asks for a retry", async () => {
    env("test");
    let r = await handleStripeWebhook(d1, await delivery(pass("owner"), { livemode: true }), NOW);
    expect(r).toEqual({ status: 503, body: { error: "Mode mismatch" } });
    env("live");
    r = await handleStripeWebhook(d1, await delivery(pass("u"), { livemode: false }), NOW);
    expect(r.status).toBe(503);
    expect(payments()).toEqual([]);
    expect(pro("owner")).toBeNull();
  });

  test("other events, or no session, are acknowledged and ignored", async () => {
    env("live");
    for (const req of [
      await delivery(pass("u"), { livemode: true, type: "charge.refunded" }),
      await delivery(null, { livemode: true }),
      await delivery({}, { livemode: true }),
    ])
      expect(await handleStripeWebhook(d1, req, NOW)).toEqual({
        status: 200,
        body: { received: true },
      });
    expect(payments()).toEqual([]);
  });

  test("test mode: a pass for anyone but the owner is ignored", async () => {
    env("test");
    for (const s of [pass("u"), pass("ghost"), { ...pass("u"), metadata: {} }]) {
      const r = await handleStripeWebhook(d1, await delivery(s), NOW);
      expect(r).toEqual({ status: 200, body: { received: true, status: "ignored" } });
    }
    const noUser = { ...pass("u"), client_reference_id: null, metadata: {} };
    expect((await handleStripeWebhook(d1, await delivery(noUser), NOW)).body.status).toBe(
      "ignored",
    );
    expect(payments()).toEqual([]);
    expect(pro("u")).toBeNull();
  });

  test("test mode: the owner's pass applies once, marked test, and earns no invite bonus", async () => {
    env("test");
    // Even if the owner had been invited, a test pass pays the inviter nothing.
    await claimInvite(d1, "owner", await getOrCreateInviteCode(d1, "inviter", NOW), NOW);
    const r = await handleStripeWebhook(d1, await delivery(pass("owner")), NOW);
    expect(r).toEqual({ status: 200, body: { received: true, status: "applied" } });
    expect(payments()).toEqual([{ id: "cs_owner", userId: "owner", testMode: 1 }]);
    expect(pro("owner")).not.toBeNull();
    expect(pro("inviter")).toBeNull();
    const again = await handleStripeWebhook(d1, await delivery(pass("owner")), NOW);
    expect(again.body.status).toBe("duplicate");
    expect(pro("inviter")).toBeNull();
  });

  test("live mode: anyone's pass applies, unmarked, and pays the inviter", async () => {
    env("live");
    await claimInvite(d1, "u", await getOrCreateInviteCode(d1, "inviter", NOW), NOW);
    const r = await handleStripeWebhook(d1, await delivery(pass("u"), { livemode: true }), NOW);
    expect(r.body.status).toBe("applied");
    expect(payments()).toEqual([{ id: "cs_u", userId: "u", testMode: 0 }]);
    expect(pro("inviter")).not.toBeNull();
    // An unpaid session is acknowledged and ignored.
    const unpaid = { ...pass("u", "cs_2"), payment_status: "unpaid" };
    expect(
      (await handleStripeWebhook(d1, await delivery(unpaid, { livemode: true }), NOW)).body.status,
    ).toBe("ignored");
  });

  test("top-ups: test credits the owner only (noted), live anyone (unnoted)", async () => {
    env("test");
    expect((await handleStripeWebhook(d1, await delivery(topup("u")), NOW)).body.status).toBe(
      "ignored",
    );
    expect(await getBalance(d1, "u")).toBe(0);
    expect((await handleStripeWebhook(d1, await delivery(topup("owner")), NOW)).body.status).toBe(
      "applied",
    );
    expect((await ledger(d1, "owner"))[0]).toMatchObject({
      amount: 1200,
      refId: "stripe:cs_t_owner",
      note: "test mode",
    });
    env("live");
    const live = (s: unknown) => delivery(s, { livemode: true });
    expect((await handleStripeWebhook(d1, await live(topup("u")), NOW)).body.status).toBe(
      "applied",
    );
    expect((await ledger(d1, "u"))[0]).toMatchObject({ amount: 1200, note: null });
    // A top-up that is not paid is acknowledged and ignored.
    const unpaid = { ...topup("u", "cs_t_2"), payment_status: "unpaid" };
    expect((await handleStripeWebhook(d1, await live(unpaid), NOW)).body.status).toBe("ignored");
    expect(await getBalance(d1, "u")).toBe(1200);
  });
});

describe("stripe on the provider webhook route", () => {
  test("off → 503; other mode → 400; test credits the owner only, noted", async () => {
    const d1 = setup();
    const req = (s: unknown, o?: Parameters<typeof delivery>[1]) => delivery(s, o);
    env("test", "sk_live_x");
    expect(
      (await handleProviderWebhook(d1, stripeProvider, await req(topup("owner")))).status,
    ).toBe(503);
    expect(await stripeProvider.verifyWebhook(await req(topup("owner")))).toEqual({
      status: "invalid",
    });
    env("test");
    expect(
      (
        await handleProviderWebhook(
          d1,
          stripeProvider,
          await req(topup("owner"), { livemode: true }),
        )
      ).status,
    ).toBe(400);
    expect(
      await stripeProvider.verifyWebhook(await req(topup("owner"), { type: "charge.refunded" })),
    ).toEqual({ status: "ignored", reason: "charge.refunded" });
    expect(await stripeProvider.verifyWebhook(await req(topup("owner"), { type: "" }))).toEqual({
      status: "ignored",
      reason: "no type",
    });
    expect(
      (await handleProviderWebhook(d1, stripeProvider, await req(topup("u")), NOW)).body.status,
    ).toBe("ignored");
    expect(await getBalance(d1, "u")).toBe(0);
    expect(
      (await handleProviderWebhook(d1, stripeProvider, await req(topup("owner")), NOW)).body.status,
    ).toBe("applied");
    expect((await ledger(d1, "owner"))[0]).toMatchObject({ amount: 1200, note: "test mode" });
  });
});

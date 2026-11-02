import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  buyPassWithCredits,
  creditTestTopup,
  getBalance,
  getTestBalance,
  ledger,
  refundTestTopup,
  testLedger,
} from "@/lib/payments/credits-store";
import { PASSES } from "@/lib/payments/passes";
import {
  providerMode,
  providerOpenTo,
  providerSettleMode,
  providersFor,
} from "@/lib/payments/providers";
import { stripeProvider } from "@/lib/payments/providers/stripe";
import {
  createCheckoutSession,
  hmacSha256Hex,
  readStripeEvent,
  stripeEnabled,
  stripeKeyMode,
  stripeMode,
  stripeOpenTo,
} from "@/lib/payments/stripe";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";
import { handleProviderWebhook } from "@/lib/payments/webhook";
import { claimInvite, getOrCreateInviteCode } from "@/lib/referrals/store";

/**
 * Stripe's test/live switch. What matters: nothing charges real money unless
 * the owner set a live key AND turned the payments.stripe.live flag on; any
 * other combination is off; a
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

/** The key on the Worker; the live FLAG is passed to the functions that start a payment. */
function env(mode: "test" | "live" | "none", key?: string) {
  process.env.OWNER_EMAILS = OWNER;
  if (mode === "none") {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    return;
  }
  process.env.STRIPE_SECRET_KEY = key ?? (mode === "live" ? "sk_live_x" : "sk_test_x");
  process.env.STRIPE_WEBHOOK_SECRET = WH;
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

const LIVE = { "payments.stripe.live": true } as const;

describe("stripeMode", () => {
  test("test needs sk_test_ and the flag off; live needs sk_live_ and the flag on; else off", () => {
    const base = { STRIPE_SECRET_KEY: "sk_test_a", STRIPE_WEBHOOK_SECRET: "w" };
    const liveKey = { ...base, STRIPE_SECRET_KEY: "sk_live_a" };
    expect(stripeMode({})).toBeNull();
    expect(stripeMode({ STRIPE_SECRET_KEY: "sk_test_a" })).toBeNull();
    expect(stripeMode({ STRIPE_WEBHOOK_SECRET: "w" })).toBeNull();
    expect(stripeMode({ ...base, STRIPE_WEBHOOK_SECRET: "  " })).toBeNull();
    expect(stripeMode(base)).toBe("test");
    expect(stripeMode(base, { "payments.stripe.live": false })).toBe("test");
    expect(stripeMode({ ...base, STRIPE_SECRET_KEY: "  sk_test_a  " })).toBe("test");
    expect(stripeMode(base, LIVE)).toBeNull(); // test key, live flag
    expect(stripeMode(liveKey)).toBeNull(); // live key, flag off: no test mode on a live key
    expect(stripeMode(liveKey, LIVE)).toBe("live");
    // The old env switch is gone: STRIPE_LIVE no longer turns anything on.
    expect(stripeMode({ ...liveKey, STRIPE_LIVE: "1" })).toBeNull();
    // Only exactly true is on (a snapshot is typed, but fail closed anyway).
    for (const v of ["true", 1, null, undefined])
      expect(stripeMode(liveKey, { "payments.stripe.live": v as never })).toBeNull();
    // KOMOJU's flag does not open Stripe.
    expect(stripeMode(liveKey, { "payments.komoju.live": true })).toBeNull();
    // Any key whose prefix does not prove its mode is off either way —
    // restricted keys included (the code uses a full secret key only).
    for (const k of ["rk_test_a", "rk_live_a", "pk_live_a", "pk_test_a", "sk_a", "SK_LIVE_A"]) {
      expect(stripeMode({ ...base, STRIPE_SECRET_KEY: k })).toBeNull();
      expect(stripeMode({ ...base, STRIPE_SECRET_KEY: k }, LIVE)).toBeNull();
      expect(stripeKeyMode({ ...base, STRIPE_SECRET_KEY: k })).toBeNull();
    }
    expect(stripeEnabled(base)).toBe(true);
    expect(stripeEnabled(base, LIVE)).toBe(false);
    expect(stripeEnabled(liveKey, LIVE)).toBe(true);
  });

  test("the key alone decides how the webhook settles (flags ignored)", () => {
    const base = { STRIPE_SECRET_KEY: "sk_test_a", STRIPE_WEBHOOK_SECRET: "w" };
    expect(stripeKeyMode({})).toBeNull();
    expect(stripeKeyMode({ STRIPE_SECRET_KEY: "sk_live_a" })).toBeNull();
    expect(stripeKeyMode(base)).toBe("test");
    expect(stripeKeyMode({ ...base, STRIPE_SECRET_KEY: "sk_live_a" })).toBe("live");
    expect(providerSettleMode(stripeProvider, { ...base, STRIPE_SECRET_KEY: "sk_live_a" })).toBe(
      "live",
    );
    expect(providerSettleMode(stripeProvider, {})).toBeNull();
  });

  test("test mode is the owner's alone; live is everyone's", () => {
    const t = { STRIPE_SECRET_KEY: "sk_test_a", STRIPE_WEBHOOK_SECRET: "w", OWNER_EMAILS: OWNER };
    expect(stripeOpenTo(OWNER, t)).toBe(true);
    expect(stripeOpenTo(" Owner@X.com ", t)).toBe(true);
    expect(stripeOpenTo("u@x.com", t)).toBe(false);
    expect(stripeOpenTo(null, t)).toBe(false);
    expect(stripeOpenTo(OWNER, { ...t, OWNER_EMAILS: "" })).toBe(false);
    const live = { ...t, STRIPE_SECRET_KEY: "sk_live_a" };
    expect(stripeOpenTo("u@x.com", live, LIVE)).toBe(true);
    expect(stripeOpenTo(null, live, LIVE)).toBe(true);
    expect(stripeOpenTo(OWNER, live)).toBe(false); // live key, flag off: off for the owner too
    expect(stripeOpenTo(OWNER, t, LIVE)).toBe(false);
    // The wallet's provider list follows the same rule.
    expect(providerMode(stripeProvider, t)).toBe("test");
    expect(providerOpenTo(stripeProvider, "u@x.com", t)).toBe(false);
    expect(providersFor(OWNER, t).map((p) => p.id)).toEqual(["stripe"]);
    expect(providersFor("u@x.com", live, LIVE).map((p) => p.id)).toEqual(["stripe"]);
    expect(providersFor("u@x.com", live).map((p) => p.id)).toEqual([]);
    expect(providersFor(OWNER, live).map((p) => p.id)).toEqual([]);
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

  test("off, or a key not in the caller's mode: never calls Stripe", async () => {
    env("test", "rk_live_x");
    const calls = answer(true);
    await expect(createCheckoutSession(input, "live")).rejects.toThrow("Stripe is off");
    await expect(createCheckoutSession(input, "test")).rejects.toThrow("Stripe is off");
    env("test");
    await expect(createCheckoutSession(input, "live")).rejects.toThrow("Stripe is off");
    env("live");
    await expect(createCheckoutSession(input, "test")).rejects.toThrow("Stripe is off");
    expect(calls).toHaveLength(0);
  });

  test("a session in the other mode is refused", async () => {
    env("test");
    answer(true);
    await expect(createCheckoutSession(input, "test")).rejects.toThrow("mode mismatch");
    env("live");
    answer(false);
    await expect(createCheckoutSession(input, "live")).rejects.toThrow("mode mismatch");
    answer(undefined);
    await expect(createCheckoutSession(input, "live")).rejects.toThrow("mode mismatch");
    answer(true);
    expect(await createCheckoutSession(input, "live")).toBe(
      "https://checkout.stripe.com/c/pay/cs_1",
    );
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
      ["test", "rk_test_x"],
      ["live", "rk_live_x"],
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

  test("top-ups: test goes to the owner's test ledger only; live to anyone's balance", async () => {
    env("test");
    expect((await handleStripeWebhook(d1, await delivery(topup("u")), NOW)).body.status).toBe(
      "ignored",
    );
    expect(await getBalance(d1, "u")).toBe(0);
    expect(await getTestBalance(d1, "u")).toBe(0);
    expect((await handleStripeWebhook(d1, await delivery(topup("owner")), NOW)).body.status).toBe(
      "applied",
    );
    expect(await getBalance(d1, "owner")).toBe(0);
    expect(await ledger(d1, "owner")).toEqual([]);
    expect(await testLedger(d1, "owner")).toMatchObject([
      { amount: 1200, reason: "topup", refId: "stripe:cs_t_owner" },
    ]);
    expect((await handleStripeWebhook(d1, await delivery(topup("owner")), NOW)).body.status).toBe(
      "duplicate",
    );
    expect(await getTestBalance(d1, "owner")).toBe(1200);
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

  test("regression: test credits buy nothing, pay no inviter, and stay test after going live", async () => {
    env("test");
    // The owner was invited by someone else (worst case for the bonus).
    await claimInvite(d1, "owner", await getOrCreateInviteCode(d1, "inviter", NOW), NOW);
    await handleStripeWebhook(d1, await delivery(topup("owner")), NOW);
    expect(await getTestBalance(d1, "owner")).toBe(1200);
    // Buying a ¥600 pass "from the balance" finds nothing to spend.
    const buy = await buyPassWithCredits(d1, "owner", "pro-1m", "k1", NOW);
    expect(buy).toMatchObject({ status: "insufficient", balance: 0, price: 600 });
    expect(pro("owner")).toBeNull();
    expect(pro("inviter")).toBeNull();
    // Switching Stripe to live turns none of it into real balance.
    env("live");
    expect(await getBalance(d1, "owner")).toBe(0);
    expect((await buyPassWithCredits(d1, "owner", "pro-1m", "k2", NOW)).status).toBe(
      "insufficient",
    );
    expect(pro("inviter")).toBeNull();
  });
});

describe("the test ledger", () => {
  test("once per payment; a refund before capture blocks it; refunds are once", async () => {
    const d1 = setup();
    const t = { userId: "owner", amount: 600, provider: "komoju", paymentId: "p1" };
    expect(await creditTestTopup(d1, { ...t, userId: "ghost" }, NOW)).toEqual({
      status: "no user",
    });
    await expect(creditTestTopup(d1, { ...t, amount: 0 }, NOW)).rejects.toThrow("positive");
    expect((await creditTestTopup(d1, t, NOW)).status).toBe("applied");
    expect((await creditTestTopup(d1, t, NOW)).status).toBe("duplicate");
    expect(await refundTestTopup(d1, "komoju:p1", NOW)).toEqual({
      status: "refunded",
      amount: -600,
      balance: 0,
    });
    expect(await refundTestTopup(d1, "komoju:p1", NOW)).toEqual({ status: "duplicate" });
    // Refunded before the capture arrived: marked, and the capture records nothing.
    expect(await refundTestTopup(d1, "komoju:p2", NOW)).toEqual({ status: "marked" });
    expect((await creditTestTopup(d1, { ...t, paymentId: "p2" }, NOW)).status).toBe("refunded");
    expect(await getTestBalance(d1, "owner")).toBe(0);
    expect(await getBalance(d1, "owner")).toBe(0);
    expect(await testLedger(d1, "owner")).toHaveLength(2);
  });
});

describe("stripe on the provider webhook route", () => {
  test("off → 503; other mode → 400; test credits the owner only, noted", async () => {
    const d1 = setup();
    const req = (s: unknown, o?: Parameters<typeof delivery>[1]) => delivery(s, o);
    env("test", "rk_live_x");
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
    expect(await getBalance(d1, "owner")).toBe(0);
    expect(await getTestBalance(d1, "owner")).toBe(1200);
  });
});

describe("a flag flip while a checkout is in flight", () => {
  /**
   * The rule (docs/payments.md, "Live mode and the kill switch"): the flag
   * gates STARTING a payment; the webhook settles by the key alone. A live
   * session can only have been started while the flag was on, so a genuinely
   * live, signed event is credited after the flag was turned off — the kill
   * switch never loses a customer's money.
   */
  test("started live, flag turned off, then paid: the pass and the top-up are credited", async () => {
    const d1 = setup();
    env("live");
    // While the flag is on, the session may start…
    expect(stripeMode(process.env, LIVE)).toBe("live");
    // …then the owner flips it off: nothing new may start, for anyone.
    expect(stripeMode(process.env, {})).toBeNull();
    expect(stripeOpenTo("u@x.com", process.env, {})).toBe(false);
    // The webhook for the session already paid still credits, as real money.
    const r = await handleStripeWebhook(d1, await delivery(pass("u"), { livemode: true }), NOW);
    expect(r.body.status).toBe("applied");
    const t = await handleStripeWebhook(d1, await delivery(topup("u"), { livemode: true }), NOW);
    expect(t.body.status).toBe("applied");
    expect(await getBalance(d1, "u")).toBe(1200);
    // Same on the provider route.
    const p = await handleProviderWebhook(
      d1,
      stripeProvider,
      await delivery(topup("u", "cs_t_late"), { livemode: true }),
      NOW,
    );
    expect(p.body.status).toBe("applied");
    expect(await getBalance(d1, "u")).toBe(2400);
  });

  test("a test event on a live key is still refused, flag or not", async () => {
    const d1 = setup();
    env("live");
    const r = await handleStripeWebhook(d1, await delivery(pass("owner")), NOW);
    expect(r).toEqual({ status: 503, body: { error: "Mode mismatch" } });
    expect(
      (await handleProviderWebhook(d1, stripeProvider, await delivery(topup("owner")), NOW)).status,
    ).toBe(400);
    expect(await getBalance(d1, "owner")).toBe(0);
    expect(await getTestBalance(d1, "owner")).toBe(0);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  QUICK_TOPUPS,
  TOPUP_MAX,
  TOPUP_MIN,
  quickTopupsCoverPasses,
  shortfall,
  spendKey,
  topupAmount,
} from "@/lib/payments/credits";
import {
  applyCredit,
  buyPassWithCredits,
  creditTopup,
  getBalance,
  ledger,
  refundPassToCredits,
  reverseTopup,
} from "@/lib/payments/credits-store";
import { checkoutParams } from "@/lib/payments/stripe";
import { topupFromSession } from "@/lib/payments/providers/stripe";
import {
  PROVIDERS,
  enabledProviders,
  providerEnabled,
  providerFor,
  publicProvider,
} from "@/lib/payments/providers";
import { stripeProvider } from "@/lib/payments/providers/stripe";
import { hmacSha256Hex } from "@/lib/payments/stripe";
import { createGiftCode, redeemGiftCode } from "@/lib/referrals/store";

/**
 * The credit wallet. Money is involved, so what matters: a payment credits
 * once however often it is delivered, the balance never goes negative, a spend
 * is all-or-nothing with its Pro extension, and refunds undo exactly once.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-01T00:00:00.000Z");
const plus = (days: number, from = NOW) => new Date(from.getTime() + days * DAY);

function setup() {
  const d1 = createTestD1(testSchema());
  const add = (id: string, proEndsAt: string | null = null) =>
    d1
      .raw()
      .prepare(
        "INSERT INTO user (id, email, createdAt, updatedAt, proEndsAt) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, `${id}@x.com`, NOW.toISOString(), NOW.toISOString(), proEndsAt);
  const pro = (id: string) =>
    (
      d1.raw().prepare("SELECT proEndsAt FROM user WHERE id = ?").get(id) as {
        proEndsAt: string | null;
      }
    ).proEndsAt;
  const sum = (id: string) =>
    Number(
      (
        d1
          .raw()
          .prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM credit_ledger WHERE userId = ?")
          .get(id) as { n: number }
      ).n,
    );
  return { d1, add, pro, sum };
}

describe("rules", () => {
  test("top-up amounts: whole yen within range", () => {
    expect(topupAmount(600)).toBe(600);
    expect(topupAmount("1200")).toBe(1200);
    expect(topupAmount(TOPUP_MIN - 1)).toBeNull();
    expect(topupAmount(TOPUP_MAX + 1)).toBeNull();
    expect(topupAmount(600.5)).toBeNull();
    expect(topupAmount("abc")).toBeNull();
    expect(topupAmount(undefined)).toBeNull();
  });
  test("quick amounts line up with the passes", () => {
    expect([...QUICK_TOPUPS]).toEqual([600, 1200, 3000, 5000]);
    expect(quickTopupsCoverPasses()).toBe(true);
  });
  test("shortfall is the gap, at least one minimum top-up", () => {
    expect(shortfall(600, 600)).toBe(0);
    expect(shortfall(0, 600)).toBe(600);
    expect(shortfall(570, 600)).toBe(TOPUP_MIN);
    expect(shortfall(1000, 5000)).toBe(4000);
  });
  test("spend keys", () => {
    expect(spendKey(crypto.randomUUID())).not.toBeNull();
    expect(spendKey("short")).toBeNull();
    expect(spendKey("a'; DROP TABLE x;--")).toBeNull();
  });
});

describe("top-up", () => {
  test("credits once per provider + payment id", async () => {
    const { d1, add, sum } = setup();
    add("u");
    const t = { userId: "u", amount: 1200, provider: "stripe", paymentId: "cs_1" };
    expect(await creditTopup(d1, t, NOW)).toEqual({ status: "applied", balance: 1200 });
    expect(await creditTopup(d1, t, NOW)).toEqual({ status: "duplicate" });
    expect(await getBalance(d1, "u")).toBe(1200);
    // The same payment id from another provider is another payment.
    expect((await creditTopup(d1, { ...t, provider: "komoju" }, NOW)).status).toBe("applied");
    expect(await getBalance(d1, "u")).toBe(2400);
    expect(sum("u")).toBe(2400);
  });
  test("an unknown user is not credited", async () => {
    const { d1 } = setup();
    expect(
      await creditTopup(d1, { userId: "ghost", amount: 600, provider: "stripe", paymentId: "x" }),
    ).toEqual({ status: "no user" });
  });
  test("a Stripe top-up session: credits what was paid, in JPY, only when paid", () => {
    const base = {
      id: "cs_9",
      payment_status: "paid",
      amount_total: 3000,
      currency: "jpy",
      metadata: { userId: "u", kind: "topup", amount: "3000" },
    };
    expect(topupFromSession(base)).toEqual({
      status: "paid",
      paymentId: "cs_9",
      amount: 3000,
      userId: "u",
    });
    expect(topupFromSession({ ...base, payment_status: "unpaid" }).status).toBe("ignored");
    expect(topupFromSession({ ...base, currency: "usd" }).status).toBe("ignored");
    expect(topupFromSession({ ...base, metadata: { userId: "u" } }).status).toBe("ignored");
  });
  test("the Stripe checkout for a top-up carries kind and amount", () => {
    const p = checkoutParams({
      purchase: { kind: "topup", amount: 1200 },
      userId: "u",
      successUrl: "https://x/ok",
      cancelUrl: "https://x/no",
    });
    expect(p.metadata).toEqual({ userId: "u", kind: "topup", amount: "1200" });
    expect(p.line_items[0].price_data).toMatchObject({ currency: "jpy", unit_amount: 1200 });
    expect(p.payment_method_options.card).toEqual({ request_three_d_secure: "any" });
  });
});

describe("spending on passes", () => {
  test("debits the price and extends Pro in one go", async () => {
    const { d1, add, pro, sum } = setup();
    add("u");
    await creditTopup(d1, { userId: "u", amount: 1200, provider: "stripe", paymentId: "a" }, NOW);
    const r = await buyPassWithCredits(d1, "u", "pro-1m", "key-00000001", NOW);
    expect(r).toEqual({ status: "applied", balance: 600, proEndsAt: plus(31).toISOString() });
    expect(pro("u")).toBe(plus(31).toISOString());
    expect(sum("u")).toBe(600);
  });
  test("stacks on running Pro", async () => {
    const { d1, add, pro } = setup();
    add("u", plus(10).toISOString());
    await creditTopup(d1, { userId: "u", amount: 600, provider: "stripe", paymentId: "a" }, NOW);
    await buyPassWithCredits(d1, "u", "pro-1m", "key-00000001", NOW);
    expect(pro("u")).toBe(plus(41).toISOString());
  });
  test("a retried request (same key) buys once", async () => {
    const { d1, add, pro } = setup();
    add("u");
    await creditTopup(d1, { userId: "u", amount: 1200, provider: "stripe", paymentId: "a" }, NOW);
    await buyPassWithCredits(d1, "u", "pro-1m", "key-00000001", NOW);
    const again = await buyPassWithCredits(d1, "u", "pro-1m", "key-00000001", NOW);
    expect(again.status).toBe("duplicate");
    expect(await getBalance(d1, "u")).toBe(600);
    expect(pro("u")).toBe(plus(31).toISOString());
  });
  test("short balance: says how much is missing, changes nothing", async () => {
    const { d1, add, pro } = setup();
    add("u");
    await creditTopup(d1, { userId: "u", amount: 1000, provider: "stripe", paymentId: "a" }, NOW);
    expect(await buyPassWithCredits(d1, "u", "pro-12m", "key-00000001", NOW)).toEqual({
      status: "insufficient",
      balance: 1000,
      price: 5000,
      missing: 4000,
    });
    expect(await getBalance(d1, "u")).toBe(1000);
    expect(pro("u")).toBeNull();
    expect(await ledger(d1, "u")).toHaveLength(1);
  });
  test("an empty wallet cannot buy", async () => {
    const { d1, add } = setup();
    add("u");
    const r = await buyPassWithCredits(d1, "u", "pro-1m", "key-00000001", NOW);
    expect(r).toMatchObject({ status: "insufficient", balance: 0, missing: 600 });
  });
  test("unknown pass", async () => {
    const { d1, add } = setup();
    add("u");
    expect(await buyPassWithCredits(d1, "u", "pro-forever", "key-00000001", NOW)).toEqual({
      status: "rejected",
      reason: "unknown pass",
    });
  });
  test("atomic: an overdraft that slips past the pre-check rolls back the Pro extension", async () => {
    // Two spends racing: both read 600, both try to take 600. The CHECK on the
    // cached balance lets one through and rolls the other back entirely.
    const { d1, add, pro, sum } = setup();
    add("u");
    await creditTopup(d1, { userId: "u", amount: 600, provider: "stripe", paymentId: "a" }, NOW);
    const [a, b] = await Promise.all([
      buyPassWithCredits(d1, "u", "pro-1m", "key-0000000a", NOW),
      buyPassWithCredits(d1, "u", "pro-1m", "key-0000000b", NOW),
    ]);
    expect([a.status, b.status].sort()).toEqual(["applied", "insufficient"]);
    expect(await getBalance(d1, "u")).toBe(0);
    expect(sum("u")).toBe(0);
    expect(pro("u")).toBe(plus(31).toISOString()); // extended once, not twice
    expect((await ledger(d1, "u")).filter((e) => e.reason === "pass")).toHaveLength(1);
  });
  test("the balance can never go negative, whatever the entry", async () => {
    const { d1, add } = setup();
    add("u");
    expect(
      await applyCredit(d1, { userId: "u", amount: -1, reason: "adjust", refId: "r1" }, NOW),
    ).toEqual({ status: "insufficient", balance: 0 });
    await applyCredit(d1, { userId: "u", amount: 500, reason: "sponsor", refId: "r2" }, NOW);
    expect(
      (await applyCredit(d1, { userId: "u", amount: -501, reason: "adjust", refId: "r3" }, NOW))
        .status,
    ).toBe("insufficient");
    expect(await getBalance(d1, "u")).toBe(500);
    expect(await ledger(d1, "u")).toHaveLength(1);
  });
});

describe("refunds", () => {
  test("a credit-bought pass back to the wallet, its days taken off, once", async () => {
    const { d1, add, pro } = setup();
    add("u", plus(5).toISOString());
    await creditTopup(d1, { userId: "u", amount: 600, provider: "stripe", paymentId: "a" }, NOW);
    await buyPassWithCredits(d1, "u", "pro-1m", "key-00000001", NOW);
    expect(pro("u")).toBe(plus(36).toISOString());
    const later = plus(1);
    expect(await refundPassToCredits(d1, "u:key-00000001", later)).toEqual({
      status: "refunded",
      amount: 600,
      balance: 600,
    });
    expect(pro("u")).toBe(plus(5).toISOString());
    expect(await refundPassToCredits(d1, "u:key-00000001", later)).toEqual({
      status: "duplicate",
    });
    expect(await getBalance(d1, "u")).toBe(600);
  });
  test("taking days off never sets Pro before now", async () => {
    const { d1, add, pro } = setup();
    add("u");
    await creditTopup(d1, { userId: "u", amount: 600, provider: "stripe", paymentId: "a" }, NOW);
    await buyPassWithCredits(d1, "u", "pro-1m", "key-00000001", NOW);
    const later = plus(20);
    await refundPassToCredits(d1, "u:key-00000001", later);
    expect(pro("u")).toBe(later.toISOString());
  });
  test("reversing a top-up refunded at the provider — unless already spent", async () => {
    const { d1, add } = setup();
    add("u");
    await creditTopup(d1, { userId: "u", amount: 600, provider: "stripe", paymentId: "a" }, NOW);
    await creditTopup(d1, { userId: "u", amount: 600, provider: "stripe", paymentId: "b" }, NOW);
    await buyPassWithCredits(d1, "u", "pro-1m", "key-00000001", NOW);
    expect(await reverseTopup(d1, "stripe:a", NOW)).toMatchObject({ status: "refunded" });
    expect(await getBalance(d1, "u")).toBe(0);
    expect(await reverseTopup(d1, "stripe:a", NOW)).toEqual({ status: "duplicate" });
    expect(await reverseTopup(d1, "stripe:b", NOW)).toEqual({ status: "insufficient", balance: 0 });
    expect(await reverseTopup(d1, "stripe:nope", NOW)).toEqual({ status: "not found" });
  });
});

describe("gift codes with credits", () => {
  test("credits and days arrive together, once per person", async () => {
    const { d1, add, pro } = setup();
    add("u");
    const code = await createGiftCode(d1, "owner", { days: 0, credits: 1200, maxUses: 5 }, NOW);
    expect(await redeemGiftCode(d1, "u", code, NOW)).toEqual({
      status: "redeemed",
      days: 0,
      credits: 1200,
    });
    expect(await getBalance(d1, "u")).toBe(1200);
    expect(pro("u")).toBeNull();
    expect((await redeemGiftCode(d1, "u", code, NOW)).status).toBe("rejected");
    expect(await getBalance(d1, "u")).toBe(1200);
    expect((await ledger(d1, "u"))[0]).toMatchObject({ reason: "gift", amount: 1200 });
  });
});

describe("providers", () => {
  test("enabled only when implemented and every secret is set", () => {
    const stripe = PROVIDERS.find((p) => p.id === "stripe")!;
    expect(providerEnabled(stripe, {})).toBe(false);
    expect(providerEnabled(stripe, { STRIPE_SECRET_KEY: "sk" })).toBe(false);
    expect(providerEnabled(stripe, { STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh" })).toBe(
      true,
    );
    // A reserved slot stays hidden even with its secrets set.
    const komoju = PROVIDERS.find((p) => p.id === "komoju")!;
    expect(providerEnabled(komoju, { KOMOJU_SECRET_KEY: "k", KOMOJU_WEBHOOK_SECRET: "w" })).toBe(
      false,
    );
    expect(enabledProviders({}).map((p) => p.id)).toEqual([]);
  });
  test("every slot is registered once, checkout slots can start a payment", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining(["stripe", "komoju", "payjp", "paddle", "usdt", "afdian", "patreon"]),
    );
    for (const p of PROVIDERS.filter((p) => p.implemented && p.kind === "checkout"))
      expect(typeof p.createTopup).toBe("function");
  });
});

describe("provider adapters", () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  afterEach(() => {
    process.env = { ...saved };
    globalThis.fetch = realFetch;
  });

  test("lookup and the public view (no env names leak)", () => {
    expect(providerFor("stripe")).toBe(stripeProvider);
    expect(providerFor("nope")).toBeNull();
    expect(publicProvider(stripeProvider)).toEqual({
      id: "stripe",
      label: "Stripe",
      methods: ["Card", "Alipay", "WeChat Pay"],
      kind: "checkout",
    });
  });

  test("a reserved slot never verifies a webhook", async () => {
    for (const p of PROVIDERS.filter((p) => !p.implemented))
      expect(await p.verifyWebhook(new Request("https://x", { method: "POST" }))).toEqual({
        status: "invalid",
      });
  });

  test("Stripe createTopup redirects to a Checkout Session for the amount", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test";
    let body = "";
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return Response.json({ url: "https://checkout.stripe.com/c/pay/cs_t" });
    }) as unknown as typeof fetch;
    const start = await stripeProvider.createTopup!(
      3000,
      { id: "u", email: "u@x.com" },
      { successUrl: "https://x/ok", cancelUrl: "https://x/no" },
    );
    expect(start).toEqual({ kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_t" });
    expect(body).toContain("metadata%5Bkind%5D=topup");
    expect(body).toContain("unit_amount%5D=3000");
  });

  test("Stripe verifyWebhook: signed top-up → paid; bad signature → invalid", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_t";
    const event = (type: string) =>
      JSON.stringify({
        type,
        data: {
          object: {
            id: "cs_w",
            payment_status: "paid",
            amount_total: 600,
            currency: "jpy",
            metadata: { userId: "u", kind: "topup", amount: "600" },
          },
        },
      });
    const signed = async (body: string, secret = "whsec_t") => {
      const t = Math.floor(Date.now() / 1000);
      return new Request("https://x", {
        method: "POST",
        body,
        headers: { "stripe-signature": `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}` },
      });
    };
    expect(
      await stripeProvider.verifyWebhook(await signed(event("checkout.session.completed"))),
    ).toEqual({ status: "paid", paymentId: "cs_w", amount: 600, userId: "u" });
    expect(
      (await stripeProvider.verifyWebhook(await signed(event("charge.refunded")))).status,
    ).toBe("ignored");
    expect(
      await stripeProvider.verifyWebhook(
        await signed(event("checkout.session.completed"), "other"),
      ),
    ).toEqual({ status: "invalid" });
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(
      await stripeProvider.verifyWebhook(await signed(event("checkout.session.completed"))),
    ).toEqual({ status: "invalid" });
  });
});

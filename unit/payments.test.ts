import { afterEach, describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { fulfilCheckout, type CheckoutSessionLike } from "@/lib/payments/fulfil";
import { extendedProEnd, passFor, PASSES } from "@/lib/payments/passes";
import {
  checkoutParams,
  createCheckoutSession,
  stripeEnabled,
  formEncode,
  hmacSha256Hex,
  verifyStripeSignature,
} from "@/lib/payments/stripe";

/**
 * Prepaid Pro passes. Money is taken by Stripe before any of this runs, so the
 * failure that matters is a paid session that grants nothing, or grants twice.
 */
const NOW = new Date("2026-11-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("extendedProEnd", () => {
  test("starts from now when there is no Pro", () => {
    expect(extendedProEnd(undefined, 31, NOW)).toEqual(new Date(NOW.getTime() + 31 * DAY));
  });
  test("starts from now when Pro has lapsed", () => {
    const lapsed = new Date(NOW.getTime() - 5 * DAY);
    expect(extendedProEnd(lapsed, 31, NOW)).toEqual(new Date(NOW.getTime() + 31 * DAY));
  });
  test("stacks on running Pro, so renewing early loses nothing", () => {
    const running = new Date(NOW.getTime() + 10 * DAY);
    expect(extendedProEnd(running, 31, NOW)).toEqual(new Date(NOW.getTime() + 41 * DAY));
  });
});

describe("passFor", () => {
  test("knows the catalog and nothing else", () => {
    expect(passFor("pro-1m")).toBe(PASSES["pro-1m"]);
    expect(passFor("pro-forever")).toBeNull();
    expect(passFor("toString")).toBeNull();
    expect(passFor(undefined)).toBeNull();
  });
});

describe("checkout params", () => {
  test("a one-time JPY payment carrying the user and pass", () => {
    const p = checkoutParams({
      pass: PASSES["pro-12m"],
      userId: "u1",
      email: "a@b.c",
      successUrl: "https://x/ok",
      cancelUrl: "https://x/no",
    });
    expect(p.mode).toBe("payment");
    expect(p.metadata).toEqual({ userId: "u1", passId: "pro-12m" });
    expect(p.line_items[0].price_data).toMatchObject({ currency: "jpy", unit_amount: 5000 });
    expect(p.payment_method_types).toEqual(["card", "alipay", "wechat_pay"]);
    expect(p.payment_method_options).toEqual({
      card: { request_three_d_secure: "any" },
      wechat_pay: { client: "web" },
    });
  });
  test("form-encodes nested objects and arrays the way Stripe reads them", () => {
    const body = formEncode({ a: { b: ["x", "y"] }, c: "d e", skip: undefined }).join("&");
    expect(body).toBe("a%5Bb%5D%5B0%5D=x&a%5Bb%5D%5B1%5D=y&c=d%20e");
  });
});

describe("verifyStripeSignature", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1"}';
  const t = 1_800_000_000;
  const sign = async (ts: number, b = body) =>
    `t=${ts},v1=${await hmacSha256Hex(secret, `${ts}.${b}`)}`;

  test("accepts Stripe's signature", async () => {
    expect(await verifyStripeSignature(body, await sign(t), secret, t + 10)).toBe(true);
  });
  test("accepts when any of several v1 signatures matches (secret rotation)", async () => {
    const good = await sign(t);
    expect(
      await verifyStripeSignature(body, `t=${t},v1=deadbeef,${good.split(",")[1]}`, secret, t),
    ).toBe(true);
  });
  test("rejects a changed body", async () => {
    expect(await verifyStripeSignature('{"id":"evt_2"}', await sign(t), secret, t)).toBe(false);
  });
  test("rejects a replay outside five minutes", async () => {
    expect(await verifyStripeSignature(body, await sign(t), secret, t + 301)).toBe(false);
  });
  test("rejects a missing or malformed header", async () => {
    expect(await verifyStripeSignature(body, null, secret, t)).toBe(false);
    expect(await verifyStripeSignature(body, "v1=abc", secret, t)).toBe(false);
  });
});

describe("fulfilCheckout", () => {
  function setup(proEndsAt: string | null = null) {
    const d1 = createTestD1(testSchema());
    d1.raw()
      .prepare(
        "INSERT INTO user (id, email, createdAt, updatedAt, proEndsAt) VALUES ('u1', 'a@b.c', ?, ?, ?)",
      )
      .run(NOW.toISOString(), NOW.toISOString(), proEndsAt);
    return d1;
  }
  const session = (over: Partial<CheckoutSessionLike> = {}): CheckoutSessionLike => ({
    id: "cs_1",
    payment_status: "paid",
    amount_total: 600,
    currency: "jpy",
    client_reference_id: "u1",
    metadata: { userId: "u1", passId: "pro-1m" },
    ...over,
  });
  const proEnd = (d1: ReturnType<typeof setup>) =>
    (d1.raw().prepare("SELECT proEndsAt FROM user WHERE id = 'u1'").get() as { proEndsAt: string })
      .proEndsAt;

  test("a paid session grants the pass and records the payment", async () => {
    const d1 = setup();
    const r = await fulfilCheckout(d1, session(), NOW);
    expect(r.status).toBe("applied");
    expect(proEnd(d1)).toBe(new Date(NOW.getTime() + 31 * DAY).toISOString());
    const row = d1.raw().prepare("SELECT * FROM payment").get() as Record<string, unknown>;
    expect(row).toMatchObject({ id: "cs_1", userId: "u1", passId: "pro-1m", amount: 600 });
  });

  test("a redelivered webhook grants once", async () => {
    const d1 = setup();
    await fulfilCheckout(d1, session(), NOW);
    const again = await fulfilCheckout(d1, session(), new Date(NOW.getTime() + DAY));
    expect(again.status).toBe("duplicate");
    expect(proEnd(d1)).toBe(new Date(NOW.getTime() + 31 * DAY).toISOString());
  });

  test("a second purchase stacks on the first", async () => {
    const d1 = setup();
    await fulfilCheckout(d1, session(), NOW);
    await fulfilCheckout(
      d1,
      session({ id: "cs_2", metadata: { userId: "u1", passId: "pro-12m" } }),
      NOW,
    );
    expect(proEnd(d1)).toBe(new Date(NOW.getTime() + (31 + 366) * DAY).toISOString());
  });

  test("an unpaid session (async method still pending) grants nothing yet", async () => {
    const d1 = setup();
    const r = await fulfilCheckout(d1, session({ payment_status: "unpaid" }), NOW);
    expect(r.status).toBe("ignored");
    expect(proEnd(d1)).toBeNull();
  });

  test("an unknown pass or user is ignored, not thrown (no endless retries)", async () => {
    const d1 = setup();
    expect(
      (await fulfilCheckout(d1, session({ metadata: { userId: "u1", passId: "x" } }), NOW)).status,
    ).toBe("ignored");
    expect(
      (
        await fulfilCheckout(
          d1,
          session({
            id: "cs_9",
            client_reference_id: null,
            metadata: { userId: "nobody", passId: "pro-1m" },
          }),
          NOW,
        )
      ).status,
    ).toBe("ignored");
  });
});

describe("stripe switches and the checkout call", () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  afterEach(() => {
    process.env = { ...saved };
    globalThis.fetch = realFetch;
  });
  const input = {
    pass: PASSES["pro-1m"],
    userId: "u1",
    successUrl: "https://x/ok",
    cancelUrl: "https://x/no",
  };

  test("off unless both secrets are set", () => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec";
    expect(stripeEnabled()).toBe(false);
    process.env.STRIPE_SECRET_KEY = "sk_test";
    expect(stripeEnabled()).toBe(true);
  });

  test("STRIPE_PAYMENT_METHODS narrows the offered methods", () => {
    process.env.STRIPE_PAYMENT_METHODS = "card, alipay";
    const p = checkoutParams(input);
    expect(p.payment_method_types).toEqual(["card", "alipay"]);
    expect(p.payment_method_options).toEqual({ card: { request_three_d_secure: "any" } });
  });

  test("returns the hosted URL Stripe answers with", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test";
    let sent: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = init;
      return Response.json({ url: "https://checkout.stripe.com/c/pay/cs_1" });
    }) as unknown as typeof fetch;
    expect(await createCheckoutSession(input)).toBe("https://checkout.stripe.com/c/pay/cs_1");
    expect((sent?.headers as Record<string, string>).Authorization).toBe("Bearer sk_test");
    expect(String(sent?.body)).toContain("metadata%5BpassId%5D=pro-1m");
    // 3-D Secure is asked for on the wire, not just in the params object.
    expect(String(sent?.body)).toContain(
      "payment_method_options%5Bcard%5D%5Brequest_three_d_secure%5D=any",
    );
  });

  test("throws with Stripe's message on an error", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test";
    globalThis.fetch = (async () =>
      Response.json(
        { error: { message: "alipay not enabled" } },
        { status: 400 },
      )) as unknown as typeof fetch;
    await expect(createCheckoutSession(input)).rejects.toThrow("alipay not enabled");
  });
});

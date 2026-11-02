import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  creditTopup,
  getBalance,
  getTestBalance,
  ledger,
  refundProviderTopup,
  testLedger,
} from "@/lib/payments/credits-store";
import {
  komojuKeyMode,
  komojuMode,
  komojuProvider,
  sessionParams,
  topupFromPayment,
} from "@/lib/payments/providers/komoju";
import {
  providerMode,
  providerOpenTo,
  providersFor,
  publicProvider,
} from "@/lib/payments/providers";
import { stripeProvider } from "@/lib/payments/providers/stripe";
import { hmacSha256Hex } from "@/lib/payments/stripe";
import { handleProviderWebhook } from "@/lib/payments/webhook";

/**
 * KOMOJU, and the shared webhook handler. What matters: nothing is live unless
 * the owner set a live key and turned the payments.komoju.live flag on; a test-mode payment credits the owner only; the
 * amount and user come from the KOMOJU API (the session this server made), not
 * from the webhook body; a redelivery credits once; a refund takes it back once.
 */
const NOW = new Date("2026-11-01T00:00:00.000Z");
const OWNER = "owner@x.com";
const WH = "komoju_wh_secret";

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
    delete process.env.KOMOJU_SECRET_KEY;
    delete process.env.KOMOJU_WEBHOOK_SECRET;
    return;
  }
  process.env.KOMOJU_SECRET_KEY = key ?? (mode === "live" ? "sk_live_x" : "sk_test_x");
  process.env.KOMOJU_WEBHOOK_SECRET = WH;
}
const LIVE = { "payments.komoju.live": true } as const;

function setup() {
  const d1 = createTestD1(testSchema());
  for (const [id, email] of [
    ["owner", OWNER],
    ["u", "u@x.com"],
  ])
    d1.raw()
      .prepare("INSERT INTO user (id, email, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
      .run(id, email, NOW.toISOString(), NOW.toISOString());
  return d1;
}

/** A fake KOMOJU API: payments and sessions by id; records every call. */
function fakeApi(
  payments: Record<string, unknown>,
  sessions: Record<string, unknown> = {},
  status = 200,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (status !== 200) return Response.json({ error: { message: "nope" } }, { status });
    const m = /\/api\/v1\/(payments|sessions)(?:\/([^/]+))?$/.exec(url);
    if (m?.[1] === "sessions" && !m[2])
      return Response.json({ id: "s_new", session_url: "https://komoju.com/sessions/s_new" });
    const obj = m?.[1] === "payments" ? payments[m[2]] : sessions[m?.[2] ?? ""];
    return obj ? Response.json(obj) : Response.json({ error: { message: "nf" } }, { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

async function delivery(type: string, id: string, secret = WH, extra: object = {}) {
  const body = JSON.stringify({ id: "ev_1", type, resource: "event", data: { id, ...extra } });
  return new Request("https://lianki.com/api/payments/webhook/komoju", {
    method: "POST",
    body,
    headers: { "x-komoju-signature": await hmacSha256Hex(secret, body) },
  });
}

const session = (userId: string, amount = 600) => ({
  id: "s_1",
  amount,
  currency: "JPY",
  metadata: { userId, kind: "topup", amount: String(amount) },
});
const payment = (over: object = {}) => ({
  id: "p_1",
  status: "captured",
  amount: 600,
  total: 790, // + the konbini fee the payer covers — never credited
  currency: "JPY",
  session: "s_1",
  ...over,
});

describe("mode", () => {
  test("test with the flag off, live only with the flag on, off on a contradiction", () => {
    const base = { KOMOJU_SECRET_KEY: "sk_test_a", KOMOJU_WEBHOOK_SECRET: "w" };
    const liveKey = { ...base, KOMOJU_SECRET_KEY: "sk_live_a" };
    expect(komojuMode({})).toBeNull();
    expect(komojuMode({ KOMOJU_SECRET_KEY: "sk_test_a" })).toBeNull();
    expect(komojuMode(base)).toBe("test");
    expect(komojuMode(base, LIVE)).toBeNull(); // test key, live flag
    expect(komojuMode(liveKey)).toBeNull(); // live key, flag off: no test mode on a live key
    expect(komojuMode(liveKey, LIVE)).toBe("live");
    expect(komojuMode({ ...liveKey, KOMOJU_LIVE: "1" })).toBeNull(); // the old env switch is gone
    expect(komojuMode(liveKey, { "payments.stripe.live": true })).toBeNull(); // Stripe's flag
    // The webhook settles by the key alone.
    expect(komojuKeyMode(liveKey)).toBe("live");
    expect(komojuKeyMode(base)).toBe("test");
    expect(komojuKeyMode({})).toBeNull();
    // Fail closed: a key whose format does not prove its mode is off either way
    // (KOMOJU's docs show non-prefixed test credentials such as this one).
    for (const k of ["degica-mart-test", "sk_abc", "pk_test_a", "SK_TEST_A"]) {
      expect(komojuMode({ ...base, KOMOJU_SECRET_KEY: k })).toBeNull();
      expect(komojuMode({ ...base, KOMOJU_SECRET_KEY: k }, LIVE)).toBeNull();
      expect(komojuKeyMode({ ...base, KOMOJU_SECRET_KEY: k })).toBeNull();
    }
  });

  test("a test-mode provider is the owner's alone; live is everyone's", () => {
    const test = {
      KOMOJU_SECRET_KEY: "sk_test_a",
      KOMOJU_WEBHOOK_SECRET: "w",
      OWNER_EMAILS: OWNER,
    };
    expect(providerMode(komojuProvider, test)).toBe("test");
    expect(providerOpenTo(komojuProvider, OWNER, test)).toBe(true);
    expect(providerOpenTo(komojuProvider, "u@x.com", test)).toBe(false);
    expect(providerOpenTo(komojuProvider, null, test)).toBe(false);
    expect(providersFor("u@x.com", test).map((p) => p.id)).toEqual([]);
    expect(providersFor(OWNER, test).map((p) => p.id)).toEqual(["komoju"]);
    expect(publicProvider(komojuProvider, test).label).toBe("KOMOJU (test)");
    const live = { ...test, KOMOJU_SECRET_KEY: "sk_live_a" };
    expect(providerOpenTo(komojuProvider, "u@x.com", live, LIVE)).toBe(true);
    expect(providerOpenTo(komojuProvider, "u@x.com", live)).toBe(false);
    expect(providerOpenTo(komojuProvider, OWNER, live)).toBe(false);
    expect(publicProvider(komojuProvider, live, LIVE).label).toBe("KOMOJU");
    // Stripe has its own mode (unit/stripe-mode.test.ts): a key that proves nothing is off.
    expect(
      providerMode(stripeProvider, { STRIPE_SECRET_KEY: "a", STRIPE_WEBHOOK_SECRET: "b" }),
    ).toBeNull();
    expect(providerOpenTo(komojuProvider, OWNER, {})).toBe(false);
  });
});

describe("createTopup", () => {
  test("creates a JPY session for the server's amount, user in its metadata", async () => {
    env("test");
    const calls = fakeApi({});
    const start = await komojuProvider.createTopup!(
      1200,
      { id: "u", email: "u@x.com" },
      { successUrl: "https://lianki.com/membership?topup=1", cancelUrl: "https://x/no" },
      "test",
    );
    expect(start).toEqual({ kind: "redirect", url: "https://komoju.com/sessions/s_new" });
    expect(calls[0].url).toBe("https://komoju.com/api/v1/sessions");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({
      amount: 1200,
      currency: "JPY",
      return_url: "https://lianki.com/membership?topup=1",
      email: "u@x.com",
      metadata: { userId: "u", kind: "topup", amount: "1200" },
    });
    const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${btoa("sk_test_x:")}`);
    expect(sessionParams(600, "u", undefined, "https://r").email).toBeUndefined();
  });

  test("an API error or a session without a URL throws (the route answers 502)", async () => {
    env("test");
    fakeApi({}, {}, 422);
    const urls = { successUrl: "https://x", cancelUrl: "https://x" };
    await expect(komojuProvider.createTopup!(600, { id: "u" }, urls, "test")).rejects.toThrow(
      "422",
    );
    globalThis.fetch = (async () => Response.json({ id: "s" })) as unknown as typeof fetch;
    await expect(komojuProvider.createTopup!(600, { id: "u" }, urls, "test")).rejects.toThrow(
      "session_url",
    );
    globalThis.fetch = (async () =>
      new Response("oops", { status: 500 })) as unknown as typeof fetch;
    await expect(komojuProvider.createTopup!(600, { id: "u" }, urls, "test")).rejects.toThrow(
      "500",
    );
  });
});

describe("reading a payment", () => {
  test("credits the captured JPY amount, not the total, for the session's user", () => {
    expect(topupFromPayment(payment(), session("u"))).toEqual({
      status: "paid",
      paymentId: "p_1",
      amount: 600,
      userId: "u",
    });
  });
  test("anything off is ignored", () => {
    const s = session("u");
    const why = (p: object, ss: object | null = s) =>
      (topupFromPayment(payment(p), ss as never) as { reason?: string }).reason;
    expect(why({ status: "authorized" })).toBe("status authorized");
    expect(why({ currency: "USD" })).toBe("not JPY");
    expect(why({ amount: 0 })).toBe("no amount");
    expect(why({ amount: 1.5 })).toBe("no amount");
    expect(why({}, { ...s, metadata: { userId: "u", amount: "600" } })).toBe("not a top-up");
    expect(why({}, { ...s, metadata: { kind: "topup", amount: "600" } })).toBe("not a top-up");
    expect(why({}, null)).toBe("not a top-up");
    // Paid less than the session this server created asked for.
    expect(why({ amount: 300 })).toBe("amount mismatch");
    expect(why({}, { ...s, amount: 900 })).toBe("session mismatch");
    expect(why({}, { ...s, currency: "USD" })).toBe("session mismatch");
    // Without a session, the payment's own metadata (copied by KOMOJU) will do.
    expect(
      topupFromPayment(payment({ metadata: session("u").metadata, session: null }), null).status,
    ).toBe("paid");
  });
});

describe("webhook", () => {
  let d1: ReturnType<typeof setup>;
  beforeEach(() => {
    d1 = setup();
  });

  test("off without secrets, or on a key that contradicts the mode → 503", async () => {
    env("none");
    expect(
      (await handleProviderWebhook(d1, komojuProvider, await delivery("ping", "x"))).status,
    ).toBe(503);
    expect(await komojuProvider.verifyWebhook(await delivery("ping", "x"))).toEqual({
      status: "invalid",
    });
    env("test", "degica-mart-test");
    expect(
      (await handleProviderWebhook(d1, komojuProvider, await delivery("ping", "x"))).status,
    ).toBe(503);
  });

  test("a bad or missing signature, or a body that is not JSON → 400, no API call", async () => {
    env("live");
    const calls = fakeApi({ p_1: payment() }, { s_1: session("u") });
    const bad = await delivery("payment.captured", "p_1", "other");
    expect((await handleProviderWebhook(d1, komojuProvider, bad)).status).toBe(400);
    const unsigned = new Request("https://x", { method: "POST", body: "{}" });
    expect((await handleProviderWebhook(d1, komojuProvider, unsigned)).status).toBe(400);
    const junk = "not json";
    const signedJunk = new Request("https://x", {
      method: "POST",
      body: junk,
      headers: { "x-komoju-signature": await hmacSha256Hex(WH, junk) },
    });
    expect((await handleProviderWebhook(d1, komojuProvider, signedJunk)).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(await getBalance(d1, "u")).toBe(0);
  });

  test("live: a captured payment credits once, from the API's numbers", async () => {
    env("live");
    const calls = fakeApi({ p_1: payment() }, { s_1: session("u") });
    // The webhook body claims more; the API's 600 is what counts.
    const d = () => delivery("payment.captured", "p_1", WH, { amount: 99999 });
    const r = await handleProviderWebhook(d1, komojuProvider, await d(), NOW);
    expect(r).toEqual({ status: 200, body: { received: true, status: "applied" } });
    expect(await getBalance(d1, "u")).toBe(600);
    expect(calls.map((c) => c.url)).toEqual([
      "https://komoju.com/api/v1/payments/p_1",
      "https://komoju.com/api/v1/sessions/s_1",
    ]);
    // Redelivered: no second credit.
    expect((await handleProviderWebhook(d1, komojuProvider, await d(), NOW)).body.status).toBe(
      "duplicate",
    );
    expect(await getBalance(d1, "u")).toBe(600);
    expect((await ledger(d1, "u"))[0]).toMatchObject({ refId: "komoju:p_1", note: null });
  });

  test("a payment for an unknown user, or one ignored, credits nothing", async () => {
    env("live");
    fakeApi(
      { p_1: payment(), p_2: payment({ id: "p_2", status: "pending" }) },
      { s_1: session("ghost") },
    );
    expect(
      (await handleProviderWebhook(d1, komojuProvider, await delivery("payment.captured", "p_1")))
        .body.status,
    ).toBe("no user");
    expect(
      (await handleProviderWebhook(d1, komojuProvider, await delivery("payment.captured", "p_2")))
        .body.status,
    ).toBe("ignored");
    // Other events and odd ids never reach the API.
    for (const d of [
      await delivery("payment.authorized", "p_1"),
      await delivery("ping", "w"),
      await delivery("", "w"),
      await delivery("payment.captured", "../../sessions"),
    ])
      expect((await handleProviderWebhook(d1, komojuProvider, d)).body.status).toBe("ignored");
  });

  test("test mode: records the owner's in the test ledger only, never anyone else's", async () => {
    env("test");
    fakeApi(
      { p_1: payment(), p_2: payment({ id: "p_2", session: { id: "s_2" } }) },
      { s_1: session("u"), s_2: { ...session("owner"), id: "s_2" } },
    );
    const forU = await handleProviderWebhook(
      d1,
      komojuProvider,
      await delivery("payment.captured", "p_1"),
      NOW,
    );
    expect(forU.body.status).toBe("ignored");
    expect(await getBalance(d1, "u")).toBe(0);
    const forOwner = await handleProviderWebhook(
      d1,
      komojuProvider,
      await delivery("payment.captured", "p_2"),
      NOW,
    );
    expect(forOwner.body.status).toBe("applied");
    // Kept apart: not spendable balance, not in the real ledger.
    expect(await getBalance(d1, "owner")).toBe(0);
    expect(await ledger(d1, "owner")).toEqual([]);
    expect(await getTestBalance(d1, "owner")).toBe(600);
    expect((await testLedger(d1, "owner"))[0]).toMatchObject({
      amount: 600,
      reason: "topup",
      refId: "komoju:p_2",
    });
    // A full refund in test mode takes it back from the test ledger, once.
    fakeApi({ p_2: payment({ id: "p_2", status: "refunded" }) });
    const ref = () => delivery("payment.refunded", "p_2");
    expect((await handleProviderWebhook(d1, komojuProvider, await ref(), NOW)).body.status).toBe(
      "refunded",
    );
    expect((await handleProviderWebhook(d1, komojuProvider, await ref(), NOW)).body.status).toBe(
      "duplicate",
    );
    expect(await getTestBalance(d1, "owner")).toBe(0);
    expect(await getBalance(d1, "owner")).toBe(0);
  });

  test("an API failure while re-reading is a throw (500, KOMOJU retries)", async () => {
    env("live");
    fakeApi({}, {}, 503);
    await expect(
      handleProviderWebhook(d1, komojuProvider, await delivery("payment.captured", "p_1")),
    ).rejects.toThrow("503");
  });

  test("a full refund takes the top-up back once; spent credits are flagged, not overdrawn", async () => {
    env("live");
    await creditTopup(d1, { userId: "u", amount: 600, provider: "komoju", paymentId: "p_1" }, NOW);
    await creditTopup(d1, { userId: "u", amount: 600, provider: "komoju", paymentId: "p_2" }, NOW);
    fakeApi({
      p_1: payment({ status: "refunded" }),
      p_2: payment({ id: "p_2", status: "refunded" }),
      p_3: payment({ id: "p_3", status: "captured" }),
    });
    const refund = async (id: string) =>
      (await handleProviderWebhook(d1, komojuProvider, await delivery("payment.refunded", id), NOW))
        .body.status;
    expect(await refund("p_1")).toBe("refunded");
    expect(await getBalance(d1, "u")).toBe(600);
    expect(await refund("p_1")).toBe("duplicate");
    // Not actually refunded at KOMOJU: nothing changes.
    expect(await refund("p_3")).toBe("ignored");
    // Spend what is left, then refund p_2: refused, the balance stays ≥ 0.
    d1.raw().prepare("UPDATE credit_balance SET balance = 0 WHERE userId = 'u'").run();
    expect(await refund("p_2")).toBe("insufficient");
    // Unknown at KOMOJU (404): a throw, so KOMOJU retries rather than losing it.
    await expect(refund("p_9")).rejects.toThrow("404");
  });

  test("refund lands while a capture is held mid-read: the late capture never credits", async () => {
    env("live");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let sawPayment!: () => void;
    const paymentRead = new Promise<void>((r) => (sawPayment = r));
    let refunded = false;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/payments/p_1")) {
        // The capture's read saw "captured"; the refund's read sees "refunded".
        const status = refunded ? "refunded" : "captured";
        sawPayment();
        return Response.json(payment({ status }));
      }
      if (url.endsWith("/sessions/s_1")) {
        await held; // the capture pauses here, holding a stale "paid" snapshot
        return Response.json(session("u"));
      }
      return Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;

    const capture = handleProviderWebhook(
      d1,
      komojuProvider,
      await delivery("payment.captured", "p_1"),
      NOW,
    );
    await paymentRead;
    refunded = true;
    const refund = await handleProviderWebhook(
      d1,
      komojuProvider,
      await delivery("payment.refunded", "p_1"),
      NOW,
    );
    expect(refund.body.status).toBe("marked");
    release();
    expect((await capture).body.status).toBe("refunded");
    expect(await getBalance(d1, "u")).toBe(0);
    expect(await ledger(d1, "u")).toEqual([]);
    // A later redelivery of either changes nothing.
    fakeApi({ p_1: payment({ status: "refunded" }) });
    expect(
      (
        await handleProviderWebhook(
          d1,
          komojuProvider,
          await delivery("payment.refunded", "p_1"),
          NOW,
        )
      ).body.status,
    ).toBe("marked");
    expect(
      (
        await creditTopup(
          d1,
          { userId: "u", amount: 600, provider: "komoju", paymentId: "p_1" },
          NOW,
        )
      ).status,
    ).toBe("refunded");
    expect(await getBalance(d1, "u")).toBe(0);
  });

  test("capture first, then refund: credited, then taken back once", async () => {
    env("live");
    fakeApi({ p_1: payment() }, { s_1: session("u") });
    await handleProviderWebhook(d1, komojuProvider, await delivery("payment.captured", "p_1"), NOW);
    expect(await getBalance(d1, "u")).toBe(600);
    fakeApi({ p_1: payment({ status: "refunded" }) });
    const r = await refundProviderTopup(d1, "komoju:p_1", NOW, "x");
    expect(r).toEqual({ status: "refunded", amount: -600, balance: 0 });
    expect(await refundProviderTopup(d1, "komoju:p_1", NOW)).toEqual({ status: "duplicate" });
    // A redelivered capture credits nothing (the refund's mark blocks it).
    fakeApi({ p_1: payment() }, { s_1: session("u") });
    expect(
      (
        await handleProviderWebhook(
          d1,
          komojuProvider,
          await delivery("payment.captured", "p_1"),
          NOW,
        )
      ).body.status,
    ).toBe("refunded");
    expect(await getBalance(d1, "u")).toBe(0);
  });

  test("a refund for a payment never credited only leaves the mark", async () => {
    expect(await refundProviderTopup(d1, "komoju:none", NOW)).toEqual({ status: "marked" });
  });
});

describe("a flag flip while a payment is in flight", () => {
  test("a konbini payment started live and captured after the kill switch is credited", async () => {
    const d1 = setup();
    env("live");
    // Started while the flag was on…
    expect(komojuMode(process.env, LIVE)).toBe("live");
    // …the owner turns it off: no new session for anyone…
    expect(providerOpenTo(komojuProvider, "u@x.com", process.env, {})).toBe(false);
    expect(providerOpenTo(komojuProvider, OWNER, process.env, {})).toBe(false);
    // …and the capture days later, re-read from the live API, still credits.
    fakeApi({ p_1: payment() }, { s_1: session("u") });
    const r = await handleProviderWebhook(
      d1,
      komojuProvider,
      await delivery("payment.captured", "p_1"),
      NOW,
    );
    expect(r.body.status).toBe("applied");
    expect(await getBalance(d1, "u")).toBe(600);
  });

  test("createTopup refuses a mode the key is not in, before any API call", async () => {
    env("live");
    const calls = fakeApi({});
    const urls = { successUrl: "https://x", cancelUrl: "https://x" };
    await expect(komojuProvider.createTopup!(600, { id: "u" }, urls, "test")).rejects.toThrow(
      "KOMOJU is off",
    );
    env("test");
    await expect(komojuProvider.createTopup!(600, { id: "u" }, urls, "live")).rejects.toThrow(
      "KOMOJU is off",
    );
    expect(calls).toHaveLength(0);
  });
});

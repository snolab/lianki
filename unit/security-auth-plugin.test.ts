import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { securityPlugin, type SecurityPluginEnv } from "@/lib/security/auth-plugin";
import { DEVICE_COOKIE } from "@/lib/security/login-notice";
import type { ThrottleDb } from "@/lib/security/throttle";

/**
 * The security plugin inside a real better-auth instance on the D1 schema:
 * the hooks must see the endpoints' outcomes, set the device cookie, and
 * never break a sign-in.
 */
const BASE = "http://localhost:3000";

function setup(env: Partial<SecurityPluginEnv> = {}) {
  const d1 = createTestD1(testSchema());
  // kysely-d1 reads `meta` from `.all()`, which the node:sqlite shim omits.
  const shim = {
    prepare(q: string) {
      const wrap = (s: ReturnType<typeof d1.prepare>): unknown => ({
        bind: (...v: unknown[]) => wrap(s.bind(...v)),
        all: async () => ({ ...(await s.all()), meta: { changes: 1, last_row_id: 0 } }),
        first: (c?: string) => s.first(c),
        run: () => s.run(),
      });
      return wrap(d1.prepare(q));
    },
  };
  const otps: string[] = [];
  const auth = betterAuth({
    secret: "s".repeat(40),
    baseURL: BASE,
    emailAndPassword: { enabled: true },
    database: kyselyAdapter(
      new Kysely<Record<string, never>>({ dialect: new D1Dialect({ database: shim as never }) }),
      {
        type: "sqlite",
      },
    ),
    plugins: [
      emailOTP({
        otpLength: 6,
        allowedAttempts: 100, // so the account lock, not the per-code limit, is what trips
        sendVerificationOTP: async ({ otp }) => {
          otps.push(otp);
        },
      }),
      securityPlugin({ getDb: () => d1 as unknown as ThrottleDb, ...env }),
    ],
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, ...headers },
        body: JSON.stringify(body),
      }),
    );
  return { d1, auth, post, otps };
}

const deviceCookie = (res: Response) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${DEVICE_COOKIE}=`))
    ?.split(";")[0];

const saved = { ...process.env };
const realFetch = globalThis.fetch;
let mails: { to: string[]; subject: string; text: string }[] = [];

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "Lianki <no-reply@lianki.test>";
  mails = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).startsWith("https://api.resend.com/")) {
      mails.push(JSON.parse(String(init.body)));
      return Response.json({ id: `m${mails.length}` });
    }
    return realFetch(url, init);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  process.env = { ...saved };
  globalThis.fetch = realFetch;
});

describe("login notification through better-auth", () => {
  test("sign-up: device cookie, no mail; new browser later: mail; same browser: none", async () => {
    const { d1, post } = setup();
    const up = await post("/sign-up/email", {
      email: "a@x.com",
      password: "password1234",
      name: "A",
    });
    expect(up.status).toBe(200);
    const cookie = deviceCookie(up);
    expect(cookie).toMatch(/^lk_device=[0-9a-f]{48}$/);
    expect(mails).toHaveLength(0);

    // The account is a day old now.
    d1.raw()
      .prepare("UPDATE user SET createdAt = ?")
      .run(new Date(Date.now() - 86_400_000).toISOString());

    const fresh = await post(
      "/sign-in/email",
      { email: "a@x.com", password: "password1234" },
      { "user-agent": "Mozilla/5.0 (X11) Firefox/140", "cf-ipcountry": "JP" },
    );
    expect(fresh.status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(["a@x.com"]);
    expect(mails[0].text).toContain("Firefox/140");
    expect(mails[0].text).toContain("JP");

    const again = await post(
      "/sign-in/email",
      { email: "a@x.com", password: "password1234" },
      { cookie: cookie! },
    );
    expect(again.status).toBe(200);
    expect(deviceCookie(again)).toBe(cookie);
    expect(mails).toHaveLength(1);
  });

  test("a failing mail or location lookup never fails the sign-in; waitUntil carries the send", async () => {
    const pending: Promise<unknown>[] = [];
    const { d1, post } = setup({
      getCf: () => {
        throw new Error("no cf");
      },
      waitUntil: (p) => pending.push(p),
    });
    await post("/sign-up/email", { email: "b@x.com", password: "password1234", name: "B" });
    d1.raw().prepare("UPDATE user SET createdAt = ?").run("2020-01-01T00:00:00.000Z");
    globalThis.fetch = (async () => Response.json({ message: "down" }, { status: 500 })) as never;
    const res = await post("/sign-in/email", { email: "b@x.com", password: "password1234" });
    expect(res.status).toBe(200);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
  });

  test("without a database (Mongo backend) the plugin stands aside", async () => {
    const { post } = setup({ getDb: () => null });
    const up = await post("/sign-up/email", {
      email: "c@x.com",
      password: "password1234",
      name: "C",
    });
    expect(up.status).toBe(200);
    expect(deviceCookie(up)).toBeUndefined();
  });
});

describe("sign-in lockout through better-auth", () => {
  test("10 wrong codes → 429 on the 11th, even with the right code; no new codes either", async () => {
    const { post, otps } = setup();
    const ip = { "cf-connecting-ip": "203.0.113.20" };
    expect(
      (await post("/email-otp/send-verification-otp", { email: "v@x.com", type: "sign-in" }, ip))
        .status,
    ).toBe(200);
    const right = otps.at(-1)!;
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 10; i++) {
      const r = await post(
        "/sign-in/email-otp",
        { email: "v@x.com", otp: wrong },
        { "cf-connecting-ip": `198.51.100.${i}` },
      );
      expect(r.status).toBe(400);
    }
    const locked = await post("/sign-in/email-otp", { email: "v@x.com", otp: right }, ip);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(29 * 60);
    expect(
      (await post("/email-otp/send-verification-otp", { email: "v@x.com", type: "sign-in" }, ip))
        .status,
    ).toBe(429);
  });

  test("a right code after a few wrong ones signs in and clears the count", async () => {
    const { post, otps } = setup();
    await post("/email-otp/send-verification-otp", { email: "w@x.com", type: "sign-in" });
    const right = otps.at(-1)!;
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) await post("/sign-in/email-otp", { email: "w@x.com", otp: wrong });
    const ok = await post("/sign-in/email-otp", { email: "w@x.com", otp: right });
    expect(ok.status).toBe(200);
    expect(deviceCookie(ok)).toBeDefined();
  });
});

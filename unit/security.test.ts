import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  CHECKOUT_STARTS,
  SIGN_IN_FAILURES,
  accountKey,
  clientIp,
  hit,
  lockedFor,
  type ThrottleDb,
} from "@/lib/security/throttle";
import {
  checkAttempt,
  isFailureStatus,
  isSignInPath,
  recordAttempt,
} from "@/lib/security/auth-guard";
import {
  SIGN_UP_GRACE_MS,
  approximateLocation,
  loginNoticeMail,
  recordSignIn,
  utcStamp,
  validDeviceId,
} from "@/lib/security/login-notice";
import { guardCheckout } from "@/lib/payments/checkout-guard";
import {
  CHECKOUT_POLICY,
  payjpThreeDSecure,
  stripeThreeDSecure,
} from "@/lib/payments/checkout-policy";
import { APKG_UPLOAD, YAML_UPLOAD, checkMagic, checkUpload } from "@/lib/security/upload-policy";
import { checkDir, checkFile } from "@/lib/security/public-dir";
import { activeWaivers, blocking, counts, ghsaOf, rank } from "@/lib/security/audit";

const MIN = 60_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");

function db(): ThrottleDb {
  return createTestD1(testSchema()) as unknown as ThrottleDb;
}

describe("throttle counters", () => {
  test("a rate counter allows max hits per window, then refuses until it rolls over", async () => {
    const d = db();
    for (let i = 1; i <= CHECKOUT_STARTS.max; i++)
      expect((await hit(d, "k", CHECKOUT_STARTS, T0 + i)).allowed).toBe(true);
    const over = await hit(d, "k", CHECKOUT_STARTS, T0 + 100);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterMs).toBeGreaterThan(9 * MIN);
    expect((await hit(d, "k", CHECKOUT_STARTS, T0 + CHECKOUT_STARTS.windowMs + 1)).allowed).toBe(
      true,
    );
  });

  test("a failure counter locks the key for 30 minutes at the 10th failure", async () => {
    const d = db();
    for (let i = 1; i < SIGN_IN_FAILURES.max; i++) await hit(d, "f", SIGN_IN_FAILURES, T0 + i);
    expect(await lockedFor(d, "f", T0 + 20)).toBe(0);
    const tenth = await hit(d, "f", SIGN_IN_FAILURES, T0 + 20);
    expect(tenth.allowed).toBe(false);
    expect(await lockedFor(d, "f", T0 + 21)).toBeGreaterThan(29 * MIN);
    expect(await lockedFor(d, "f", T0 + 20 + 30 * MIN + 1)).toBe(0);
  });

  test("account keys never contain the address", async () => {
    const k = await accountKey("fail", " Someone@Example.com ");
    expect(k).not.toContain("example");
    expect(k).toBe(await accountKey("fail", "someone@example.com"));
  });

  test("client IP prefers Cloudflare's header", () => {
    const h = new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "10.0.0.1" });
    expect(clientIp(h)).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }))).toBe(
      "198.51.100.1",
    );
    expect(clientIp(null)).toBe("unknown");
  });
});

describe("sign-in lockout (≤10 failures per account and per IP)", () => {
  const otp = "/sign-in/email-otp";

  test("10 wrong codes lock the account; the 11th attempt is refused, from any IP", async () => {
    const d = db();
    for (let i = 0; i < 10; i++) {
      const ip = `198.51.100.${i}`; // spread over IPs: the account lock still trips
      expect((await checkAttempt(d, { path: otp, email: "v@x.com", ip, now: T0 + i })).ok).toBe(
        true,
      );
      await recordAttempt(d, { path: otp, email: "v@x.com", ip, failed: true, now: T0 + i });
    }
    const v = await checkAttempt(d, { path: otp, email: "v@x.com", ip: "192.0.2.1", now: T0 + 20 });
    expect(v.ok).toBe(false);
    // A different account from a fresh IP is unaffected.
    expect(
      (await checkAttempt(d, { path: otp, email: "w@x.com", ip: "192.0.2.2", now: T0 + 20 })).ok,
    ).toBe(true);
    // Nor can the locked account get new codes mailed.
    const send = await checkAttempt(d, {
      path: "/email-otp/send-verification-otp",
      email: "v@x.com",
      ip: "192.0.2.3",
      now: T0 + 21,
    });
    expect(send.ok).toBe(false);
    // 30 minutes later it opens again.
    expect(
      (await checkAttempt(d, { path: otp, email: "v@x.com", ip: "192.0.2.1", now: T0 + 31 * MIN }))
        .ok,
    ).toBe(true);
  });

  test("10 failures from one IP lock that IP across accounts", async () => {
    const d = db();
    const ip = "203.0.113.5";
    for (let i = 0; i < 10; i++)
      await recordAttempt(d, { path: otp, email: `u${i}@x.com`, ip, failed: true, now: T0 + i });
    expect((await checkAttempt(d, { path: otp, email: "new@x.com", ip, now: T0 + 20 })).ok).toBe(
      false,
    );
    // Passkey verification has no account up front, but the IP lock covers it.
    expect(
      (await checkAttempt(d, { path: "/passkey/verify-authentication", ip, now: T0 + 20 })).ok,
    ).toBe(false);
  });

  test("passkey failures count per IP", async () => {
    const d = db();
    const ip = "203.0.113.6";
    for (let i = 0; i < 10; i++)
      await recordAttempt(d, {
        path: "/passkey/verify-authentication",
        ip,
        failed: true,
        now: T0 + i,
      });
    expect(
      (await checkAttempt(d, { path: "/passkey/verify-authentication", ip, now: T0 + 20 })).ok,
    ).toBe(false);
  });

  test("a successful sign-in clears the account's failures", async () => {
    const d = db();
    for (let i = 0; i < 9; i++)
      await recordAttempt(d, {
        path: otp,
        email: "v@x.com",
        ip: `198.51.100.${i}`,
        failed: true,
        now: T0 + i,
      });
    await recordAttempt(d, {
      path: otp,
      email: "v@x.com",
      ip: "198.51.100.50",
      failed: false,
      now: T0 + 10,
    });
    await recordAttempt(d, {
      path: otp,
      email: "v@x.com",
      ip: "198.51.100.51",
      failed: true,
      now: T0 + 11,
    });
    expect(
      (await checkAttempt(d, { path: otp, email: "v@x.com", ip: "192.0.2.9", now: T0 + 12 })).ok,
    ).toBe(true);
  });

  test("code sends: 5 per address, 20 per IP, per 15 minutes", async () => {
    const d = db();
    const send = "/email-otp/send-verification-otp";
    for (let i = 0; i < 5; i++)
      expect(
        (await checkAttempt(d, { path: send, email: "a@x.com", ip: `192.0.2.${i}`, now: T0 + i }))
          .ok,
      ).toBe(true);
    expect(
      (await checkAttempt(d, { path: send, email: "a@x.com", ip: "192.0.2.99", now: T0 + 9 })).ok,
    ).toBe(false);
    const ip = "203.0.113.77";
    let ok = 0;
    for (let i = 0; i < 25; i++)
      if ((await checkAttempt(d, { path: send, email: `b${i}@x.com`, ip, now: T0 + i })).ok) ok++;
    expect(ok).toBe(20);
  });

  test("other endpoints are not counted", async () => {
    const d = db();
    for (let i = 0; i < 20; i++)
      await recordAttempt(d, {
        path: "/get-session",
        email: "v@x.com",
        ip: "192.0.2.1",
        failed: true,
        now: T0,
      });
    expect(
      (await checkAttempt(d, { path: otp, email: "v@x.com", ip: "192.0.2.1", now: T0 })).ok,
    ).toBe(true);
  });

  test("what counts as a failure, and as a sign-in", () => {
    expect(isFailureStatus(400)).toBe(true);
    expect(isFailureStatus(401)).toBe(true);
    expect(isFailureStatus(403)).toBe(true);
    expect(isFailureStatus(429)).toBe(false);
    expect(isFailureStatus(302)).toBe(false);
    expect(isFailureStatus(undefined)).toBe(false);
    for (const p of [
      "/sign-in/email-otp",
      "/callback/:id",
      "/passkey/verify-authentication",
      "/magic-link/verify",
    ])
      expect(isSignInPath(p)).toBe(true);
    for (const p of ["/get-session", "/update-user", "/passkey/generate-authenticate-options"])
      expect(isSignInPath(p)).toBe(false);
  });
});

describe("login notification", () => {
  const user = (d: ThrottleDb, id: string) =>
    (d as unknown as ReturnType<typeof createTestD1>)
      .raw()
      .prepare("INSERT INTO user (id, email, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
      .run(id, `${id}@x.com`, new Date(T0).toISOString(), new Date(T0).toISOString());
  const later = new Date(T0 + 24 * 60 * MIN);

  test("the sign-up's own browser is remembered without a notice", async () => {
    const d = db();
    user(d, "u1");
    const r = await recordSignIn(d, {
      userId: "u1",
      userCreatedAt: new Date(T0),
      deviceCookie: null,
      userAgent: "UA",
      now: new Date(T0 + 1000),
    });
    expect(r.newDevice).toBe(true);
    expect(r.notify).toBe(false);
    expect(validDeviceId(r.deviceId)).toBe(true);
  });

  test("a new browser later is announced; the same browser again is not", async () => {
    const d = db();
    user(d, "u1");
    const first = await recordSignIn(d, {
      userId: "u1",
      userCreatedAt: new Date(T0),
      deviceCookie: undefined,
      userAgent: "UA",
      now: later,
    });
    expect(first.notify).toBe(true);
    const again = await recordSignIn(d, {
      userId: "u1",
      userCreatedAt: new Date(T0),
      deviceCookie: first.deviceId,
      userAgent: "UA",
      now: new Date(later.getTime() + MIN),
    });
    expect(again).toEqual({ deviceId: first.deviceId, notify: false, newDevice: false });
  });

  test("a cookie known for another account is a new device for this one", async () => {
    const d = db();
    user(d, "u1");
    user(d, "u2");
    const a = await recordSignIn(d, {
      userId: "u1",
      userCreatedAt: new Date(T0),
      deviceCookie: null,
      userAgent: "",
      now: later,
    });
    const b = await recordSignIn(d, {
      userId: "u2",
      userCreatedAt: new Date(T0),
      deviceCookie: a.deviceId,
      userAgent: "",
      now: later,
    });
    expect(b.newDevice).toBe(true);
    expect(b.notify).toBe(true);
  });

  test("a forged or malformed cookie is replaced", async () => {
    const d = db();
    user(d, "u1");
    const r = await recordSignIn(d, {
      userId: "u1",
      userCreatedAt: new Date(T0),
      deviceCookie: "x'; DROP",
      userAgent: "",
      now: later,
    });
    expect(r.deviceId).not.toBe("x'; DROP");
    expect(r.notify).toBe(true);
    expect(SIGN_UP_GRACE_MS).toBe(10 * MIN);
  });

  test("the mail carries time, location and user agent, escaped", () => {
    const m = loginNoticeMail("en", {
      when: new Date("2026-10-30T14:05:09Z"),
      location: approximateLocation({ city: "Tokyo", region: "Tokyo", country: "JP" }),
      userAgent: "Mozilla/5.0 <script>",
    });
    expect(m.text).toContain("2026-10-30 14:05 UTC");
    expect(m.text).toContain("Tokyo, Tokyo, JP");
    expect(m.text).toContain("Mozilla/5.0 <script>");
    expect(m.html).not.toContain("<script>");
    expect(
      loginNoticeMail("zh", { when: new Date(), location: "", userAgent: null }).text,
    ).toContain("未知");
  });

  test("location falls back to Cloudflare's headers and drops unknown codes", () => {
    expect(approximateLocation(undefined, new Headers({ "cf-ipcountry": "JP" }))).toBe("JP");
    expect(approximateLocation({ country: "XX" })).toBe("");
    expect(utcStamp(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02 03:04 UTC");
  });
});

describe("checkout guard (card-testing protection)", () => {
  const base = {
    userId: "u1",
    ip: "203.0.113.1",
    turnstileToken: "tok",
    turnstileConfigured: true,
    production: true,
    verifyTurnstile: async (t: string) => t === "tok",
  };

  test("needs a valid Turnstile token", async () => {
    expect(await guardCheckout(db(), { ...base, now: T0 })).toEqual({ ok: true });
    expect(await guardCheckout(db(), { ...base, turnstileToken: "bad", now: T0 })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      await guardCheckout(db(), { ...base, turnstileToken: undefined, now: T0 }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await guardCheckout(db(), {
        ...base,
        verifyTurnstile: async () => {
          throw new Error("down");
        },
        now: T0,
      }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  test("fails closed in production without the Turnstile secret", async () => {
    expect(
      await guardCheckout(db(), { ...base, turnstileConfigured: false, now: T0 }),
    ).toMatchObject({ ok: false, status: 503 });
    expect(
      await guardCheckout(db(), {
        ...base,
        turnstileConfigured: false,
        production: false,
        now: T0,
      }),
    ).toEqual({ ok: true });
  });

  test("5 starts per 10 minutes per user, and per IP — failed tokens count too", async () => {
    const d = db();
    for (let i = 0; i < 5; i++)
      await guardCheckout(d, {
        ...base,
        turnstileToken: "bad",
        ip: `198.51.100.${i}`,
        now: T0 + i,
      });
    const r = await guardCheckout(d, { ...base, ip: "198.51.100.99", now: T0 + 10 });
    expect(r).toMatchObject({ ok: false, status: 429 });
    const d2 = db();
    for (let i = 0; i < 5; i++) await guardCheckout(d2, { ...base, userId: `u${i}`, now: T0 + i });
    expect(await guardCheckout(d2, { ...base, userId: "fresh", now: T0 + 10 })).toMatchObject({
      ok: false,
      status: 429,
    });
  });

  test("3-D Secure is required, and each provider's form says so", () => {
    expect(CHECKOUT_POLICY.threeDSecure).toBe("required");
    expect(stripeThreeDSecure()).toBe("any");
    expect(payjpThreeDSecure()).toEqual({ three_d_secure: true });
  });
});

describe("upload policy", () => {
  test(".apkg only, at most 100 MB, and a real zip", () => {
    expect(checkUpload({ name: "deck.apkg", size: 10 }, APKG_UPLOAD).ok).toBe(true);
    expect(checkUpload({ name: "Deck.APKG", size: 10 }, APKG_UPLOAD).ok).toBe(true);
    expect(checkUpload({ name: "deck.apkg.php", size: 10 }, APKG_UPLOAD).ok).toBe(false);
    expect(checkUpload({ name: "deck.zip", size: 10 }, APKG_UPLOAD).ok).toBe(false);
    expect(checkUpload({ name: "deck.apkg", size: 101 * 1024 * 1024 }, APKG_UPLOAD).ok).toBe(false);
    expect(checkUpload({ name: "deck.apkg", size: 0 }, APKG_UPLOAD).ok).toBe(false);
    expect(checkMagic(new Uint8Array([0x50, 0x4b, 3, 4, 0]), APKG_UPLOAD).ok).toBe(true);
    expect(checkMagic(new TextEncoder().encode("<?php"), APKG_UPLOAD).ok).toBe(false);
  });

  test("YAML import takes .yaml / .yml up to 10 MB", () => {
    expect(checkUpload({ name: "lianki-export.yml", size: 5 }, YAML_UPLOAD).ok).toBe(true);
    expect(checkUpload({ name: "x.html", size: 5 }, YAML_UPLOAD).ok).toBe(false);
    expect(checkUpload({ name: "x.yaml", size: 11 * 1024 * 1024 }, YAML_UPLOAD).ok).toBe(false);
  });
});

describe("public directory hygiene", () => {
  test("flags env files, keys, dumps and server source maps", () => {
    expect(checkFile(".env.local", null)).not.toHaveLength(0);
    expect(checkFile(".dev.vars", null)).not.toHaveLength(0);
    expect(checkFile("certs/server.pem", null)).not.toHaveLength(0);
    expect(checkFile("backup.sql", null)).not.toHaveLength(0);
    expect(checkFile("server/app/page.js.map", "{}")).not.toHaveLength(0);
    expect(
      checkFile("_next/static/x.js.map", '{"sources":["../app/api/payments/route.ts"]}'),
    ).not.toHaveLength(0);
    // Built at runtime so secret scanners do not flag the fixture itself.
    const fakeKey = ["sk", "live", "abcdefghijklmnop1234"].join("_");
    expect(checkFile("lib.js", `const k = '${fakeKey}';`)).not.toHaveLength(0);
    expect(checkFile("k.txt", "-----BEGIN PRIVATE KEY-----")).not.toHaveLength(0);
  });

  test("passes ordinary assets", () => {
    expect(checkFile("icon.svg", "<svg></svg>")).toEqual([]);
    expect(checkFile("lianki.user.js", "// ==UserScript==")).toEqual([]);
    expect(
      checkFile("_next/static/chunk.js.map", '{"sources":["../components/Button.tsx"]}'),
    ).toEqual([]);
  });

  test("the repo's public/ is clean", () => {
    expect(checkDir("public")).toEqual([]);
  });
});

describe("dependency audit report", () => {
  const audit = {
    a: [
      {
        id: 1,
        url: "https://github.com/advisories/GHSA-aaaa",
        title: "t",
        severity: "critical" as const,
        vulnerable_versions: "<2",
      },
    ],
    b: [
      {
        id: 2,
        url: "https://github.com/advisories/GHSA-bbbb",
        title: "t",
        severity: "high" as const,
        vulnerable_versions: "<2",
      },
    ],
  };
  test("counts, blocks at the level, honours unexpired waivers only", () => {
    expect(counts(audit)).toEqual({ low: 0, moderate: 0, high: 1, critical: 1 });
    expect(blocking(audit, "critical", new Set())).toHaveLength(1);
    expect(blocking(audit, "high", new Set())).toHaveLength(2);
    const waived = activeWaivers(
      [
        { ghsa: "GHSA-aaaa", reason: "not reachable", until: "2026-12-01" },
        { ghsa: "GHSA-bbbb", reason: "old", until: "2026-01-01" },
        { ghsa: "GHSA-cccc", reason: "", until: "2099-01-01" },
      ],
      new Date("2026-11-01"),
    );
    expect([...waived]).toEqual(["GHSA-aaaa"]);
    expect(blocking(audit, "high", waived)).toHaveLength(1);
    expect(ghsaOf(audit.a[0])).toBe("GHSA-aaaa");
    expect(rank("nope")).toBe(-1);
  });
});

describe("admin surfaces are owner-gated", () => {
  function files(dir: string, name: RegExp): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p, name) : name.test(f) ? [p] : [];
    });
  }
  const surfaces = [
    ...files("app/(app)/dev", /^page\.tsx$/),
    ...files("app/api/dev", /^route\.ts$/),
  ];

  test("every /dev page and /api/dev route checks isOwner", () => {
    expect(surfaces.length).toBeGreaterThan(8);
    for (const f of surfaces) {
      const src = readFileSync(f, "utf8");
      expect({ f, gated: /isOwner\(/.test(src) }).toEqual({ f, gated: true });
    }
  });

  test("each exported handler of an /api/dev route reaches the gate", () => {
    for (const f of files("app/api/dev", /^route\.ts$/)) {
      const src = readFileSync(f, "utf8");
      const handlers =
        src.match(/export (async function|const) (GET|POST|PUT|PATCH|DELETE)\b/g) ?? [];
      // A gate call per handler, or one shared helper that wraps isOwner.
      const gates = (src.match(/isOwner\(|await owner\(\)/g) ?? []).length;
      expect({ f, ok: gates >= handlers.length }).toEqual({ f, ok: true });
    }
  });

  test("owner-only management is not left outside /api/dev", () => {
    expect(() => statSync("app/api/gift-codes/route.ts")).toThrow();
  });
});

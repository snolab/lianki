import { describe, expect, test } from "bun:test";
import {
  DEVICE_COOKIE,
  ENTER_PATH,
  ENTER_TOKEN_TTL_MS,
  EnterTokens,
  decide,
  deviceCookieValue,
  copyableKey,
  isHubPath,
  isPrivateLanHost,
  landingHtml,
  sendLoginCode,
  readCookie,
  sessionIsOwner,
  verifyDevice,
} from "../scripts/dev/whole-page-guard";
import {
  DEV_GUARD_HEADER,
  devWholePage,
  devWholePageLoginAllowed,
  devWholePageOrigin,
} from "../lib/dev-whole-page";
import { trustedOrigins } from "../lib/trusted-origins";

const SECRET = "a".repeat(64);
const ON = { LIANKI_DEV_WHOLE_PAGE: "1", NODE_ENV: "development", LIANKI_DEV_GUARD_SECRET: SECRET };

describe("whole-page guard: decide", () => {
  test("the enter link is handled by the guard, paired or not", () => {
    expect(decide(ENTER_PATH, false).kind).toBe("enter");
    expect(decide(ENTER_PATH, true).kind).toBe("enter");
  });

  test("an unpaired device gets nothing, not even static files", () => {
    for (const p of ["/", "/words", "/_next/static/x.js", "/api/auth/get-session", "/api/words"]) {
      expect(decide(p, false)).toEqual({ kind: "deny", status: 403, reason: "device not paired" });
    }
  });

  test("auth API: only reading and ending a session; every sign-in/sign-up is closed", () => {
    expect(decide("/api/auth/get-session", true).kind).toBe("pass");
    expect(decide("/api/auth/sign-out", true).kind).toBe("pass");
    for (const p of [
      "/api/auth/sign-in/email",
      "/api/auth/sign-up/email",
      "/api/auth/sign-in/magic-link",
      "/api/auth/email-otp/send-verification-otp",
      "/api/auth/sign-in/social",
      "/api/auth/passkey/generate-register-options",
      "/api/auth",
    ]) {
      expect(decide(p, true).kind).toBe("deny");
    }
  });

  test("pages and app APIs need the owner's session", () => {
    for (const p of ["/words", "/words?list=all", "/api/words", "/api/dev-whole-page/login", "/"]) {
      expect(decide(p, true).kind).toBe("owner");
    }
  });

  test("the app shell's assets and HMR pass once the device is paired", () => {
    expect(decide("/_next/static/chunks/a.js", true).kind).toBe("pass");
    expect(decide("/_next/webpack-hmr", true).kind).toBe("pass");
  });
});

describe("whole-page guard: device cookie", () => {
  test("verifies only the HMAC of the device secret", async () => {
    const v = await deviceCookieValue(SECRET);
    expect(await verifyDevice(v, SECRET)).toBe(true);
    expect(await verifyDevice(v, "b".repeat(64))).toBe(false);
    expect(await verifyDevice(undefined, SECRET)).toBe(false);
    expect(await verifyDevice("", SECRET)).toBe(false);
    expect(await verifyDevice(`${v}0`, SECRET)).toBe(false);
  });

  test("readCookie finds it among others", () => {
    expect(readCookie(`a=1; ${DEVICE_COOKIE}=xyz; b=2`, DEVICE_COOKIE)).toBe("xyz");
    expect(readCookie("a=1", DEVICE_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, DEVICE_COOKIE)).toBeUndefined();
  });
});

describe("whole-page guard: enter tokens", () => {
  test("each token works once", () => {
    const t = new EnterTokens();
    const a = t.issue();
    expect(t.consume(a)).toBe(true);
    expect(t.consume(a)).toBe(false);
  });

  test("unknown and empty tokens fail", () => {
    const t = new EnterTokens();
    t.issue();
    expect(t.consume("nope")).toBe(false);
    expect(t.consume("")).toBe(false);
    expect(t.consume(null)).toBe(false);
  });

  test("tokens expire", () => {
    let now = 1_000;
    const t = new EnterTokens(() => now);
    const a = t.issue();
    now += ENTER_TOKEN_TTL_MS + 1;
    expect(t.consume(a)).toBe(false);
  });
});

describe("whole-page guard: owner session", () => {
  const owners = ["owner@example.com"];
  test("only an owner email passes", () => {
    expect(sessionIsOwner({ user: { email: "Owner@Example.com " } }, owners)).toBe(true);
    expect(sessionIsOwner({ user: { email: "friend@example.com" } }, owners)).toBe(false);
    expect(sessionIsOwner({ user: null }, owners)).toBe(false);
    expect(sessionIsOwner(null, owners)).toBe(false);
    expect(sessionIsOwner({ user: { email: "owner@example.com" } }, [])).toBe(false);
  });
});

describe("whole-page guard: bind address", () => {
  test("private LAN IPv4 only", () => {
    for (const h of ["192.168.31.96", "10.0.0.2", "172.16.0.1", "172.31.255.1"])
      expect(isPrivateLanHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "127.0.0.1", "8.8.8.8", "172.32.0.1", "lianki.com", "::"])
      expect(isPrivateLanHost(h)).toBe(false);
  });
});

describe("dev-whole-page switches (app side)", () => {
  test("off unless the launcher's env is complete and this is next dev", () => {
    expect(devWholePage({})).toBe(false);
    expect(devWholePage({ LIANKI_DEV_WHOLE_PAGE: "1", NODE_ENV: "production" })).toBe(false);
    expect(devWholePage(ON)).toBe(true);
  });

  test("the login route needs the guard secret in its header", () => {
    const h = (v?: string) => new Headers(v === undefined ? {} : { [DEV_GUARD_HEADER]: v });
    expect(devWholePageLoginAllowed(ON, h(SECRET))).toBe(true);
    expect(devWholePageLoginAllowed(ON, h())).toBe(false);
    expect(devWholePageLoginAllowed(ON, h("b".repeat(64)))).toBe(false);
    // production: no flag → never, even with the right header
    expect(
      devWholePageLoginAllowed(
        { LIANKI_DEV_GUARD_SECRET: SECRET, NODE_ENV: "production" },
        h(SECRET),
      ),
    ).toBe(false);
    // a short secret never counts
    expect(devWholePageLoginAllowed({ ...ON, LIANKI_DEV_GUARD_SECRET: "short" }, h("short"))).toBe(
      false,
    );
  });

  test("the LAN origin is trusted only while the launcher runs", () => {
    const base = "http://192.168.31.96:3100";
    expect(devWholePageOrigin({ ...ON, BETTER_AUTH_BASE_URL: base })).toEqual([base]);
    expect(devWholePageOrigin({ BETTER_AUTH_BASE_URL: base })).toEqual([]);
    expect(devWholePageOrigin({ ...ON, BETTER_AUTH_BASE_URL: "https://evil.example" })).toEqual([]);
    expect(devWholePageOrigin({ ...ON, BETTER_AUTH_BASE_URL: "http://8.8.8.8:3100" })).toEqual([]);
    // the tailnet HTTPS front: https on *.ts.net only
    const ts = "https://mac.example-tailnet.ts.net:8443";
    expect(devWholePageOrigin({ ...ON, BETTER_AUTH_BASE_URL: ts })).toEqual([ts]);
    expect(
      devWholePageOrigin({ ...ON, BETTER_AUTH_BASE_URL: "http://mac.example-tailnet.ts.net:8443" }),
    ).toEqual([]);
    expect(
      devWholePageOrigin({ ...ON, BETTER_AUTH_BASE_URL: "https://ts.net.evil.example" }),
    ).toEqual([]);
    expect(devWholePageOrigin({ BETTER_AUTH_BASE_URL: ts })).toEqual([]);
  });

  test("production's trusted origins are unchanged", () => {
    expect(trustedOrigins("https://lianki.com")).not.toContain("http://192.168.31.96:3100");
  });
});

describe("whole-page guard: hub and carried settings", () => {
  test("lianki-push paths are the hub's", () => {
    expect(isHubPath("/api/version/debug")).toBe(true);
    expect(isHubPath("/api/version/ws")).toBe(true);
    expect(isHubPath("/api/words/lists")).toBe(false);
    // the hub goes through the owner check like any app path
    expect(decide("/api/version/debug", true).kind).toBe("owner");
    expect(decide("/api/version/debug", false).kind).toBe("deny");
  });

  test("only small lk:debug / lk:agent / lk:pref keys travel", () => {
    expect(copyableKey("lk:debug", "1")).toBe(true);
    expect(copyableKey("lk:agent-widget-src", "https://x")).toBe(true);
    expect(copyableKey("lk:pref:motion", "off")).toBe(true);
    expect(copyableKey("lk:c:words", "x")).toBe(false);
    expect(copyableKey("other", "x")).toBe(false);
    expect(copyableKey("lk:debug-big", "x".repeat(5000))).toBe(false);
  });

  test("the landing page and the eval snippet are valid JavaScript", () => {
    const script = landingHtml().split("<script>")[1].split("</script>")[0];
    expect(() => new Function(script)).not.toThrow();
    const code = sendLoginCode("https://h.example.ts.net:8443/__dev/enter?t=x");
    expect(() => new Function(code)).not.toThrow();
  });
});

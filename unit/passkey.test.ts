import { describe, expect, test } from "bun:test";
import {
  defaultPasskeyName,
  PRODUCTION_RP_ID,
  passkeyErrorKind,
  passkeyRelyingParty,
} from "@/lib/passkey";

describe("passkeyRelyingParty", () => {
  test("a localhost base URL is its own RP, on that exact origin (qa:all's random port)", () => {
    expect(passkeyRelyingParty("http://localhost:58123", false)).toEqual({
      rpID: "localhost",
      origin: ["http://localhost:58123"],
    });
    expect(passkeyRelyingParty("http://127.0.0.1:3000/", true)).toEqual({
      rpID: "127.0.0.1",
      origin: ["http://127.0.0.1:3000"],
    });
  });

  test("a deployed base URL uses its apex, www included as an origin", () => {
    const want = {
      rpID: "lianki.com",
      origin: ["https://lianki.com", "https://www.lianki.com"],
    };
    expect(passkeyRelyingParty("https://lianki.com", true)).toEqual(want);
    expect(passkeyRelyingParty(" https://www.lianki.com/api/auth ", true)).toEqual(want);
  });

  test("no base URL: the production domain in production, localhost otherwise", () => {
    expect(passkeyRelyingParty(undefined, true).rpID).toBe(PRODUCTION_RP_ID);
    expect(passkeyRelyingParty("", true).origin).toEqual([
      "https://lianki.com",
      "https://www.lianki.com",
    ]);
    expect(passkeyRelyingParty(null, false)).toEqual({ rpID: "localhost", origin: null });
  });

  test("junk or non-http base URLs fall back to the defaults", () => {
    expect(passkeyRelyingParty("not a url", true).rpID).toBe("lianki.com");
    expect(passkeyRelyingParty("ftp://localhost", false)).toEqual({
      rpID: "localhost",
      origin: null,
    });
  });
});

describe("defaultPasskeyName", () => {
  const cases: [string, string][] = [
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "Chrome on macOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Safari on iPhone",
    ],
    [
      "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1",
      "Chrome on iPad",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      "Edge on Windows",
    ],
    [
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36 OPR/80.0",
      "Opera on Android",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", "Firefox on Linux"],
    [
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "Chrome on ChromeOS",
    ],
    ["SomeBot/1.0 (Windows)", "Windows"],
    ["Mozilla/5.0 Firefox/140.0", "Firefox"],
    ["", "Passkey"],
  ];
  for (const [ua, want] of cases)
    test(want, () => {
      expect(defaultPasskeyName(ua)).toBe(want);
    });

  test("no user agent at all", () => {
    expect(defaultPasskeyName(undefined)).toBe("Passkey");
  });
});

describe("passkeyErrorKind", () => {
  test("cancellation is quiet, not an error", () => {
    expect(passkeyErrorKind({ code: "ERROR_CEREMONY_ABORTED" })).toBe("cancelled");
    expect(passkeyErrorKind({ code: "AUTH_CANCELLED" })).toBe("cancelled");
  });
  test("a second passkey on the same authenticator", () => {
    expect(passkeyErrorKind({ code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" })).toBe(
      "duplicate",
    );
  });
  test("an old session must sign in again before registering", () => {
    expect(passkeyErrorKind({ code: "SESSION_NOT_FRESH", status: 403 })).toBe("stale-session");
    expect(passkeyErrorKind({ code: "UNAUTHORIZED", status: 401 })).toBe("stale-session");
  });
  test("anything else is a plain failure", () => {
    expect(passkeyErrorKind({ code: "FAILED_TO_VERIFY_REGISTRATION" })).toBe("failed");
    expect(passkeyErrorKind(null)).toBe("failed");
    expect(passkeyErrorKind({})).toBe("failed");
  });
});

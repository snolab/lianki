import { describe, expect, test } from "bun:test";
import {
  lockMinutes,
  signInErrorFrom,
  signInErrorText,
  type SignInErrorKey,
} from "@/lib/sign-in-errors";
import { noticeLocale, noticeTemplateLocale } from "@/lib/security/login-notice";

const TEXT: Record<SignInErrorKey, string> = {
  captcha: "captcha",
  locked: "locked {n} min",
  tooMany: "too many",
  wrongCode: "wrong",
  sendFailed: "send failed",
  authFailed: "auth failed",
  signInFailed: "sign-in failed",
};

describe("lockout message", () => {
  test("a guard 429 with its wait → locked, minutes rounded up", () => {
    const e = signInErrorFrom(
      { status: 429, code: "TOO_MANY_ATTEMPTS", retryAfterS: 1790, message: "Too many attempts." },
      "wrongCode",
    );
    expect(e).toEqual({ key: "locked", retryAfterS: 1790 });
    expect(signInErrorText(e, TEXT)).toBe("locked 30 min");
  });

  test("a thrown server APIError (send path) maps the same way", () => {
    const e = signInErrorFrom(
      {
        statusCode: 429,
        status: "TOO_MANY_REQUESTS",
        body: { code: "TOO_MANY_ATTEMPTS", retryAfterS: 61 },
      },
      "sendFailed",
    );
    expect(signInErrorText(e, TEXT)).toBe("locked 2 min");
  });

  test("a 429 without a wait (another limiter) → too many, not wrong code", () => {
    expect(signInErrorFrom({ status: 429 }, "wrongCode")).toEqual({ key: "tooMany" });
  });

  test("minutes: never 0, never NaN", () => {
    expect(lockMinutes(1)).toBe(1);
    expect(lockMinutes(60)).toBe(1);
    expect(lockMinutes(61)).toBe(2);
    expect(lockMinutes(0)).toBe(1);
    expect(lockMinutes(undefined)).toBe(1);
    expect(lockMinutes(Number.NaN)).toBe(1);
  });
});

describe("error keys: never raw server text", () => {
  test("a wrong code (400) → the step's fallback", () => {
    expect(signInErrorFrom({ status: 400, message: "Invalid OTP" }, "wrongCode")).toEqual({
      key: "wrongCode",
    });
  });

  test("an Error, a string or nothing → the fallback, its text never passed on", () => {
    for (const err of [new Error("D1_ERROR: no such table"), "boom", null, undefined, 42])
      expect(signInErrorFrom(err, "sendFailed")).toEqual({ key: "sendFailed" });
  });

  test("every key has text and only locked fills {n}", () => {
    for (const key of Object.keys(TEXT) as SignInErrorKey[])
      expect(signInErrorText({ key }, TEXT)).toBe(key === "locked" ? "locked 1 min" : TEXT[key]);
  });
});

describe("new-sign-in notice language", () => {
  test("account setting first, then sign-up language, then English", () => {
    expect(noticeLocale({ accountLocale: "zh", signupLocale: "en" })).toBe("zh");
    expect(noticeLocale({ accountLocale: "en", signupLocale: "zh-Hans" })).toBe("en");
    expect(noticeLocale({ accountLocale: null, signupLocale: "zh-CN" })).toBe("zh");
    expect(noticeLocale({ accountLocale: "", signupLocale: undefined })).toBe("en");
    expect(noticeLocale({})).toBe("en");
  });

  test("zh, zh-CN, zh-Hans, zh_Hans → Simplified; others → English; junk → none", () => {
    for (const tag of ["zh", "zh-CN", "zh-Hans", "zh_Hans", "ZH-cn"])
      expect(noticeTemplateLocale(tag)).toBe("zh");
    for (const tag of ["en", "en-US", "ja", "fr"]) expect(noticeTemplateLocale(tag)).toBe("en");
    for (const tag of ["", "  ", "1234", null, 7, {}]) expect(noticeTemplateLocale(tag)).toBeNull();
  });
});

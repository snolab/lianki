import { describe, expect, it } from "bun:test";
import {
  ACCT_COOKIE_LINE,
  CLEAR_MARKER_LINE,
  PICK_COOKIE_LINE,
  accountUiLocale,
  adoptCookieLines,
  isLocaleMarker,
  needsAccountLocale,
  prefString,
  requestLocale,
  uiLocaleOf,
  withAccountLocale,
} from "@/lib/account-locale";
import { readAccountUiLocale } from "@/lib/account-locale-d1";
import { createTestD1 } from "@/lib/d1/testDb";

/**
 * The UI language of a request (lib/account-locale.ts): ?lang= → the
 * account's ui.locale → its signupLocale → the `lang` cookie → Accept-Language.
 */
function resolve(r: {
  param?: string | null;
  cookie?: string | null;
  accept?: string | null;
  marker?: string | null;
  signedIn?: boolean;
  account?: { accountLocale?: unknown; signupLocale?: unknown };
}): string {
  const mw = requestLocale(r.param, r.cookie, r.accept);
  if (!needsAccountLocale({ source: mw.source, marker: r.marker, signedIn: r.signedIn ?? false }))
    return mw.locale;
  return withAccountLocale(mw.locale, accountUiLocale(r.account ?? {})).locale;
}

describe("requestLocale (the middleware's chain)", () => {
  it("?lang= → cookie → Accept-Language, and says which decided", () => {
    expect(requestLocale("ja", "ko", "fr")).toEqual({ locale: "ja", source: "param" });
    expect(requestLocale(null, "ko", "fr")).toEqual({ locale: "ko", source: "cookie" });
    expect(requestLocale("xx", "yy", "fr-FR,en;q=0.5")).toEqual({ locale: "fr", source: "accept" });
    expect(requestLocale(undefined, undefined, undefined)).toEqual({
      locale: "en",
      source: "accept",
    });
  });
});

describe("the resolution order", () => {
  const zh = { accountLocale: "zh" };

  it("signed in, fresh device: the account's language, not Accept-Language", () => {
    expect(resolve({ accept: "en-US,en", signedIn: true, account: zh })).toBe("zh");
  });

  it("an explicit ?lang= always wins over the account", () => {
    expect(resolve({ param: "ja", accept: "en", signedIn: true, account: zh })).toBe("ja");
  });

  it("ui.locale first, then signupLocale, then the cookie chain", () => {
    const both = { accountLocale: "ko", signupLocale: "zh-Hans" };
    expect(resolve({ accept: "en", signedIn: true, account: both })).toBe("ko");
    const signup = { signupLocale: "de" };
    expect(resolve({ cookie: "fr", signedIn: true, account: signup })).toBe("de");
    expect(resolve({ cookie: "fr", accept: "ja", signedIn: true, account: {} })).toBe("fr");
    expect(resolve({ accept: "ja", signedIn: true, account: {} })).toBe("ja");
  });

  it("a cookie seeded by a landing visit does not beat the account", () => {
    expect(resolve({ cookie: "en", signedIn: true, account: zh })).toBe("zh");
  });

  it("a pick by hand this session, or an adopted account language, is trusted as is", () => {
    expect(resolve({ cookie: "fr", marker: "pick", signedIn: true, account: zh })).toBe("fr");
    expect(resolve({ cookie: "fr", marker: "acct", signedIn: true, account: zh })).toBe("fr");
    // an unknown marker value counts as none
    expect(resolve({ cookie: "fr", marker: "x", signedIn: true, account: zh })).toBe("zh");
  });

  it("a guest never gets an account language", () => {
    expect(resolve({ accept: "en", signedIn: false, account: zh })).toBe("en");
  });

  it("zh-Hans and zh-Hant both read the UI's one Chinese", () => {
    expect(resolve({ signedIn: true, account: { signupLocale: "zh-Hant" } })).toBe("zh");
    expect(resolve({ signedIn: true, account: { signupLocale: "zh-Hans" } })).toBe("zh");
    expect(resolve({ signedIn: true, account: { accountLocale: "zh-TW" } })).toBe("zh");
  });
});

describe("helpers", () => {
  it("uiLocaleOf normalises any tag to one of the 16, else null", () => {
    expect(uiLocaleOf("ja-JP")).toBe("ja");
    expect(uiLocaleOf("zh_HK")).toBe("zh");
    expect(uiLocaleOf("xx")).toBeNull();
    expect(uiLocaleOf(42)).toBeNull();
    expect(uiLocaleOf(null)).toBeNull();
  });

  it("isLocaleMarker", () => {
    expect(isLocaleMarker("acct")).toBe(true);
    expect(isLocaleMarker("pick")).toBe(true);
    expect(isLocaleMarker("")).toBe(false);
    expect(isLocaleMarker(undefined)).toBe(false);
  });

  it("withAccountLocale: none on the account keeps the request's, adopting only the marker", () => {
    expect(withAccountLocale("fr", null)).toEqual({ locale: "fr", adopt: { locale: null } });
    expect(withAccountLocale("xx", null).locale).toBe("en");
    expect(withAccountLocale(null, "ko")).toEqual({ locale: "ko", adopt: { locale: "ko" } });
  });

  it("adoptCookieLines: lang + NEXT_LOCALE for a year, then the acct marker", () => {
    const lines = adoptCookieLines("zh");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toStartWith("NEXT_LOCALE=zh;");
    expect(lines[1]).toStartWith("lang=zh;");
    expect(lines[2]).toBe(ACCT_COOKIE_LINE);
    for (const l of lines) expect(l).toContain("max-age=31536000");
    expect(adoptCookieLines(null)).toEqual([ACCT_COOKIE_LINE]);
    expect(adoptCookieLines("xx")).toEqual([ACCT_COOKIE_LINE]);
  });

  it("the pick marker lasts the browser session; sign-out clears the marker", () => {
    expect(PICK_COOKIE_LINE).toStartWith("lang_src=pick;");
    expect(PICK_COOKIE_LINE).not.toContain("max-age");
    expect(CLEAR_MARKER_LINE).toContain("max-age=0");
  });

  it("prefString reads a stored JSON string", () => {
    expect(prefString('"ja"')).toBe("ja");
    expect(prefString("3")).toBeNull();
    expect(prefString("{bad")).toBeNull();
    expect(prefString(null)).toBeNull();
  });
});

describe("readAccountUiLocale (D1)", () => {
  const SCHEMA = `
    CREATE TABLE user (id TEXT PRIMARY KEY, signupLocale TEXT);
    CREATE TABLE user_prefs (user_id TEXT, key TEXT, value TEXT);
  `;

  it("ui.locale → signupLocale → null", async () => {
    const db = createTestD1(SCHEMA);
    await db.exec(
      "INSERT INTO user VALUES ('a', 'zh-Hant'); INSERT INTO user VALUES ('b', 'de'); INSERT INTO user VALUES ('c', NULL);",
    );
    await db.exec(`INSERT INTO user_prefs VALUES ('a', 'ui.locale', '"ja"')`);
    expect(await readAccountUiLocale(db as never, "a")).toBe("ja");
    expect(await readAccountUiLocale(db as never, "b")).toBe("de");
    expect(await readAccountUiLocale(db as never, "c")).toBeNull();
    expect(await readAccountUiLocale(db as never, "nobody")).toBeNull();
  });

  it("a missing table or column never throws: the next fallback", async () => {
    const noPrefs = createTestD1("CREATE TABLE user (id TEXT PRIMARY KEY, signupLocale TEXT);");
    await noPrefs.exec("INSERT INTO user VALUES ('a', 'zh-Hans');");
    expect(await readAccountUiLocale(noPrefs as never, "a")).toBe("zh");
    const nothing = createTestD1("CREATE TABLE other (x TEXT);");
    expect(await readAccountUiLocale(nothing as never, "a")).toBeNull();
  });
});

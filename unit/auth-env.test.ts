import { afterEach, describe, expect, it } from "bun:test";
import { hasSessionCookie, passwordAuthEnabled } from "../lib/auth-env";

describe("hasSessionCookie", () => {
  const h = (cookie?: string) => new Headers(cookie === undefined ? {} : { cookie });

  it("is false for a guest: no cookie header, or no session cookie in it", () => {
    expect(hasSessionCookie(h())).toBe(false);
    expect(hasSessionCookie(h(""))).toBe(false);
    expect(hasSessionCookie(h("theme=dark; lk_locale=ja"))).toBe(false);
  });

  it("is true for better-auth's session cookie, plain or __Secure- prefixed", () => {
    expect(hasSessionCookie(h("better-auth.session_token=abc.def"))).toBe(true);
    expect(hasSessionCookie(h("theme=dark; __Secure-better-auth.session_token=abc.def"))).toBe(
      true,
    );
  });

  it("does not mistake other better-auth cookies for a session", () => {
    // session_data alone (the cookie cache) never authenticates without the token.
    expect(hasSessionCookie(h("better-auth.session_data=xyz"))).toBe(false);
  });
});

describe("passwordAuthEnabled", () => {
  const saved = { node: process.env.NODE_ENV, flag: process.env.DEV_EMAIL_PASSWORD_AUTH };
  const set = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    set("NODE_ENV", saved.node);
    set("DEV_EMAIL_PASSWORD_AUTH", saved.flag);
  });

  it("is on only outside production and only with the dev flag", () => {
    set("NODE_ENV", "development");
    set("DEV_EMAIL_PASSWORD_AUTH", "1");
    expect(passwordAuthEnabled()).toBe(true);

    set("DEV_EMAIL_PASSWORD_AUTH", undefined);
    expect(passwordAuthEnabled()).toBe(false);

    set("NODE_ENV", "production");
    set("DEV_EMAIL_PASSWORD_AUTH", "1");
    expect(passwordAuthEnabled()).toBe(false);
  });
});

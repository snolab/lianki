/**
 * The session cookie moves to `__Host-` (docs/secrets-and-auth.md, "The session
 * cookie"): only on https; every reader knows the new name; the old cookies are
 * cleared, not left to linger; and nothing that names the cookie was missed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { authCookieOptions, hasSessionCookie, SESSION_COOKIE_PREFIX } from "@/lib/auth-env";
import { sessionToken } from "@/lib/live-view/custom";
import { clearLegacyCookies, legacyCookieNames } from "@/lib/security/legacy-session-cookies";
import { getCookies } from "better-auth/cookies";

const NEW = "__Host-better-auth.session_token";
const OLD = "__Secure-better-auth.session_token";

describe("what better-auth makes of the options", () => {
  const prod = getCookies({
    baseURL: "https://lianki.com",
    advanced: authCookieOptions("https://lianki.com"),
  });

  test("on https every cookie is __Host-: Secure, Path=/, no Domain", () => {
    expect(prod.sessionToken.name).toBe(NEW);
    for (const c of [prod.sessionToken, prod.sessionData, prod.dontRememberToken]) {
      expect(c.name.startsWith(`${SESSION_COOKIE_PREFIX}.`)).toBe(true);
      expect(c.name).not.toContain("__Secure-");
      expect(c.attributes.secure).toBe(true);
      expect(c.attributes.path).toBe("/");
      expect(c.attributes.domain).toBeUndefined();
      expect(c.attributes.httpOnly).toBe(true);
      expect(c.attributes.sameSite).toBe("lax");
    }
  });

  test("the production base URL in wrangler.jsonc gets it", () => {
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    const base = /"BETTER_AUTH_BASE_URL":\s*"([^"]+)"/.exec(wrangler)?.[1];
    expect(base).toBe("https://lianki.com");
    expect(authCookieOptions(base).cookiePrefix).toBe(SESSION_COOKIE_PREFIX);
  });

  test("on http nothing changes: a browser refuses a __Host- cookie there", () => {
    for (const base of ["http://localhost:3000", "http://192.168.31.96:3100", undefined]) {
      expect(authCookieOptions(base)).toEqual({});
      const c = getCookies({ baseURL: base, advanced: authCookieOptions(base) });
      expect(c.sessionToken.name).not.toContain("__Host-");
    }
  });
});

describe("the readers", () => {
  test("hasSessionCookie sees the new name", () => {
    expect(hasSessionCookie(new Headers({ cookie: `${NEW}=a.b` }))).toBe(true);
  });

  test("the live cookie's session tag reads the new name, and no other prefix", () => {
    expect(sessionToken(`x=1; ${NEW}=tok.sig`)).toBe("tok.sig");
    expect(sessionToken(`${OLD}=tok.sig`)).toBeNull();
    expect(sessionToken("better-auth.session_token=dev.sig")).toBe("dev.sig");
    expect(sessionToken("__Host-other.session_token=x")).toBeNull();
  });

  test("the new name wins when a browser holds both", () => {
    expect(sessionToken(`${OLD}=old.sig; ${NEW}=new.sig`)).toBe("new.sig");
  });

  test("the preview gate strips the new name before anything reaches a dev server", () => {
    expect(readFileSync("scripts/dev/preview-gate.ts", "utf8")).toContain(
      "/^(__Secure-|__Host-)?better-auth\\./",
    );
  });

  test("no code names the old cookie except the code that clears it", () => {
    for (const f of [
      "lib/auth-env.ts",
      "lib/live-view/page-proxy.ts",
      "workers/push/src/auth.ts",
      "worker.ts",
      "src/lianki.user.ts",
      "packages/ext/src/gm-shim.ts",
    ])
      expect({ f, names: readFileSync(f, "utf8").includes("__Secure-better-auth") }).toEqual({
        f,
        names: false,
      });
  });
});

describe("the old cookies", () => {
  test("only better-auth's old names are picked out", () => {
    expect(
      legacyCookieNames(
        `a=1; ${OLD}=x.y; __Secure-better-auth.session_data=z; __Secure-other=1; ${NEW}=n`,
      ),
    ).toEqual([OLD, "__Secure-better-auth.session_data"]);
    expect(legacyCookieNames(`${NEW}=n; better-auth.session_token=d`)).toEqual([]);
    expect(legacyCookieNames("")).toEqual([]);
    expect(legacyCookieNames(null)).toEqual([]);
  });

  test("a value that merely mentions the name is not a cookie", () => {
    expect(legacyCookieNames("a=__Secure-better-auth.session_token")).toEqual([]);
  });

  test("each is expired on the response, with the attributes a browser needs", async () => {
    const res = clearLegacyCookies(new Response("hi", { status: 200 }), [OLD]);
    expect(await res.text()).toBe("hi");
    const [line] = res.headers.getSetCookie();
    expect(line).toStartWith(`${OLD}=;`);
    expect(line).toContain("Max-Age=0");
    expect(line).toContain("Path=/");
    expect(line).toContain("Secure");
  });

  test("what the app set is kept alongside", () => {
    const app = new Response(null, { status: 302, headers: { "set-cookie": `${NEW}=n; Path=/` } });
    const lines = clearLegacyCookies(app, [OLD]).headers.getSetCookie();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith(`${NEW}=n`);
  });

  test("nothing to clear, or a socket: the response itself", () => {
    const r = new Response("x");
    expect(clearLegacyCookies(r, [])).toBe(r);
    const socket = { status: 101 } as Response;
    expect(clearLegacyCookies(socket, [OLD])).toBe(socket);
  });
});

test("the old sign-ins end with the deploy: a migration deletes them", () => {
  const files = readFileSync("db/migrations/0050_host_session_cookie.sql", "utf8");
  expect(files).toContain("DELETE FROM session;");
});

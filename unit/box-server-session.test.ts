/**
 * The box's own server sees the tab's sign-in (lib/box-oauth/server-session.ts,
 * docs/box-oauth.md, "The box's server sees the sign-in"): it reads only the
 * box's token cookie, asks lianki.com exactly as the page does (token, its own
 * origin, no cookie), and anything off is nobody.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BOX_SESSION_CACHE_MS,
  boxAccessFromCookies,
  boxServerAccount,
  boxServerSession,
  clearBoxServerCache,
} from "@/lib/box-oauth/server-session";
import { boxReturnPath } from "@/lib/box-oauth/return-path";
import { boxServerGetSession } from "@/lib/box-oauth/server-auth";
import { clearOwnerCache, isOwner } from "@/lib/owner";

const BOX = "https://my-0123456789abcdef.lianki.com";
const PROVIDER = "https://lianki.com";
const TOKEN = `lkb_${"a".repeat(32)}`;
const ME = {
  user: { id: "u1", name: "Ann", email: "ann@test.example", image: "/api/avatar/u1/x" },
  flags: {},
  owner: true,
};

type Call = { url: string; init: RequestInit };
let calls: Call[];
let answer: () => Response;
const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  calls.push({ url: String(input), init });
  return answer();
}) as typeof fetch;
let now = 1_000_000;
const deps = () => ({ provider: PROVIDER, origin: BOX, fetch: fakeFetch, now: () => now });

beforeEach(() => {
  calls = [];
  now = 1_000_000;
  answer = () => Response.json(ME);
  clearBoxServerCache();
});

describe("the cookie", () => {
  test("only the box token's own cookie, in a token's shape", () => {
    expect(boxAccessFromCookies(`a=1; __Host-lk_box_at=${TOKEN}; b=2`)).toBe(TOKEN);
    expect(boxAccessFromCookies(`lk_box_at=${TOKEN}`)).toBe(TOKEN);
    expect(boxAccessFromCookies(`__Host-better-auth.session_token=${TOKEN}`)).toBeNull();
    expect(boxAccessFromCookies("__Host-lk_box_at=lkb_short")).toBeNull();
    expect(boxAccessFromCookies(`__Host-lk_box_at=${TOKEN}%0d`)).toBeNull();
    expect(boxAccessFromCookies(`__Host-lk_box_at=x${TOKEN}`)).toBeNull();
    expect(boxAccessFromCookies("")).toBeNull();
    expect(boxAccessFromCookies(null)).toBeNull();
  });
});

describe("asking lianki.com", () => {
  test("as the page does: /api/box/me, the token, this box's origin, no cookie", async () => {
    const a = await boxServerAccount(TOKEN, deps());
    expect(a).toEqual({
      id: "u1",
      email: "ann@test.example",
      name: "Ann",
      image: `${PROVIDER}/api/avatar/u1/x`,
      owner: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${PROVIDER}/api/box/me`);
    const h = new Headers(calls[0].init.headers);
    expect(h.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(h.get("origin")).toBe(BOX);
    expect(h.has("cookie")).toBe(false);
    expect(calls[0].init.credentials).toBe("omit");
  });

  test("kept 30 s per token, then asked again", async () => {
    await boxServerAccount(TOKEN, deps());
    now += BOX_SESSION_CACHE_MS - 1;
    await boxServerAccount(TOKEN, deps());
    expect(calls).toHaveLength(1);
    now += 1;
    answer = () => new Response(null, { status: 401 });
    expect(await boxServerAccount(TOKEN, deps())).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test("anything off is nobody, and is not kept", async () => {
    for (const r of [
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 404 }),
      () => new Response("not json", { status: 200 }),
      () => Response.json({ user: { email: "ann@test.example" } }),
      () => Response.json({ user: { id: "u1" } }),
    ]) {
      answer = r;
      expect(await boxServerAccount(TOKEN, deps())).toBeNull();
    }
    answer = () => {
      throw new Error("offline");
    };
    expect(await boxServerAccount(TOKEN, deps())).toBeNull();
    expect(await boxServerAccount(TOKEN, { ...deps(), origin: null })).toBeNull();
    expect(await boxServerAccount(null, deps())).toBeNull();
    expect(await boxServerAccount("lkb_x", deps())).toBeNull();
  });

  test("only a loadable picture", async () => {
    answer = () => Response.json({ user: { ...ME.user, image: "javascript:alert(1)" } });
    expect((await boxServerAccount(TOKEN, deps()))?.image).toBeNull();
  });

  test("the session has the account's id and email, and is not the owner unless lianki.com says so", async () => {
    answer = () => Response.json({ ...ME, owner: false });
    const s = boxServerSession((await boxServerAccount(TOKEN, deps()))!, now);
    expect(s.user.id).toBe("u1");
    expect(s.user.email).toBe("ann@test.example");
    expect(s.session.userId).toBe("u1");
  });
});

describe("getSession on a box's server", () => {
  const env = { ...process.env };
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.LIANKI_BOX_CLIENT_ID = "c1";
    process.env.LIANKI_BOX_PROVIDER = PROVIDER;
    process.env.BETTER_AUTH_BASE_URL = `${BOX}/`;
    globalThis.fetch = fakeFetch;
    clearOwnerCache();
  });
  afterEach(() => {
    process.env = { ...env };
    globalThis.fetch = realFetch;
    clearOwnerCache();
  });

  test("the cookie's account, with lianki.com's owner role", async () => {
    const s = await boxServerGetSession(new Headers({ cookie: `__Host-lk_box_at=${TOKEN}` }));
    expect(s?.user.email).toBe("ann@test.example");
    expect(new Headers(calls[0].init.headers).get("origin")).toBe(BOX);
    expect(isOwner("ann@test.example")).toBe(true);
  });

  test("no cookie, or no box config: nobody, and lianki.com is not asked", async () => {
    expect(await boxServerGetSession(new Headers())).toBeNull();
    expect(await boxServerGetSession(undefined)).toBeNull();
    delete process.env.LIANKI_BOX_CLIENT_ID;
    expect(
      await boxServerGetSession(new Headers({ cookie: `__Host-lk_box_at=${TOKEN}` })),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("not an owner on lianki.com: not one here", async () => {
    answer = () => Response.json({ ...ME, owner: false });
    await boxServerGetSession(new Headers({ cookie: `__Host-lk_box_at=${TOKEN}` }));
    expect(isOwner("ann@test.example")).toBe(false);
  });
});

describe("the way back after /sign-in", () => {
  test("a path on this host, with its query", () => {
    expect(boxReturnPath("/learn")).toBe("/learn");
    expect(boxReturnPath("/read/abc?p=2")).toBe("/read/abc?p=2");
  });
  test("never another host, never /sign-in, never odd bytes", () => {
    for (const v of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example/",
      "learn",
      "/sign-in",
      "/sign-in?next=/x",
      "/a\nb",
      "/a\\b",
      `/${"x".repeat(2100)}`,
      "",
      null,
    ])
      expect(boxReturnPath(v)).toBeNull();
  });
});

/**
 * The box's browser side (lib/box-oauth/client.ts, docs/box-oauth.md). What
 * matters: a code is traded only with the state it was sent with; nothing leaves
 * with credentials; only same-origin /api goes to the provider; an expired token
 * refreshes once and a refused one is not retried for ever.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { globalDescriptor, restoreGlobal } from "./support/globals";
import {
  boxChatHub,
  boxSignInBack,
  boxSignOut,
  finishBoxSignIn,
  forgetBoxTokens,
  installBoxFetch,
  startBoxSignIn,
  syncBoxCookie,
  type BoxConfig,
} from "@/lib/box-oauth/client";

const BOX = "https://my-0123456789abcdef.lianki.com";
const PROVIDER = "https://lianki.com";
const config: BoxConfig = { clientId: "c1", provider: PROVIDER, scope: "box:read offline_access" };

type Call = { url: string; init: RequestInit };
let calls: Call[];
let answer: (url: string, init: RequestInit) => Response | Promise<Response>;
let assigned: string[];
const store = new Map<string, string>();
const real = {
  fetch: globalThis.fetch,
  location: globalDescriptor("location"),
  sessionStorage: globalDescriptor("sessionStorage"),
  document: globalDescriptor("document"),
};
/** Every `document.cookie = …` line the page wrote. */
let cookieLines: string[] = [];

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  g.document = {
    get cookie() {
      return "";
    },
    set cookie(line: string) {
      cookieLines.push(line);
    },
  };
  g.location = {
    origin: BOX,
    protocol: "https:",
    href: `${BOX}/words`,
    assign: (u: string) => void assigned.push(u),
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  // Once per page, as on a real box. Everything below goes through it.
  installBoxFetch(config);
  installBoxFetch(config);
});

afterAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  globalThis.fetch = real.fetch;
  restoreGlobal("location", real.location);
  restoreGlobal("sessionStorage", real.sessionStorage);
  restoreGlobal("document", real.document);
});

beforeEach(() => {
  calls = [];
  cookieLines = [];
  assigned = [];
  store.clear();
  answer = () => new Response("{}", { status: 200 });
});

const hold = (access: string, refresh: string | null, untilMs = 60 * 60_000) =>
  store.set("lk:box:tokens", JSON.stringify({ access, refresh, until: Date.now() + untilMs }));
const tokens = () => JSON.parse(store.get("lk:box:tokens") ?? "null");
const bodyOf = (c: Call) => new URLSearchParams(c.init.body as URLSearchParams);
const pending = () => JSON.parse(store.get("lk:box:pending") ?? "null");

describe("signing in", () => {
  test("goes to lianki.com's entry with S256 PKCE, keeping the verifier here", async () => {
    await startBoxSignIn(config);
    const u = new URL(assigned[0]);
    expect(u.origin + u.pathname).toBe(`${PROVIDER}/box-authorize`);
    const q = u.searchParams;
    expect(q.get("client_id")).toBe("c1");
    expect(q.get("redirect_uri")).toBe(`${BOX}/box-callback`);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("scope")).toBe(config.scope);
    const { verifier, state } = pending();
    expect(q.get("state")).toBe(state);
    expect(assigned[0]).not.toContain(verifier);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    expect(q.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
  });

  test("each sign-in has its own verifier and state", async () => {
    await startBoxSignIn(config);
    const first = pending();
    await startBoxSignIn(config);
    expect(pending().verifier).not.toBe(first.verifier);
    expect(pending().state).not.toBe(first.state);
  });
});

describe("coming back", () => {
  const back = (o: Record<string, string>) => new URLSearchParams(o);
  beforeEach(() => {
    store.set("lk:box:pending", JSON.stringify({ verifier: "v1", state: "s1" }));
    answer = () =>
      Response.json({ access_token: "lkb_new", refresh_token: "lkr_new", expires_in: 900 });
  });

  test("trades the code once, with the verifier, without credentials", async () => {
    expect(await finishBoxSignIn(config, back({ code: "c", state: "s1" }))).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${PROVIDER}/api/auth/oauth2/token`);
    expect(calls[0].init.credentials).toBe("omit");
    const b = bodyOf(calls[0]);
    expect(b.get("code_verifier")).toBe("v1");
    expect(b.get("code")).toBe("c");
    expect(b.get("redirect_uri")).toBe(`${BOX}/box-callback`);
    expect(tokens().access).toBe("lkb_new");
    expect(store.has("lk:box:pending")).toBe(false);
  });

  test("a state that is not ours trades nothing, and the attempt is used up", async () => {
    expect(await finishBoxSignIn(config, back({ code: "c", state: "evil" }))).toBe("bad_state");
    expect(calls).toHaveLength(0);
    expect(tokens()).toBeNull();
    expect(store.has("lk:box:pending")).toBe(false);
  });

  test("no attempt under way, or no code: nothing is traded", async () => {
    expect(await finishBoxSignIn(config, back({ state: "s1" }))).toBe("bad_state");
    store.delete("lk:box:pending");
    expect(await finishBoxSignIn(config, back({ code: "c", state: "s1" }))).toBe("bad_state");
    expect(calls).toHaveLength(0);
  });

  test("a garbled pending record is no attempt", async () => {
    store.set("lk:box:pending", "{not json");
    expect(await finishBoxSignIn(config, back({ code: "c", state: "s1" }))).toBe("bad_state");
    expect(calls).toHaveLength(0);
  });

  test("the provider's refusal comes back as a short code", async () => {
    const long = "x".repeat(200);
    expect(await finishBoxSignIn(config, back({ error: long }))).toBe("x".repeat(80));
    expect(calls).toHaveLength(0);
  });

  test("a refused exchange keeps no token", async () => {
    answer = () => new Response("{}", { status: 400 });
    expect(await finishBoxSignIn(config, back({ code: "c", state: "s1" }))).toBe("token_400");
    expect(tokens()).toBeNull();
  });

  test("an answer with no token is an error, not an empty session", async () => {
    answer = () => Response.json({});
    await expect(finishBoxSignIn(config, back({ code: "c", state: "s1" }))).rejects.toThrow();
    expect(tokens()).toBeNull();
  });
});

describe("the page's fetch", () => {
  test("same-origin /api goes to the provider with the token and no credentials", async () => {
    hold("lkb_a", "lkr_a");
    await fetch("/api/prefs?since=1");
    expect(calls[0].url).toBe(`${PROVIDER}/api/prefs?since=1`);
    expect(calls[0].init.credentials).toBe("omit");
    expect(calls[0].init.mode).toBe("cors");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer lkb_a");
  });

  test("a page's own credentials: include cannot turn cookies on", async () => {
    hold("lkb_a", "lkr_a");
    await fetch("/api/prefs", { credentials: "include" });
    expect(calls[0].init.credentials).toBe("omit");
  });

  test("method, headers and body are kept", async () => {
    hold("lkb_a", "lkr_a");
    await fetch("/api/prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(calls[0].init.method).toBe("PATCH");
    expect(calls[0].init.body).toBe("{}");
    expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/json");
  });

  test("a Request and a URL work too", async () => {
    hold("lkb_a", "lkr_a");
    await fetch(
      new Request(`${BOX}/api/prefs`, { method: "POST", headers: { "x-a": "1" }, body: "hi" }),
    );
    expect(calls[0].url).toBe(`${PROVIDER}/api/prefs`);
    expect(calls[0].init.method).toBe("POST");
    expect(new Headers(calls[0].init.headers).get("x-a")).toBe("1");
    expect(await (calls[0].init.body as Blob).text()).toBe("hi");
    await fetch(new URL(`${BOX}/api/levels/me`));
    expect(calls[1].url).toBe(`${PROVIDER}/api/levels/me`);
  });

  test("nothing else is touched and never gets the token", async () => {
    hold("lkb_a", "lkr_a");
    for (const u of [
      "https://evil.test/api/prefs",
      "/_next/x.js",
      "/api/auth/get-session",
      "/home",
    ]) {
      calls = [];
      await fetch(u);
      expect(calls[0].url).toBe(u);
      expect(calls[0].init?.headers).toBeUndefined();
    }
  });

  test("signed out it still goes out, with no token, and the provider says no", async () => {
    answer = () => new Response(null, { status: 401 });
    expect((await fetch("/api/prefs")).status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0].init.headers).has("authorization")).toBe(false);
  });

  test("a token about to expire is refreshed first", async () => {
    hold("lkb_old", "lkr_old", 10_000);
    answer = (url) =>
      url.endsWith("/oauth2/token")
        ? Response.json({ access_token: "lkb_new", refresh_token: "lkr_new", expires_in: 900 })
        : new Response("{}");
    await fetch("/api/prefs");
    expect(calls.map((c) => c.url)).toEqual([
      `${PROVIDER}/api/auth/oauth2/token`,
      `${PROVIDER}/api/prefs`,
    ]);
    expect(bodyOf(calls[0]).get("refresh_token")).toBe("lkr_old");
    expect(calls[0].init.credentials).toBe("omit");
    expect(new Headers(calls[1].init.headers).get("authorization")).toBe("Bearer lkb_new");
    expect(tokens().refresh).toBe("lkr_new");
  });

  test("a 401 refreshes and retries once", async () => {
    hold("lkb_old", "lkr_old");
    let n = 0;
    answer = (url) => {
      if (url.endsWith("/oauth2/token"))
        return Response.json({
          access_token: "lkb_new",
          refresh_token: "lkr_new",
          expires_in: 900,
        });
      return new Response(null, { status: ++n === 1 ? 401 : 200 });
    };
    expect((await fetch("/api/prefs")).status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(new Headers(calls[2].init.headers).get("authorization")).toBe("Bearer lkb_new");
  });

  test("a revoked box: the refresh is refused, the 401 stands, no loop", async () => {
    hold("lkb_old", "lkr_old");
    answer = () => new Response(null, { status: 401 });
    expect((await fetch("/api/prefs")).status).toBe(401);
    expect(calls).toHaveLength(2);
  });

  test("no refresh token: no refresh attempt", async () => {
    hold("lkb_old", null);
    answer = () => new Response(null, { status: 401 });
    expect((await fetch("/api/prefs")).status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  test("a network failure on refresh does not throw into the page", async () => {
    hold("lkb_old", "lkr_old", 10_000);
    answer = (url) => {
      if (url.endsWith("/oauth2/token")) throw new Error("offline");
      return new Response("{}");
    };
    expect((await fetch("/api/prefs")).status).toBe(200);
  });

  test("two calls at once share one refresh: rotation would break a second", async () => {
    hold("lkb_old", "lkr_old", 10_000);
    answer = (url) =>
      url.endsWith("/oauth2/token")
        ? Response.json({ access_token: "lkb_new", refresh_token: "lkr_new", expires_in: 900 })
        : new Response("{}");
    await Promise.all([fetch("/api/prefs"), fetch("/api/levels/me")]);
    expect(calls.filter((c) => c.url.endsWith("/oauth2/token"))).toHaveLength(1);
  });

  test("an unusable URL is left to the browser", async () => {
    hold("lkb_a", "lkr_a");
    await fetch("http://[bad");
    expect(calls[0].url).toBe("http://[bad");
    expect(calls[0].init?.headers).toBeUndefined();
  });
});

describe("signing out", () => {
  test("forgets the tokens and revokes the refresh token, no credentials", async () => {
    hold("lkb_a", "lkr_a");
    await boxSignOut(config);
    expect(tokens()).toBeNull();
    expect(calls[0].url).toBe(`${PROVIDER}/api/auth/oauth2/revoke`);
    expect(calls[0].init.credentials).toBe("omit");
    expect(bodyOf(calls[0]).get("token")).toBe("lkr_a");
  });
  test("a provider that cannot be reached still signs out here", async () => {
    hold("lkb_a", "lkr_a");
    answer = () => {
      throw new Error("offline");
    };
    await boxSignOut(config);
    expect(tokens()).toBeNull();
  });
  test("nothing held: no call", async () => {
    await boxSignOut(config);
    expect(calls).toHaveLength(0);
  });
});

describe("the chat hub on a box (box:chat)", () => {
  test("signed out: no hub at all", () => {
    expect(boxChatHub()).toBeNull();
  });

  test("a ticket through the box's fetch: POST to lianki.com with the token, the hub at lianki.com", async () => {
    hold("lkb_a", "lkr_a");
    answer = () => Response.json({ ticket: "t.sig", exp: 1 });
    const hub = boxChatHub();
    expect(hub?.url).toBe("wss://lianki.com/api/version/debug");
    expect(await hub?.ticket()).toBe("t.sig");
    expect(calls[0].url).toBe(`${PROVIDER}/api/box/chat-ticket`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.credentials).toBe("omit");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer lkb_a");
  });

  test("a busy or broken answer is no ticket, and the next connect may ask again", async () => {
    hold("lkb_a", "lkr_a");
    answer = () => new Response("busy", { status: 429 });
    expect(await boxChatHub()?.ticket()).toBeNull();
    answer = () => Response.json({ ticket: 42 });
    expect(await boxChatHub()?.ticket()).toBeNull();
    answer = () => Promise.reject(new Error("offline"));
    expect(await boxChatHub()?.ticket()).toBeNull();
    expect(boxChatHub()).not.toBeNull();
  });

  test("given the box's config it is a hub even when asked first (hydration order)", () => {
    hold("lkb_a", "lkr_a");
    expect(boxChatHub(config)?.url).toBe("wss://lianki.com/api/version/debug");
  });

  test("refused (no box:chat): this page load does not ask again", async () => {
    hold("lkb_a", "lkr_a");
    answer = () => new Response(null, { status: 404 });
    expect(await boxChatHub()?.ticket()).toBeNull();
    expect(boxChatHub()).toBeNull();
  });
});

describe("the box's server sees the tab's sign-in (server-session.ts)", () => {
  const back = (o: Record<string, string>) => new URLSearchParams(o);
  beforeEach(() => {
    answer = () =>
      Response.json({ access_token: "lkb_new", refresh_token: "lkr_new", expires_in: 900 });
  });

  test("a new token is mirrored into one host-only cookie; the refresh token never", async () => {
    store.set("lk:box:pending", JSON.stringify({ verifier: "v1", state: "s1" }));
    expect(await finishBoxSignIn(config, back({ code: "c", state: "s1" }))).toBeNull();
    expect(cookieLines).toHaveLength(1);
    const line = cookieLines[0];
    expect(line.startsWith("__Host-lk_box_at=lkb_new; Path=/; Max-Age=")).toBe(true);
    expect(line).toContain("; Secure");
    expect(line).not.toContain("Domain");
    expect(line).not.toContain("lkr_new");
    expect(Number(/Max-Age=(\d+)/.exec(line)?.[1])).toBeGreaterThan(890);
  });

  test("sign-in comes back to the page it started from; never another host", async () => {
    await startBoxSignIn(config, "/learn?x=1");
    store.set("lk:box:pending", JSON.stringify({ ...pending(), state: "s1" }));
    await finishBoxSignIn(config, back({ code: "c", state: "s1" }));
    expect(boxSignInBack()).toBe("/learn?x=1");
    for (const evil of ["//evil.example/x", "https://evil.example/", "/\\evil", "/sign-in"]) {
      await startBoxSignIn(config, evil);
      store.set("lk:box:pending", JSON.stringify({ ...pending(), state: "s1" }));
      await finishBoxSignIn(config, back({ code: "c", state: "s1" }));
      expect(boxSignInBack()).toBe("/home");
    }
  });

  test("a stale cookie is refreshed and written again; a tab with no token leaves it alone", async () => {
    expect(await syncBoxCookie(config)).toBe(false);
    expect(cookieLines).toHaveLength(0);
    hold("lkb_old", "lkr_old", 30_000);
    expect(await syncBoxCookie(config)).toBe(true);
    expect(calls.map((c) => bodyOf(c).get("grant_type"))).toEqual(["refresh_token"]);
    expect(cookieLines.at(-1)?.startsWith("__Host-lk_box_at=lkb_new;")).toBe(true);
    calls = [];
    hold("lkb_fresh", "lkr", 10 * 60_000);
    expect(await syncBoxCookie(config)).toBe(true);
    expect(calls).toHaveLength(0);
    expect(cookieLines.at(-1)?.startsWith("__Host-lk_box_at=lkb_fresh;")).toBe(true);
  });

  test("sign-out and a refused token clear it", async () => {
    hold("lkb_a", "lkr_a");
    await boxSignOut(config);
    expect(cookieLines.at(-1)).toContain("__Host-lk_box_at=; Path=/; Max-Age=0");
    cookieLines = [];
    forgetBoxTokens();
    expect(cookieLines.at(-1)).toContain("Max-Age=0");
  });
});

test("preview mode keeps API fetches same-origin while OAuth remains on the provider", async () => {
  // The installed page config is the same object held by the fetch bridge.
  config.sameOriginApi = true;
  try {
    hold(`lkb_${"p".repeat(32)}`, null);
    await fetch("/api/preferences");
    expect(calls[0].url).toBe("/api/preferences");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(
      `Bearer lkb_${"p".repeat(32)}`,
    );
    expect(calls[0].init.credentials).toBe("omit");
    await startBoxSignIn(config);
    expect(new URL(assigned[0]).origin).toBe(PROVIDER);
  } finally {
    delete config.sameOriginApi;
  }
});

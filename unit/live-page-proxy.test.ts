/**
 * The same-origin live preview (lib/live-view/page-proxy.ts): only the
 * owner's document with the stored pointer's `?live=<id>` comes from the dev
 * tunnel; non-owners get the normal build; no cookie or auth reaches the
 * tunnel; host-escape paths; 101 headers filtered; redirects kept on
 * lianki.com; expiry and revoke; a document without the parameter clears
 * live mode; the tunnel down → production with a notice. Plus the pointer's
 * `page` origin (rules.ts) and the gate's Worker entry (preview-gate.ts).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { b64url } from "@/lib/stt-ticket";
import {
  LIVE_COOKIE,
  LIVE_GATE_HEADER,
  LIVE_ID_HEADER,
  LIVE_IDLE_MS,
  POINTER_CACHE_MS,
  STORM_LOADS,
  STORM_WINDOW_MS,
  badgeHtml,
  createLivePage,
  mayBeLive,
  openLiveCookie,
  requestKind,
  rewriteLocation,
  sealLiveCookie,
  upstreamUrl,
} from "@/lib/live-view/page-proxy";
import {
  LIVE_QUICK_TUNNEL,
  importLiveViewPrivateKey,
  importLiveViewPublicKey,
  livePageOk,
  liveSourceOk,
  signLiveView,
  verifyLiveView,
} from "@/lib/live-view/rules";
import { clearPointer, writeSigned, type LiveViewDb } from "@/lib/live-view/server";
import { LIVE_PAGE_ORIGINS } from "@/lib/live-view/origins";
import {
  FAILS_PER_IP,
  WORKER_TOKEN_ID,
  createGate,
  upstreamHeaders as gateUpstream,
} from "../scripts/dev/preview-gate";

const PAGE = LIVE_PAGE_ORIGINS[0];
const SECRET = "s".repeat(64);
const T0 = Date.parse("2026-11-05T05:00:00Z");
const SERIAL = 1_793_000_000_000;
const ID = String(SERIAL);

const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const PRIV = await importLiveViewPrivateKey(await crypto.subtle.exportKey("jwk", pair.privateKey));
const PUB = await importLiveViewPublicKey(
  b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
);

const pointer = (serial = SERIAL, x: Record<string, unknown> = {}, now = T0) =>
  signLiveView(PRIV, {
    op: "on",
    serial,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 3600,
    page: PAGE,
    branch: "feat/live",
    sha: "abcdef1",
    ...x,
  });

type Call = Request;
let db: LiveViewDb;
let t: number;
let upCalls: Call[];
let nextCalls: Request[];
let upstream: (r: Request) => Promise<Response>;

const next = async (r: Request) => {
  nextCalls.push(r);
  return new Response("<html><body>prod</body></html>", {
    headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "lang=en; Path=/" },
  });
};

function live() {
  return createLivePage({
    keys: async () => [PUB],
    now: () => t,
    isOwner: async (r) => /(^|; )owner=1(;|$)/.test(r.headers.get("cookie") ?? ""),
    fetch: async (r) => {
      upCalls.push(r);
      return upstream(r);
    },
    respond101: (_up, h) => new Response("upgraded", { status: 200, headers: h }),
  });
}

const ENV = () => ({ DB: db as never, LIVE_GATE_SECRET: SECRET });
const DOC = {
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  accept: "text/html",
};
const OWNER_COOKIE = "owner=1; __Secure-better-auth.session_token=tok.sig";
const req = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://lianki.com${path}`, { method, headers });

beforeEach(async () => {
  const d = createTestD1(testSchema());
  db = d as unknown as LiveViewDb;
  t = T0;
  upCalls = [];
  nextCalls = [];
  upstream = async () =>
    new Response("<html><body>dev page</body></html>", {
      headers: {
        "content-type": "text/html",
        "set-cookie": "evil=1; Path=/",
        "content-security-policy": "script-src *",
        "access-control-allow-origin": "*",
        "strict-transport-security": "max-age=0",
        "clear-site-data": '"*"',
        "x-dev": "1",
      },
    });
  await writeSigned(db, await pointer(), SERIAL, T0);
});

/** The owner's live document, and the cookie it set. */
async function enter(lp = live()) {
  const r = await lp.handle(
    req(`/words?x=1&live=${ID}`, { ...DOC, cookie: OWNER_COOKIE }),
    ENV(),
    next,
  );
  const sc = r.headers.getSetCookie().find((c) => c.startsWith(`${LIVE_COOKIE}=`)) ?? "";
  return { r, lp, cookie: sc.split(";")[0] };
}

describe("the fast path", () => {
  test("no live= and no cookie: production, nothing else looked at", async () => {
    expect(mayBeLive("https://lianki.com/words", "a=1")).toBe(false);
    expect(mayBeLive("https://lianki.com/words?live=1", null)).toBe(true);
    expect(mayBeLive("https://lianki.com/x", `${LIVE_COOKIE}=v`)).toBe(true);
    const r = await live().handle(req("/words", DOC), ENV(), next);
    expect(await r.text()).toContain("prod");
    expect(upCalls).toHaveLength(0);
  });
});

describe("who gets the dev page", () => {
  test("a non-owner (or a guest) with ?live=<id>: the normal build, untouched", async () => {
    for (const cookie of ["", "owner=0; __Secure-better-auth.session_token=x"]) {
      const r = await live().handle(req(`/words?live=${ID}`, { ...DOC, cookie }), ENV(), next);
      expect(await r.text()).toContain("prod");
      expect(r.headers.get(LIVE_ID_HEADER)).toBeNull();
      expect(r.headers.getSetCookie().some((c) => c.startsWith(LIVE_COOKIE))).toBe(false);
    }
    expect(upCalls).toHaveLength(0);
  });

  test("the owner: the dev page, filtered and marked, with the badge and the cookie", async () => {
    const { r, cookie } = await enter();
    expect(upCalls).toHaveLength(1);
    expect(upCalls[0].url).toBe(`${PAGE}/words?x=1`);
    const body = await r.text();
    expect(body).toContain("dev page");
    expect(body).toContain('id="lk-live-badge"');
    expect(r.headers.get(LIVE_ID_HEADER)).toBe(ID);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("strict-transport-security")).toBeNull();
    expect(r.headers.get("clear-site-data")).toBeNull();
    expect(r.headers.get("x-dev")).toBe("1");
    const sc = r.headers.getSetCookie();
    expect(sc).toHaveLength(1); // ours only: the dev server's evil=1 never
    expect(sc[0]).toMatch(
      /^__Host-lk_live=.+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600$/,
    );
    expect(await openLiveCookie(SECRET, cookie.split("=")[1], t)).toEqual({
      serial: SERIAL,
      until: T0 + LIVE_IDLE_MS,
    });
  });

  test("no cookie, auth, cf-*, x-forwarded-* or Referer reaches the tunnel; Origin is the tunnel's", async () => {
    await live().handle(
      req(`/words?live=${ID}`, {
        ...DOC,
        cookie: OWNER_COOKIE,
        authorization: "Bearer lkdev_x",
        "cf-connecting-ip": "203.0.113.9",
        "cf-access-jwt-assertion": "jwt",
        "x-forwarded-for": "1.2.3.4",
        "x-forwarded-host": "evil",
        referer: "https://lianki.com/secret?token=x",
        origin: "https://lianki.com",
        "accept-language": "zh",
      }),
      ENV(),
      next,
    );
    const h = upCalls[0].headers;
    for (const k of [
      "cookie",
      "authorization",
      "cf-connecting-ip",
      "cf-access-jwt-assertion",
      "x-forwarded-for",
      "x-forwarded-host",
      "referer",
    ])
      expect(h.get(k)).toBeNull();
    expect(h.get("origin")).toBe(PAGE);
    expect(h.get(LIVE_GATE_HEADER)).toBe(SECRET);
    expect(h.get("accept-language")).toBe("zh");
  });

  test("the id must be the stored pointer's; ?live=on finds it; ?live=off stops", async () => {
    const lp = live();
    const wrong = await lp.handle(
      req("/words?live=123", { ...DOC, cookie: OWNER_COOKIE }),
      ENV(),
      next,
    );
    expect(await wrong.text()).toContain("lk-live-notice");
    expect(upCalls).toHaveLength(0);
    const on = await lp.handle(
      req("/words?live=on&a=1", { ...DOC, cookie: OWNER_COOKIE }),
      ENV(),
      next,
    );
    expect(on.status).toBe(303);
    expect(on.headers.get("location")).toBe(`/words?live=${ID}&a=1`);
    const off = await lp.handle(
      req(`/words?live=off&a=1`, { ...DOC, cookie: OWNER_COOKIE }),
      ENV(),
      next,
    );
    expect(off.status).toBe(303);
    expect(off.headers.get("location")).toBe("/words?a=1");
    expect(off.headers.get("set-cookie")).toContain(`${LIVE_COOKIE}=; `);
    expect(off.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("without LIVE_GATE_SECRET (or a short one) nothing is ever proxied", async () => {
    for (const s of [undefined, "short"]) {
      const r = await live().handle(
        req(`/words?live=${ID}`, { ...DOC, cookie: OWNER_COOKIE }),
        { DB: db as never, LIVE_GATE_SECRET: s },
        next,
      );
      expect(await r.text()).toContain("not set up");
    }
    expect(upCalls).toHaveLength(0);
  });
});

describe("subresources ride the cookie", () => {
  test("/_next/* with a valid cookie goes to the tunnel; without, forged or expired, production", async () => {
    const { lp, cookie } = await enter();
    upCalls = [];
    upstream = async () =>
      new Response("chunk", { headers: { "content-type": "text/javascript" } });
    const js = await lp.handle(req("/_next/static/chunks/a.js", { cookie }), ENV(), next);
    expect(await js.text()).toBe("chunk");
    expect(js.headers.get(LIVE_ID_HEADER)).toBe(ID);
    expect(upCalls[0].url).toBe(`${PAGE}/_next/static/chunks/a.js`);
    expect(upCalls[0].headers.get("cookie")).toBeNull();

    upCalls = [];
    const forged = `${LIVE_COOKIE}=${SERIAL}.${T0 + LIVE_IDLE_MS}.${"A".repeat(43)}`;
    for (const c of ["", forged]) {
      const r = await lp.handle(req("/_next/static/chunks/a.js", { cookie: c }), ENV(), next);
      expect(await r.text()).toContain("prod");
    }
    t = T0 + LIVE_IDLE_MS + 1; // idle past the hour
    const late = await lp.handle(req("/_next/static/chunks/a.js", { cookie }), ENV(), next);
    expect(await late.text()).toContain("prod");
    expect(upCalls).toHaveLength(0);
  });

  test("an RSC fetch only from a live page (its Referer carries ?live=<id>)", async () => {
    const { lp, cookie } = await enter();
    upCalls = [];
    const rsc = (referer: string) =>
      lp.handle(req("/list?_rsc=abc", { cookie, rsc: "1", referer }), ENV(), next);
    await rsc(`https://lianki.com/words?live=${ID}`);
    expect(upCalls).toHaveLength(1);
    expect(upCalls[0].headers.get("rsc")).toBe("1");
    expect(upCalls[0].headers.get("referer")).toBeNull();
    // Another, normal tab with the same cookie stays on production.
    await rsc("https://lianki.com/words");
    await rsc(`https://evil.example/words?live=${ID}`);
    expect(upCalls).toHaveLength(1);
  });

  test("never /api, /auth, /_lk, a POST, or a service worker script", async () => {
    const { lp, cookie } = await enter();
    upCalls = [];
    for (const p of [
      "/api/words",
      "/api/auth/get-session",
      "/auth/callback",
      "/_lk/up",
      `/api/x?live=${ID}`,
    ])
      await lp.handle(req(p, { cookie, ...DOC }), ENV(), next);
    await lp.handle(req(`/words?live=${ID}`, { cookie, ...DOC }, "POST"), ENV(), next);
    expect(upCalls).toHaveLength(0);
    const sw = await lp.handle(req("/_next/static/sw.js", { cookie }), ENV(), next);
    expect(sw.status).toBe(403);
    const sw2 = await lp.handle(
      req("/_next/static/chunks/a.js", { cookie, "service-worker": "script" }),
      ENV(),
      next,
    );
    expect(sw2.status).toBe(403);
    expect(upCalls).toHaveLength(0);
  });

  test("the HMR socket: upgraded, and its 101 filtered", async () => {
    const { lp, cookie } = await enter();
    upCalls = [];
    upstream = async () =>
      ({
        status: 101,
        statusText: "Switching Protocols",
        body: null,
        headers: new Headers({
          upgrade: "websocket",
          "sec-websocket-accept": "abc",
          "set-cookie": "s=1",
          "content-security-policy": "default-src *",
          "access-control-allow-origin": "*",
          "strict-transport-security": "max-age=0",
        }),
      }) as unknown as Response;
    const r = await lp.handle(
      req("/_next/webpack-hmr?id=1", {
        cookie,
        upgrade: "websocket",
        "sec-websocket-key": "k",
        "sec-websocket-version": "13",
      }),
      ENV(),
      next,
    );
    expect(upCalls[0].headers.get("upgrade")).toBe("websocket");
    expect(upCalls[0].headers.get("sec-websocket-key")).toBe("k");
    expect(upCalls[0].headers.get("cookie")).toBeNull();
    expect(r.headers.get("sec-websocket-accept")).toBe("abc");
    for (const k of ["set-cookie", "access-control-allow-origin", "strict-transport-security"])
      expect(r.headers.get(k)).toBeNull();
    expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  });
});

describe("host escapes", () => {
  test("upstreamUrl refuses anything that could leave the origin", () => {
    for (const p of [
      "//evil.example/x",
      "/\\evil.example",
      "/%2F%2Fevil.example",
      "/%2fevil",
      "/%5Cevil",
      "/@evil.example",
      "/a/%40evil",
      "/%00",
    ])
      expect(upstreamUrl(PAGE, new URL(`https://lianki.com${p}`))).toBeNull();
    // new URL() reads "/\evil" as "//evil": still refused, above. A fine path:
    expect(upstreamUrl(PAGE, new URL("https://lianki.com/words?a=1&live=7"))?.href).toBe(
      `${PAGE}/words?a=1`,
    );
    // Next's chunk names may carry "@" (scoped packages): fine there, same origin.
    expect(
      upstreamUrl(PAGE, new URL("https://lianki.com/_next/static/chunks/@swc_a.js"))?.origin,
    ).toBe(PAGE);
  });

  test("a live document with such a path: production with the notice, the tunnel never asked", async () => {
    for (const p of ["//evil.example/x", "/%2F%2Fevil.example", "/%5Cevil", "/@evil.example"]) {
      const r = await live().handle(
        new Request(`https://lianki.com${p}?live=${ID}`, {
          headers: { ...DOC, cookie: OWNER_COOKIE },
        }),
        ENV(),
        next,
      );
      expect(await r.text()).toContain("lk-live-notice");
    }
    expect(upCalls).toHaveLength(0);
  });
});

describe("redirects", () => {
  test("relative or on the tunnel → the same path on lianki.com, still live; elsewhere unchanged", () => {
    expect(rewriteLocation("/sign-in?next=/x", PAGE, ID)).toBe(`/sign-in?next=%2Fx&live=${ID}`);
    expect(rewriteLocation(`${PAGE}/a#h`, PAGE, ID)).toBe(`/a?live=${ID}#h`);
    expect(rewriteLocation("b", PAGE, ID)).toBe(`/b?live=${ID}`);
    expect(rewriteLocation("https://evil.example/", PAGE, ID)).toBe("https://evil.example/");
    expect(rewriteLocation("//evil.example/x", PAGE, ID)).toBe("//evil.example/x");
    // A tunnel URL whose path starts with "//" never becomes protocol-relative.
    expect(rewriteLocation(`${PAGE}//evil.example/x`, PAGE, ID)).toBe(`/evil.example/x?live=${ID}`);
  });

  test("a dev redirect through the Worker", async () => {
    upstream = async () =>
      new Response(null, { status: 307, headers: { location: `${PAGE}/list` } });
    const { r } = await enter();
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe(`/list?live=${ID}`);
  });
});

describe("expiry, revoke, leaving", () => {
  test("a pointer past its expiry, or cleared: production with the notice, the cookie cleared", async () => {
    t = T0 + 3600_001;
    const late = await live().handle(
      req(`/words?live=${ID}`, { ...DOC, cookie: OWNER_COOKIE }),
      ENV(),
      next,
    );
    expect(await late.text()).toContain("no such preview");
    t = T0;
    await clearPointer(db, T0);
    const off = await live().handle(
      req(`/words?live=${ID}`, { ...DOC, cookie: OWNER_COOKIE }),
      ENV(),
      next,
    );
    expect(await off.text()).toContain("lk-live-notice");
    expect(off.headers.getSetCookie().some((c) => c.startsWith(`${LIVE_COOKIE}=;`))).toBe(true);
    expect(upCalls).toHaveLength(0);
  });

  test("revoked while browsing: subresources back on production within the cache window", async () => {
    const { lp, cookie } = await enter();
    upCalls = [];
    await clearPointer(db, T0);
    t = T0 + POINTER_CACHE_MS + 1;
    const r = await lp.handle(req("/_next/static/chunks/a.js", { cookie }), ENV(), next);
    expect(await r.text()).toContain("prod");
    expect(upCalls).toHaveLength(0);
  });

  test("the cookie never outlives the pointer", async () => {
    t = T0 + 3000_000; // 10 min left on the pointer
    const { r } = await enter();
    expect(r.headers.getSetCookie()[0]).toContain("Max-Age=600");
  });

  test("a document without ?live clears live mode", async () => {
    const { lp, cookie } = await enter();
    upCalls = [];
    const r = await lp.handle(
      req("/words", { ...DOC, cookie: `${OWNER_COOKIE}; ${cookie}` }),
      ENV(),
      next,
    );
    expect(await r.text()).toContain("prod");
    expect(r.headers.getSetCookie()).toContain(
      `${LIVE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
    expect(upCalls).toHaveLength(0);
  });
});

describe("the tunnel down", () => {
  test("unreachable, timing out or 5xx: the production page with 预览不可用, never a 502", async () => {
    for (const fail of [
      async () => {
        throw new Error("connect refused");
      },
      async () => new Response("503 — Lianki dev server: busy", { status: 503 }),
      async () => new Response("bad gateway", { status: 502 }),
    ]) {
      upstream = fail;
      const r = await live().handle(
        req(`/words?live=${ID}`, { ...DOC, cookie: OWNER_COOKIE }),
        ENV(),
        next,
      );
      expect(r.status).toBe(200);
      const body = await r.text();
      expect(body).toContain("prod");
      expect(body).toContain("预览不可用");
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("a chunk that fails: 504 (the router then loads the page from production)", async () => {
    const { lp, cookie } = await enter();
    upstream = async () => {
      throw new Error("down");
    };
    const r = await lp.handle(req("/_next/static/chunks/a.js", { cookie }), ENV(), next);
    expect(r.status).toBe(504);
  });
});

describe("pieces", () => {
  test("request kinds", () => {
    const k = (path: string, h: Record<string, string> = {}, m = "GET") =>
      requestKind(req(path, h, m), new URL(`https://lianki.com${path}`));
    expect(k("/words", DOC)).toBe("document");
    expect(k("/words", { accept: "text/html" })).toBe("document");
    expect(k("/words", { "sec-fetch-dest": "iframe", accept: "text/html" })).toBe("other");
    expect(k("/words", { rsc: "1" })).toBe("rsc");
    expect(k("/_next/static/a.js")).toBe("asset");
    expect(k("/__nextjs_original-stack-frames")).toBe("asset");
    expect(k("/_next/webpack-hmr", { upgrade: "websocket" })).toBe("socket");
    expect(k("/api/version/ws", { upgrade: "websocket" })).toBe("other");
    expect(k("/api/x", DOC)).toBe("other");
    expect(k("/words", DOC, "POST")).toBe("other");
  });

  test("the cookie: sealed, tamper-evident, lapses", async () => {
    const v = await sealLiveCookie(SECRET, { serial: 5, until: 1000 });
    expect(await openLiveCookie(SECRET, v, 999)).toEqual({ serial: 5, until: 1000 });
    expect(await openLiveCookie(SECRET, v, 1000)).toBeNull();
    expect(await openLiveCookie("x".repeat(64), v, 0)).toBeNull();
    expect(await openLiveCookie(SECRET, v.replace(/^5\./, "6."), 0)).toBeNull();
    expect(await openLiveCookie(SECRET, undefined, 0)).toBeNull();
  });

  test("the badge: the stop link, the storm guard's numbers from the dev server's guard", () => {
    const h = badgeHtml(ID, "feat/x@abcdef1", "/words?live=off");
    expect(h).toContain('href="/words?live=off"');
    expect(h).toContain(`N=${STORM_LOADS},W=${STORM_WINDOW_MS}`);
    expect(STORM_LOADS).toBe(6);
    expect(STORM_WINDOW_MS).toBe(20_000);
    expect(h).toContain("pushState");
    expect(badgeHtml(ID, "<script>", "/")).not.toContain("<script>·");
    expect(badgeHtml(ID, "<b>", "/")).toContain("&lt;b&gt;");
  });
});

describe("the pointer's page origin", () => {
  test("exact origins only: the gate's host, or a quick tunnel; never for JS", () => {
    expect(livePageOk(PAGE)).toBe(true);
    expect(livePageOk("https://brave-cat-12.trycloudflare.com")).toBe(true);
    expect(LIVE_QUICK_TUNNEL.test("https://a.b.trycloudflare.com")).toBe(false);
    for (const bad of [
      `${PAGE}/`,
      `${PAGE}/x`,
      `${PAGE}?a=1`,
      "http://preview.lianki.com",
      "https://evil.lianki.com",
      "https://user@preview.lianki.com",
      "https://preview.lianki.com:8443",
      "https://x.trycloudflare.com.evil.example",
      "http://localhost:3104",
    ])
      expect(livePageOk(bad)).toBe(false);
    expect(livePageOk("http://localhost:3104", true)).toBe(true);
    expect(liveSourceOk("https://brave-cat-12.trycloudflare.com/debug-chat.js")).toBe(false);
  });

  test("a page-only pointer verifies; a bad page is a bad source", async () => {
    const ok = await verifyLiveView(await pointer(), [PUB], { op: "on", now: T0 });
    expect(ok.ok && ok.claim.page).toBe(PAGE);
    const bad = await verifyLiveView(
      await pointer(SERIAL, { page: "https://evil.example" }),
      [PUB],
      {
        op: "on",
        now: T0,
      },
    );
    expect(bad).toEqual({ ok: false, error: "bad source" });
    const none = await verifyLiveView(await pointer(SERIAL, { page: undefined }), [PUB], {
      now: T0,
    });
    expect(none).toEqual({ ok: false, error: "no source" });
  });

  test("a pointer without a page never makes a live page", async () => {
    await writeSigned(
      db,
      await pointer(SERIAL + 1, { page: undefined, widget: "https://taku.onca-tint.ts.net/w.js" }),
      SERIAL + 1,
      T0,
    );
    const r = await live().handle(
      req(`/words?live=${SERIAL + 1}`, { ...DOC, cookie: OWNER_COOKIE }),
      ENV(),
      next,
    );
    expect(await r.text()).toContain("lk-live-notice");
    expect(upCalls).toHaveLength(0);
  });
});

describe("the gate's Worker entry", () => {
  const HOST = "preview.lianki.com";
  const gate = (liveSecret?: string) =>
    createGate({
      publicHost: HOST,
      ownerEmail: "o@example.com",
      sessionKey: "k".repeat(64),
      liveSecret,
      verify: async () => null,
      active: async () => [],
    });
  const call = (g: ReturnType<typeof gate>, v: string, ip = "198.51.100.1") =>
    g.handle({
      method: "GET",
      url: "/words",
      headers: { host: HOST, [LIVE_GATE_HEADER]: v, "cf-connecting-ip": ip },
    });

  test("the exact secret: forwarded as the Worker, no token re-checks", async () => {
    const r = await call(gate(SECRET), SECRET);
    expect(r).toMatchObject({ kind: "forward", tokenId: WORKER_TOKEN_ID, via: "worker" });
  });

  test("a wrong secret, or none configured: 503, and failures count per IP", async () => {
    for (const [s, v] of [
      [SECRET, `${SECRET}x`],
      [SECRET, "s".repeat(63)],
      [undefined, SECRET],
      ["short", "short"],
    ] as const) {
      const r = await call(gate(s), v);
      expect(r.kind === "respond" && r.status).toBe(503);
    }
    const g = gate(SECRET);
    for (let i = 0; i < FAILS_PER_IP; i++) await call(g, "nope");
    const blocked = await call(g, SECRET);
    expect(blocked.kind === "respond" && blocked.status).toBe(429);
    expect((await call(g, SECRET, "198.51.100.2")).kind).toBe("forward");
  });

  test("the secret never goes past the gate", () => {
    const up = gateUpstream(
      { [LIVE_GATE_HEADER]: SECRET, host: HOST, accept: "text/html" },
      { publicHost: HOST, origin: "http://127.0.0.1:3101", drop: [] },
    );
    expect(up[LIVE_GATE_HEADER]).toBeUndefined();
    expect(up.accept).toBe("text/html");
  });
});

describe("the defaults (as in worker.ts)", () => {
  test("the owner is asked of the app's own /api/dev/whoami, with the viewer's cookie only", async () => {
    const seen: Request[] = [];
    const lp = createLivePage({
      keys: async () => [PUB],
      now: () => t,
      fetch: async (r) => {
        upCalls.push(r);
        return upstream(r);
      },
    });
    const app = async (r: Request) => {
      seen.push(r);
      if (new URL(r.url).pathname === "/api/dev/whoami")
        return r.headers.get("cookie")?.includes("session_token=owner")
          ? Response.json({ owner: true })
          : Response.json({ error: "Not found" }, { status: 404 });
      return next(r);
    };
    const doc = (cookie: string) =>
      lp.handle(req(`/words?live=${ID}`, { ...DOC, cookie, referer: "https://x/" }), ENV(), app);
    expect(await (await doc("__Secure-better-auth.session_token=friend")).text()).toContain("prod");
    expect(await (await doc("no-session=1")).text()).toContain("prod");
    expect(upCalls).toHaveLength(0);
    expect(await (await doc("__Secure-better-auth.session_token=owner")).text()).toContain(
      "dev page",
    );
    const who = seen.filter((r) => r.url.endsWith("/api/dev/whoami"));
    expect(who).toHaveLength(2); // a viewer with no session is never even asked about
    expect([...who[0].headers.keys()]).toEqual(["cookie"]);
    // An app that throws counts as "not the owner".
    const r = await lp.handle(
      req(`/words?live=${ID}`, { ...DOC, cookie: "__Secure-better-auth.session_token=owner" }),
      ENV(),
      async (q) => {
        if (q.url.endsWith("/whoami")) throw new Error("boom");
        return next(q);
      },
    );
    expect(await r.text()).toContain("prod");
  });

  test("the committed keys: a pointer signed by any other key is never live", async () => {
    const lp = createLivePage({
      now: () => t,
      isOwner: async () => true,
      fetch: async () => upstream(req("/")),
    });
    const r = await lp.handle(req(`/words?live=${ID}`, DOC), ENV(), next);
    expect(await r.text()).toContain("no such preview");
  });

  test("no D1 table, or no websocket support: never live, never a throw", async () => {
    const r = await live().handle(
      req(`/words?live=${ID}`, { ...DOC, cookie: OWNER_COOKIE }),
      { DB: createTestD1("") as never, LIVE_GATE_SECRET: SECRET },
      next,
    );
    expect(await r.text()).toContain("no such preview");
    const bare = createLivePage({
      keys: async () => [PUB],
      now: () => t,
      isOwner: async () => true,
      fetch: async (r) =>
        r.headers.get("upgrade")
          ? ({
              status: 101,
              statusText: "",
              body: null,
              headers: new Headers(),
            } as unknown as Response)
          : upstream(r),
    });
    const { cookie } = await enter(bare);
    const ws = await bare.handle(
      req("/_next/webpack-hmr", { cookie, upgrade: "websocket" }),
      ENV(),
      next,
    );
    expect(ws.status).toBe(502);
  });
});

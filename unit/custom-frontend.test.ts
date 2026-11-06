/**
 * Custom frontends (lib/live-view/custom.ts, the custom branch of
 * lib/live-view/page-proxy.ts; docs/custom-frontend.md): the target rule,
 * the store (allowlist, the cap in one INSERT, expiry, revoke, audit), and
 * the proxy: only the registrant sees it, anyone else gets production and
 * the cookie cleared; nothing of the viewer (and no gate secret) goes up;
 * the strict CSP and its nonce; /api never proxied, account-level writes
 * refused; host escapes; the flag, revoke and allowlist removal end it.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  CUSTOM_CAP,
  CUSTOM_FRONTEND_FLAG,
  allowByEmail,
  createPreview,
  customCsp,
  customHours,
  customTarget,
  disallow,
  isCustomId,
  listAllPreviews,
  listAllowed,
  listPreviews,
  newCustomId,
  openCustomCookie,
  previewFor,
  revokePreview,
  sealCustomCookie,
  sessionTag,
  type CustomDb,
} from "@/lib/live-view/custom";
import {
  LIVE_COOKIE,
  LIVE_GATE_HEADER,
  LIVE_ID_HEADER,
  POINTER_CACHE_MS,
  createLivePage,
  customFrontendBlocked,
  mayBeBlockedWrite,
} from "@/lib/live-view/page-proxy";

const SECRET = "s".repeat(64);
const T0 = Date.parse("2026-11-05T06:00:00Z");
const TUNNEL = "https://kind-words-here.trycloudflare.com";
const KISHO = "u_kisho";
const OTHER = "u_other";
const OWNER = "u_owner";
const SESS: Record<string, string> = { "tok-k.sig": KISHO, "tok-o.sig": OTHER, "tok-w.sig": OWNER };
const cookieFor = (tok: string, extra = "") =>
  `__Host-better-auth.session_token=${tok}${extra ? `; ${extra}` : ""}`;

let raw: TestD1Database;
let db: CustomDb;
let t: number;
let upCalls: Request[];
let nextCalls: Request[];
let upstream: (r: Request) => Promise<Response>;

const next = async (r: Request) => {
  nextCalls.push(r);
  return new Response("<html><body>prod</body></html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

async function flag(on: boolean) {
  await raw
    .prepare(
      `INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?1, ?2, 'x', 'x')
       ON CONFLICT(key) DO UPDATE SET enabled = ?2`,
    )
    .bind(CUSTOM_FRONTEND_FLAG, on ? 1 : 0)
    .run();
}
async function flagOn() {
  const r = await raw
    .prepare("SELECT enabled FROM feature_flags WHERE key = ?1")
    .bind(CUSTOM_FRONTEND_FLAG)
    .first<{ enabled: number }>();
  return r?.enabled === 1;
}

/** The app's GET /api/live-previews/<id>, in miniature: the session's user, the flag, previewFor. */
function live() {
  return createLivePage({
    now: () => t,
    keys: async () => [],
    isOwner: async () => false,
    resolveCustom: async (r, id) => {
      const m = /better-auth\.session_token=([^;]+)/.exec(r.headers.get("cookie") ?? "");
      const userId = m ? SESS[m[1]] : undefined;
      if (!userId) return null;
      const owner = userId === OWNER;
      const p = await previewFor(db, id, { userId, owner, flagOn: await flagOn() }, t);
      return p ? { id, target: p.target, expiresAt: p.expiresAt, userId, owner } : null;
    },
    fetch: async (r) => {
      upCalls.push(r);
      return upstream(r);
    },
    respond101: (_up, h) => new Response("upgraded", { status: 200, headers: h }),
  });
}

const ENV = () => ({ DB: db as never, LIVE_GATE_SECRET: SECRET });
const DOC = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", accept: "text/html" };
const req = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://lianki.com${path}`, { method, headers });

async function user(id: string, email: string) {
  await raw
    .prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?1, ?1, ?2, 1, 'x', 'x')",
    )
    .bind(id, email)
    .run();
}

beforeEach(async () => {
  raw = createTestD1(testSchema());
  db = raw as unknown as CustomDb;
  t = T0;
  upCalls = [];
  nextCalls = [];
  upstream = async () =>
    new Response(
      '<html><head><script>self.__next_f=[]</script><script src="/_next/static/a.js"></script></head><body>custom page</body></html>',
      {
        headers: {
          "content-type": "text/html",
          "set-cookie": "evil=1; Path=/",
          "content-security-policy": "script-src *",
          "access-control-allow-origin": "*",
          "clear-site-data": '"*"',
        },
      },
    );
  await user(KISHO, "kisho@example.com");
  await user(OTHER, "other@example.com");
  await user(OWNER, "owner@example.com");
  await flag(true);
  await allowByEmail(db, "KISHO@example.com", OWNER, T0);
});

async function register(hours = 8) {
  const r = await createPreview(db, { userId: KISHO, target: TUNNEL, hours, owner: false, now: t });
  if (!r.ok) throw new Error(r.error);
  return r.preview.id;
}

/** Kisho opens his own preview: the response and the live cookie it set. */
async function enter(lp = live(), id?: string) {
  id ??= await register();
  const r = await lp.handle(
    req(`/words?x=1&live=${id}`, { ...DOC, cookie: cookieFor("tok-k.sig") }),
    ENV(),
    next,
  );
  const sc = r.headers.getSetCookie().find((c) => c.startsWith(`${LIVE_COOKIE}=`)) ?? "";
  return { r, lp, id, cookie: sc.split(";")[0] };
}

describe("the target rule", () => {
  test("a quick tunnel's bare origin, or an exact allowlisted host", () => {
    expect(customTarget(TUNNEL)).toBe(TUNNEL);
    expect(customTarget(`${TUNNEL}/`)).toBe(TUNNEL);
    expect(customTarget("https://mine.example.org", ["mine.example.org"])).toBe(
      "https://mine.example.org",
    );
    for (const bad of [
      "http://a.trycloudflare.com",
      "https://a.trycloudflare.com:8443",
      "https://a.trycloudflare.com/path",
      "https://a.trycloudflare.com/?q=1",
      "https://a.trycloudflare.com#x",
      "https://u:p@a.trycloudflare.com",
      "https://u@a.trycloudflare.com",
      "https://a.b.trycloudflare.com",
      "https://trycloudflare.com",
      "https://A.trycloudflare.com",
      "https://a.trycloudflare.com.evil.com",
      "https://evil.com/.trycloudflare.com",
      "https://lianki.com",
      "https://mine.example.org",
      "https://a--.trycloudflare.com",
      "https://a.trycloudflare.com\\@evil.com",
      " https://a.trycloudflare.com",
      "https://" + "a".repeat(100) + ".trycloudflare.com",
      42,
      null,
    ])
      expect({ bad, ok: customTarget(bad) }).toEqual({ bad, ok: null });
  });

  test("ids are 128-bit base64url; hours in (0, 8]", () => {
    const id = newCustomId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(isCustomId(id)).toBe(true);
    expect(isCustomId("1793000000000")).toBe(false);
    expect(new Set(Array.from({ length: 200 }, newCustomId)).size).toBe(200);
    expect(customHours(undefined)).toBe(8);
    expect(customHours(2.5)).toBe(2.5);
    for (const h of [0, -1, 8.01, 24, "8", NaN, Infinity]) expect(customHours(h)).toBeNull();
  });
});

describe("the store", () => {
  test("only allowlisted users (or the owner) can register", async () => {
    const no = await createPreview(db, { userId: OTHER, target: TUNNEL, hours: 1, owner: false });
    expect(no).toEqual({ ok: false, error: "not-allowed" });
    const own = await createPreview(db, { userId: OWNER, target: TUNNEL, hours: 1, owner: true });
    expect(own.ok).toBe(true);
  });

  test("the cap holds under a race: one conditional INSERT", async () => {
    const all = await Promise.all(
      Array.from({ length: 10 }, () =>
        createPreview(db, { userId: KISHO, target: TUNNEL, hours: 1, owner: false, now: t }),
      ),
    );
    expect(all.filter((r) => r.ok)).toHaveLength(CUSTOM_CAP);
    expect(all.filter((r) => !r.ok && r.error === "cap")).toHaveLength(10 - CUSTOM_CAP);
    const n = await raw
      .prepare("SELECT COUNT(*) AS n FROM live_preview WHERE user_id = ?1")
      .bind(KISHO)
      .first<{ n: number }>();
    expect(n?.n).toBe(CUSTOM_CAP);
    // An expired one frees a slot.
    t += 3_600_001;
    expect(
      (await createPreview(db, { userId: KISHO, target: TUNNEL, hours: 1, owner: false, now: t }))
        .ok,
    ).toBe(true);
  });

  test("expiry ≤ 8 h, registrant-only lookup, revoke, audit", async () => {
    const id = await register(8);
    const v = { userId: KISHO, owner: false, flagOn: true };
    expect((await previewFor(db, id, v, t))?.expiresAt).toBe(T0 + 8 * 3_600_000);
    expect(await previewFor(db, id, { ...v, userId: OTHER }, t)).toBeNull();
    expect(await previewFor(db, id, { userId: OWNER, owner: true, flagOn: true }, t)).toBeNull();
    expect(await previewFor(db, id, { ...v, flagOn: false }, t)).toBeNull();
    expect(await previewFor(db, id, v, T0 + 8 * 3_600_000)).toBeNull();
    expect(await revokePreview(db, id, { userId: OTHER, owner: false }, t)).toBe(false);
    expect(await revokePreview(db, id, { userId: KISHO, owner: false }, t)).toBe(true);
    expect(await previewFor(db, id, v, t)).toBeNull();
    expect(await listPreviews(db, KISHO, t)).toEqual([]);
    const { results } = await raw
      .prepare(
        "SELECT kind, actor, subject FROM security_audit WHERE kind NOT LIKE 'site-role.%' ORDER BY id",
      )
      .all<{ kind: string; actor: string; subject: string }>();
    expect(results.map((r) => r.kind)).toEqual([
      "live-frontend.allow",
      "live-preview.create",
      "live-preview.revoke",
    ]);
    expect(JSON.stringify(results)).not.toContain(SECRET);
  });

  test("removing a user from the allowlist revokes their previews", async () => {
    const id = await register();
    expect((await listAllowed(db)).map((a) => a.email)).toEqual(["kisho@example.com"]);
    expect(await allowByEmail(db, "nobody@example.com", OWNER, t)).toBeNull();
    expect((await listAllPreviews(db, t)).map((p) => [p.id, p.email])).toEqual([
      [id, "kisho@example.com"],
    ]);
    expect(await disallow(db, KISHO, OWNER, t)).toBe(true);
    expect(await previewFor(db, id, { userId: KISHO, owner: false, flagOn: true }, t)).toBeNull();
    expect(
      (await createPreview(db, { userId: KISHO, target: TUNNEL, hours: 1, owner: false })).ok,
    ).toBe(false);
  });

  test("the cookie: sealed, bound to its session, lapses", async () => {
    const c = {
      id: newCustomId(),
      userId: KISHO,
      until: T0 + 1000,
      owner: false,
      session: await sessionTag("tok"),
    };
    const v = await sealCustomCookie(SECRET, c);
    expect(await openCustomCookie(SECRET, v, T0)).toEqual(c);
    expect(await openCustomCookie("x".repeat(64), v, T0)).toBeNull();
    expect(await openCustomCookie(SECRET, v.replace(KISHO, OTHER), T0)).toBeNull();
    expect(await openCustomCookie(SECRET, v.replace(".0.", ".1."), T0)).toBeNull();
    expect(await openCustomCookie(SECRET, v, T0 + 1000)).toBeNull();
  });
});

describe("who sees a custom frontend", () => {
  test("anyone but the registrant (or signed out): production, cookie cleared, nothing fetched", async () => {
    const id = await register();
    for (const cookie of [
      "",
      cookieFor("tok-o.sig"),
      cookieFor("tok-w.sig"),
      cookieFor("forged.sig"),
    ]) {
      const r = await live().handle(req(`/words?live=${id}`, { ...DOC, cookie }), ENV(), next);
      expect(await r.text()).toContain("prod");
      expect(r.headers.get(LIVE_ID_HEADER)).toBeNull();
      const sc = r.headers.getSetCookie().filter((c) => c.startsWith(`${LIVE_COOKIE}=`));
      expect(sc).toEqual([`${LIVE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`]);
    }
    // An id that does not exist looks exactly the same.
    const r = await live().handle(
      req(`/words?live=${newCustomId()}`, { ...DOC, cookie: cookieFor("tok-k.sig") }),
      ENV(),
      next,
    );
    expect(await r.text()).toContain("prod");
    expect(upCalls).toHaveLength(0);
  });

  test("the registrant: the tunnel's page, filtered, strict CSP, nonce on every script", async () => {
    const { r, id, cookie } = await enter();
    expect(upCalls).toHaveLength(1);
    expect(upCalls[0].url).toBe(`${TUNNEL}/words?x=1`);
    const body = await r.text();
    expect(body).toContain("custom page");
    expect(body).toContain('id="lk-live-badge"');
    const csp = r.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toBe(customCsp(TUNNEL, "https://lianki.com", nonce));
    expect(csp).toContain(
      `connect-src 'self' wss://lianki.com ${TUNNEL} wss://kind-words-here.trycloudflare.com;`,
    );
    expect(csp).toContain(`script-src 'self' ${TUNNEL} 'unsafe-eval' 'nonce-${nonce}';`);
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("unsafe-inline' " + TUNNEL + " 'unsafe-eval");
    expect(/script-src[^;]*'unsafe-inline'/.test(csp)).toBe(false);
    expect(/script-src[^;]*\*/.test(csp)).toBe(false);
    // Every <script>, the dev page's and the badge's, carries the nonce.
    const scripts = body.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBe(3);
    for (const s of scripts) expect(s).toContain(`nonce="${nonce}"`);
    expect(r.headers.get(LIVE_ID_HEADER)).toBe(id);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("clear-site-data")).toBeNull();
    const sc = r.headers.getSetCookie();
    expect(sc).toHaveLength(1);
    expect(cookie.startsWith(`${LIVE_COOKIE}=c.${id}.${KISHO}.`)).toBe(true);
  });

  test("nothing of the viewer and no gate secret reaches the tunnel; Origin is the tunnel's", async () => {
    const id = await register();
    await live().handle(
      req(`/words?live=${id}`, {
        ...DOC,
        cookie: cookieFor("tok-k.sig", "lang=zh"),
        authorization: "Bearer lk_x",
        "cf-connecting-ip": "203.0.113.9",
        "cf-access-jwt-assertion": "jwt",
        "x-forwarded-for": "1.2.3.4",
        referer: "https://lianki.com/secret?token=x",
        origin: "https://lianki.com",
        [LIVE_GATE_HEADER]: "client-sent",
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
      "referer",
      LIVE_GATE_HEADER,
    ])
      expect({ k, v: h.get(k) }).toEqual({ k, v: null });
    expect(h.get("origin")).toBe(TUNNEL);
    expect(h.get("accept-language")).toBe("zh");
  });

  test("the flag off: only the owner's own still work; kisho gets production", async () => {
    const id = await register();
    await flag(false);
    const r = await live().handle(
      req(`/words?live=${id}`, { ...DOC, cookie: cookieFor("tok-k.sig") }),
      ENV(),
      next,
    );
    expect(await r.text()).toContain("prod");
    const own = await createPreview(db, {
      userId: OWNER,
      target: TUNNEL,
      hours: 1,
      owner: true,
      now: t,
    });
    if (!own.ok) throw new Error("owner");
    const o = await live().handle(
      req(`/?live=${own.preview.id}`, { ...DOC, cookie: cookieFor("tok-w.sig") }),
      ENV(),
      next,
    );
    expect(await o.text()).toContain("custom page");
  });

  test("tunnel down or 5xx: production with the notice, cookie cleared", async () => {
    const id = await register();
    upstream = async () => {
      throw new Error("down");
    };
    const r = await live().handle(
      req(`/words?live=${id}`, { ...DOC, cookie: cookieFor("tok-k.sig") }),
      ENV(),
      next,
    );
    expect(await r.text()).toContain("lk-live-notice");
    expect(r.headers.getSetCookie().join()).toContain("Max-Age=0");
  });
});

describe("subresources and the backend", () => {
  test("/_next chunks follow the cookie, with the CSP; the session must match", async () => {
    const { lp, cookie } = await enter();
    upstream = async () =>
      new Response("chunk", { headers: { "content-type": "text/javascript" } });
    const ok = await lp.handle(
      req("/_next/static/chunks/a.js", { cookie: `${cookie}; ${cookieFor("tok-k.sig")}` }),
      ENV(),
      next,
    );
    expect(await ok.text()).toBe("chunk");
    expect(upCalls.at(-1)?.url).toBe(`${TUNNEL}/_next/static/chunks/a.js`);
    expect(upCalls.at(-1)?.headers.get("cookie")).toBeNull();
    expect(ok.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const n = upCalls.length;
    // The same live cookie with another account's session (or none): production.
    for (const c of [`${cookie}; ${cookieFor("tok-o.sig")}`, cookie]) {
      const r = await lp.handle(req("/_next/static/chunks/a.js", { cookie: c }), ENV(), next);
      expect(await r.text()).toContain("prod");
    }
    expect(upCalls).toHaveLength(n);
  });

  test("/api and /auth are never proxied; account-level writes are refused", async () => {
    const { lp, cookie } = await enter();
    const n = upCalls.length;
    const both = `${cookie}; ${cookieFor("tok-k.sig")}`;
    for (const p of ["/api/words/lists", "/api/fsrs/next-url", "/auth/x", "/_lk/y"]) {
      const r = await lp.handle(req(p, { cookie: both, ...DOC }), ENV(), next);
      expect(await r.text()).toContain("prod");
    }
    const post = await lp.handle(
      req(
        "/api/words/lists/1/review",
        { cookie: both, "content-type": "application/json" },
        "POST",
      ),
      ENV(),
      next,
    );
    expect(post.status).toBe(200);
    for (const [m, p] of [
      ["POST", "/api/token"],
      ["POST", "/api/dev/flags"],
      ["DELETE", "/api/dev/tokens/x"],
      ["POST", "/api/live-previews"],
      ["POST", "/api/auth/update-user"],
      ["POST", "/api/auth/link-social"],
      ["POST", "/API/Token/"],
      ["POST", "/api/cli-login/approve"],
    ]) {
      const r = await lp.handle(req(p, { cookie: both }, m), ENV(), next);
      expect({ p, s: r.status }).toEqual({ p, s: 403 });
    }
    expect(upCalls).toHaveLength(n);
    expect(customFrontendBlocked("POST", "/api/auth/sign-out")).toBe(false);
    expect(customFrontendBlocked("GET", "/api/dev/whoami")).toBe(false);
    expect(customFrontendBlocked("POST", "/api/read/x/grade")).toBe(false);
  });

  test("a normal page load clears the cookie, but the session stays blocked", async () => {
    const { lp, cookie } = await enter();
    const session = cookieFor("tok-k.sig");
    // In another tab: a document without ?live clears the live cookie.
    const plain = await lp.handle(
      req("/en", { ...DOC, cookie: `${cookie}; ${session}` }),
      ENV(),
      next,
    );
    expect(plain.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    // The frontend's tab is still running, now with the session cookie alone.
    for (const [m, p] of [
      ["POST", "/api/token"],
      ["DELETE", "/API/Token/x"],
      ["POST", "/api/dev/flags"],
      ["POST", "/api/cli-login/approve"],
      ["POST", "/api/auth/update-user"],
    ]) {
      const r = await lp.handle(req(p, { cookie: session }, m), ENV(), next);
      expect({ p, s: r.status }).toEqual({ p, s: 403 });
      expect((await r.json()).error).toContain("Sign out and sign in again");
    }
    expect(mayBeBlockedWrite(req("/api/token", { cookie: session }, "POST"))).toBe(true);
  });

  test("the blocked session can still leave, and use the app", async () => {
    const { lp } = await enter();
    const session = cookieFor("tok-k.sig");
    nextCalls = [];
    for (const [m, p] of [
      ["POST", "/api/auth/sign-out"],
      ["POST", "/api/read/x/grade"],
      ["POST", "/api/live-previews"],
      ["GET", "/api/token"],
    ]) {
      const r = await lp.handle(req(p, { cookie: session }, m), ENV(), next);
      expect({ p, s: r.status }).toEqual({ p, s: 200 });
    }
    expect(nextCalls).toHaveLength(4);
  });

  test("another session of the same user is not blocked, nor one that opened nothing", async () => {
    const { lp } = await enter();
    const r = await lp.handle(
      req("/api/token", { cookie: cookieFor("tok-other.sig") }, "POST"),
      ENV(),
      next,
    );
    expect(r.status).toBe(200);
  });

  test("the mark holds no token", async () => {
    await enter();
    const rows = raw.raw().prepare("SELECT tag FROM custom_live_session").all() as {
      tag: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tag).not.toContain("tok-k");
  });

  test("no mark, no frontend: the production page", async () => {
    const id = await register();
    const before = upCalls.length;
    const broken = {
      ...ENV(),
      DB: {
        prepare: (q: string) => {
          if (q.includes("custom_live_session")) throw new Error("d1");
          return (db as never as { prepare: (q: string) => unknown }).prepare(q);
        },
      } as never,
    };
    const r = await live().handle(
      req(`/en?live=${id}`, { ...DOC, cookie: cookieFor("tok-k.sig") }),
      broken,
      next,
    );
    expect(upCalls).toHaveLength(before);
    expect(await r.text()).toContain("prod");
  });

  test("a failed look-up refuses the write", async () => {
    const broken = {
      ...ENV(),
      DB: {
        prepare: () => {
          throw new Error("d1");
        },
      } as never,
    };
    const r = await live().handle(
      req("/api/token", { cookie: cookieFor("tok-k.sig") }, "POST"),
      broken,
      next,
    );
    expect(r.status).toBe(403);
  });

  test("a write with no session cookie, or to anything else, is never looked up", () => {
    expect(mayBeBlockedWrite(req("/api/token", {}, "POST"))).toBe(false);
    expect(mayBeBlockedWrite(req("/api/token", { cookie: "a=b" }, "POST"))).toBe(false);
    const s = cookieFor("t.s");
    expect(mayBeBlockedWrite(req("/api/read/x", { cookie: s }, "POST"))).toBe(false);
    expect(mayBeBlockedWrite(req("/api/token", { cookie: s }, "GET"))).toBe(false);
    expect(mayBeBlockedWrite(req("/api/auth/sign-out", { cookie: s }, "POST"))).toBe(false);
  });

  test("host-escape paths are refused; service worker scripts 403", async () => {
    const { lp, cookie } = await enter();
    const n = upCalls.length;
    const both = `${cookie}; ${cookieFor("tok-k.sig")}`;
    for (const p of [
      "/_next//evil.com/x",
      "/_next/%2F%2Fevil.com",
      "/_next/%5Cevil",
      "/_next/a%00b",
    ]) {
      const r = await lp.handle(req(p, { cookie: both }), ENV(), next);
      expect({ p, s: r.status }).toEqual({ p, s: 400 });
    }
    const doc = await lp.handle(
      req("/a@evil.com?live=" + (await register()), { ...DOC, cookie: cookieFor("tok-k.sig") }),
      ENV(),
      next,
    );
    expect(await doc.text()).toContain("path refused");
    const sw = await lp.handle(
      req("/_next/static/sw.js", { cookie: both, "service-worker": "script" }),
      ENV(),
      next,
    );
    expect(sw.status).toBe(403);
    expect(upCalls).toHaveLength(n);
  });

  test("revoke, removal or the flag off end subresources within the cache window", async () => {
    for (const end of ["revoke", "remove", "flag"] as const) {
      raw = createTestD1(testSchema());
      db = raw as unknown as CustomDb;
      t = T0;
      await user(KISHO, "kisho@example.com");
      await user(OWNER, "owner@example.com");
      await flag(true);
      await allowByEmail(db, "kisho@example.com", OWNER, T0);
      const { lp, id, cookie } = await enter();
      upstream = async () => new Response("chunk");
      const get = () =>
        lp.handle(
          req("/_next/static/a.js", { cookie: `${cookie}; ${cookieFor("tok-k.sig")}` }),
          ENV(),
          next,
        );
      expect(await (await get()).text()).toBe("chunk");
      if (end === "revoke") await revokePreview(db, id, { userId: KISHO, owner: false }, t);
      if (end === "remove") await disallow(db, KISHO, OWNER, t);
      if (end === "flag") await flag(false);
      t += POINTER_CACHE_MS;
      expect({ end, body: await (await get()).text() }).toEqual({
        end,
        body: "<html><body>prod</body></html>",
      });
    }
  });

  test("a subresource reads the flag under its old key until the new key has a row", async () => {
    const OLD = "live.custom-frontend";
    const setRow = (key: string, on: 0 | 1) =>
      raw
        .prepare(
          `INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?1, ?2, 'x', 'x')
           ON CONFLICT(key) DO UPDATE SET enabled = ?2`,
        )
        .bind(key, on)
        .run();
    const { lp, cookie } = await enter();
    upstream = async () => new Response("chunk");
    const get = async () => {
      t += POINTER_CACHE_MS;
      const r = await lp.handle(
        req("/_next/static/a.js", { cookie: `${cookie}; ${cookieFor("tok-k.sig")}` }),
        ENV(),
        next,
      );
      return r.text();
    };
    await raw.prepare("DELETE FROM feature_flags WHERE key = ?1").bind(CUSTOM_FRONTEND_FLAG).run();
    await setRow(OLD, 1);
    expect(await get()).toBe("chunk");
    await setRow(CUSTOM_FRONTEND_FLAG, 0);
    expect(await get()).toBe("<html><body>prod</body></html>");
  });

  test("the default resolver asks the app's /api/live-previews/<id> with the Cookie only", async () => {
    const id = await register();
    const asked: Request[] = [];
    const appNext = async (r: Request) => {
      const u = new URL(r.url);
      if (u.pathname.startsWith("/api/live-previews/")) {
        asked.push(r);
        const mine = (r.headers.get("cookie") ?? "").includes("tok-k.sig");
        const p = await previewFor(
          db,
          u.pathname.split("/").pop()!,
          {
            userId: mine ? KISHO : OTHER,
            owner: false,
            flagOn: true,
          },
          t,
        );
        if (!p) return new Response("{}", { status: 404 });
        return Response.json({ ...p, owner: false });
      }
      return next(r);
    };
    const lp = createLivePage({
      now: () => t,
      keys: async () => [],
      isOwner: async () => false,
      fetch: async (r) => {
        upCalls.push(r);
        return upstream(r);
      },
    });
    const mine = await lp.handle(
      req(`/?live=${id}`, { ...DOC, cookie: cookieFor("tok-k.sig"), authorization: "Bearer x" }),
      ENV(),
      appNext,
    );
    expect(await mine.text()).toContain("custom page");
    expect(asked[0].url).toBe(`https://lianki.com/api/live-previews/${id}`);
    expect([...asked[0].headers.keys()]).toEqual(["cookie"]);
    const theirs = await lp.handle(
      req(`/?live=${id}`, { ...DOC, cookie: cookieFor("tok-o.sig") }),
      ENV(),
      appNext,
    );
    expect(await theirs.text()).toContain("prod");
    // A malformed answer, or no session at all: production.
    const odd = createLivePage({ now: () => t, keys: async () => [], isOwner: async () => false });
    const bad = await odd.handle(
      req(`/?live=${id}`, { ...DOC, cookie: cookieFor("tok-k.sig") }),
      ENV(),
      async (r) =>
        new URL(r.url).pathname.startsWith("/api/") ? Response.json({ id, target: 1 }) : next(r),
    );
    expect(await bad.text()).toContain("prod");
    const thrown = await odd.handle(
      req(`/?live=${id}`, { ...DOC, cookie: cookieFor("tok-k.sig") }),
      ENV(),
      async (r) => {
        if (new URL(r.url).pathname.startsWith("/api/")) throw new Error("x");
        return next(r);
      },
    );
    expect(await thrown.text()).toContain("prod");
  });

  test("RSC fetches need the live Referer; the HMR socket goes up; 5xx and unreachable", async () => {
    const { lp, id, cookie } = await enter();
    const both = `${cookie}; ${cookieFor("tok-k.sig")}`;
    upstream = async () => new Response("rsc");
    const noRef = await lp.handle(req("/list", { cookie: both, rsc: "1" }), ENV(), next);
    expect(await noRef.text()).toContain("prod");
    const ref = await lp.handle(
      req("/list", { cookie: both, rsc: "1", referer: `https://lianki.com/words?live=${id}` }),
      ENV(),
      next,
    );
    expect(await ref.text()).toBe("rsc");
    upstream = async () => new Response(null, { status: 200, headers: { "x-up": "1" } });
    const ws = await lp.handle(
      req("/_next/webpack-hmr", {
        cookie: both,
        upgrade: "websocket",
        "sec-websocket-key": "k",
        "sec-websocket-version": "13",
        "sec-websocket-protocol": "vite-hmr",
      }),
      ENV(),
      next,
    );
    expect(ws.headers.get("content-security-policy")).toContain("connect-src");
    expect(upCalls.at(-1)?.headers.get("sec-websocket-protocol")).toBe("vite-hmr");
    expect(upCalls.at(-1)?.headers.get("cookie")).toBeNull();
    upstream = async () => {
      throw new Error("down");
    };
    const down = await lp.handle(req("/_next/a.js", { cookie: both }), ENV(), next);
    expect(down.status).toBe(504);
    upstream = async () => new Response("boom", { status: 502 });
    const five = await lp.handle(
      req(`/words?live=${id}`, { ...DOC, cookie: cookieFor("tok-k.sig") }),
      ENV(),
      next,
    );
    expect(await five.text()).toContain("dev server 502");
  });

  test("a 101 from the tunnel is filtered too", async () => {
    const lp = createLivePage({
      now: () => t,
      keys: async () => [],
      isOwner: async () => false,
      resolveCustom: async (_r, id) => {
        const p = await previewFor(db, id, { userId: KISHO, owner: false, flagOn: true }, t);
        return p && { id, target: p.target, expiresAt: p.expiresAt, userId: KISHO, owner: false };
      },
      fetch: async (r) =>
        r.headers.get("upgrade")
          ? ({ status: 101, headers: new Headers({ "set-cookie": "x=1" }) } as Response)
          : upstream(r),
    });
    const { cookie } = await enter(lp);
    const r = await lp.handle(
      req("/_next/webpack-hmr", {
        cookie: `${cookie}; ${cookieFor("tok-k.sig")}`,
        upgrade: "websocket",
      }),
      ENV(),
      next,
    );
    expect(r.status).toBe(502); // no respond101 given: never a raw upgrade
  });

  test("a document without ?live, or ?live=off, leaves", async () => {
    const { lp, cookie } = await enter();
    const plain = await lp.handle(req("/words", { ...DOC, cookie }), ENV(), next);
    expect(plain.headers.getSetCookie().join()).toContain("Max-Age=0");
    const off = await lp.handle(req("/words?live=off&a=1", { ...DOC, cookie }), ENV(), next);
    expect(off.status).toBe(303);
    expect(off.headers.get("location")).toBe("/words?a=1");
    expect(off.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

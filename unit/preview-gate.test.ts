/**
 * The tunnel gate in front of the whole-page dev server
 * (scripts/dev/preview-gate.ts): 503 without a valid dev token, the cookie
 * handshake, revocation ending sessions, the owner-only sign-in, Host-header
 * and identity-header bypass attempts, and what reaches the app.
 */
import { describe, expect, test } from "bun:test";
import {
  AUTH_PATH,
  DEFAULT_NEXT,
  FAILS_PER_IP,
  RECHECK_MS,
  SESSION_COOKIE,
  SESSION_MAX_MS,
  SIGN_OUT_PATH,
  UP_PATH,
  createGate,
  downstreamHeaders,
  handshakeHtml,
  openSession,
  safeNext,
  sealSession,
  upstreamHeaders,
  type GateResult,
  type Verified,
} from "../scripts/dev/preview-gate";

const HOST = "preview.lianki.com";
const OWNER = "owner@example.com";
const GOOD = `lkdev_${"g".repeat(43)}`;
const OTHER = `lkdev_${"o".repeat(43)}`; // minted by an account that is not the owner
const HANDOFF = `lkhand_${"h".repeat(43)}`;
const KEY = "k".repeat(64);
const ORIGIN = "https://mac.example.ts.net:8443";

function setup() {
  let t = 1_800_000_000_000;
  const revoked = new Set<string>();
  const verifyCalls: string[] = [];
  let handoffUsed = false;
  const logs: string[] = [];
  const gate = createGate({
    publicHost: HOST,
    ownerEmail: OWNER,
    sessionKey: KEY,
    now: () => t,
    log: (m) => logs.push(m),
    verify: async (token): Promise<Verified | null> => {
      verifyCalls.push(token);
      if (token === GOOD && !revoked.has("t1"))
        return { id: "t1", email: OWNER, kind: "token", sessionUntilMs: t + SESSION_MAX_MS };
      if (token === OTHER)
        return { id: "t9", email: "friend@example.com", kind: "token", sessionUntilMs: t + 1e7 };
      if (token === HANDOFF && !handoffUsed) {
        handoffUsed = true;
        return { id: "h1", email: OWNER, kind: "handoff", sessionUntilMs: t + SESSION_MAX_MS };
      }
      return null;
    },
    active: async (ids) => ids.filter((i) => !revoked.has(i)),
  });
  const req = (url: string, headers: Record<string, string> = {}, method = "GET", body = "") =>
    gate.handle({
      method,
      url,
      headers: { host: HOST, "cf-connecting-ip": "203.0.113.5", ...headers },
      body: async () => body,
    });
  const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    req(
      AUTH_PATH,
      { origin: `https://${HOST}`, ...headers },
      "POST",
      new URLSearchParams(fields).toString(),
    );
  const cookieOf = (r: GateResult) => {
    if (r.kind !== "respond") throw new Error("no response");
    const c = String(r.headers["set-cookie"]);
    return c.split(";")[0];
  };
  return {
    gate,
    req,
    post,
    cookieOf,
    revoked,
    verifyCalls,
    logs,
    advance: (ms: number) => (t += ms),
  };
}

const status = (r: GateResult) => (r.kind === "respond" ? r.status : "forward");

describe("no token, no entry: 503", () => {
  test("every path, static files and auth routes included", async () => {
    const h = setup();
    for (const p of [
      "/",
      "/words?list=all",
      "/_next/static/chunk.js",
      "/__dev/enter?t=x",
      "/__dev/landing",
      "/api/auth/get-session",
      "/api/auth/sign-in/email",
      "/api/dev-whole-page/login",
      "/lianki-widget/x.js",
      "/api/version/ws",
    ])
      expect([p, status(await h.req(p))]).toEqual([p, 503]);
  });

  test("a forged or foreign session cookie does nothing", async () => {
    const h = setup();
    const forged = await sealSession("not-the-key".repeat(4), { tid: "t1", exp: Date.now() + 1e9 });
    expect(status(await h.req("/", { cookie: `${SESSION_COOKIE}=${forged}` }))).toBe(503);
    expect(status(await h.req("/", { cookie: `${SESSION_COOKIE}=garbage` }))).toBe(503);
    // A better-auth owner cookie on its own is not a way in on the tunnel.
    expect(status(await h.req("/", { cookie: "__Secure-better-auth.session_token=abc.def" }))).toBe(
      503,
    );
  });

  test("the 503 never echoes or logs a token", async () => {
    const h = setup();
    const r = await h.post({ token: `lkdev_${"x".repeat(43)}` });
    expect(status(r)).toBe(503);
    expect(JSON.stringify(r)).not.toContain("xxxxxxxx");
    expect(h.logs.join("\n")).not.toContain("xxxxxxxx");
  });
});

describe("Host and identity headers cannot get around it", () => {
  test("only Host: preview.lianki.com is served, whatever the cookie", async () => {
    const h = setup();
    const c = h.cookieOf(await h.post({ token: GOOD }));
    for (const host of [
      "127.0.0.1:3104",
      "localhost",
      "mac.example.ts.net:8443",
      "lianki.com",
      "preview.lianki.com.evil.example",
      "evil.example",
      "",
    ])
      expect([host, status(await h.req("/", { host, cookie: c }))]).toEqual([host, 503]);
    expect(status(await h.req("/", { cookie: c }))).toBe("forward");
  });

  test("a Tailscale identity header is never believed on the tunnel", async () => {
    const h = setup();
    expect(status(await h.req("/", { "tailscale-user-login": "owner@github" }))).toBe(503);
    expect(
      upstreamHeaders(
        { "tailscale-user-login": "owner@github", host: HOST },
        { publicHost: HOST, origin: ORIGIN, drop: [] },
      ),
    ).not.toHaveProperty("tailscale-user-login");
  });

  test("the guard's own secret headers never pass upstream", () => {
    const up = upstreamHeaders(
      {
        host: HOST,
        "x-lianki-dev-guard": "s",
        "x-lianki-dev-bridge": "b",
        authorization: `Bearer ${GOOD}`,
      },
      { publicHost: HOST, origin: ORIGIN, drop: ["x-lianki-dev-guard", "x-lianki-dev-bridge"] },
    );
    expect(up).not.toHaveProperty("x-lianki-dev-guard");
    expect(up).not.toHaveProperty("x-lianki-dev-bridge");
    expect(up).not.toHaveProperty("authorization");
  });
});

describe("the browser handshake", () => {
  test("GET: a page that takes the token from the #fragment and strips it at once; no-store, no-referrer", async () => {
    const h = setup();
    const r = await h.req(AUTH_PATH);
    expect(r.kind === "respond" && r.status).toBe(200);
    if (r.kind !== "respond") return;
    expect(r.headers["cache-control"]).toContain("no-store");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.body).toContain("history.replaceState");
    expect(r.body).toContain("location.hash");
    expect(handshakeHtml()).toContain('name="referrer" content="no-referrer"');
  });

  test("a token in the query is refused unread", async () => {
    const h = setup();
    const r = await h.req(`${AUTH_PATH}?token=${GOOD}`);
    expect(status(r)).toBe(400);
    expect(h.verifyCalls).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(GOOD);
  });

  test("POST a good token: 303 to the path asked for, with an HttpOnly, Secure, SameSite, host-only cookie", async () => {
    const h = setup();
    const r = await h.post({ token: GOOD, next: "/words?list=all" });
    expect(status(r)).toBe(303);
    if (r.kind !== "respond") return;
    expect(r.headers.location).toBe("/words?list=all");
    expect(r.headers["cache-control"]).toContain("no-store");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    const c = String(r.headers["set-cookie"]);
    expect(c).toStartWith(`${SESSION_COOKIE}=`);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(c).toContain(flag);
    expect(c).not.toContain("Domain");
    expect(c).not.toContain(GOOD); // the cookie is a sealed session, not the token
    expect(status(await h.req("/words", { cookie: h.cookieOf(r) }))).toBe("forward");
  });

  test("a POST from lianki.com (the profile menu) is accepted; from another site it is not", async () => {
    const h = setup();
    expect(status(await h.post({ token: GOOD }, { origin: "https://lianki.com" }))).toBe(303);
    expect(status(await h.post({ token: GOOD }, { origin: "https://evil.example" }))).toBe(503);
  });

  test("bad, unknown and non-owner tokens: 503, and no cookie", async () => {
    const h = setup();
    for (const token of ["", "nope", OTHER, `lkdev_${"z".repeat(43)}`]) {
      const r = await h.post({ token });
      expect(status(r)).toBe(503);
      expect(r.kind === "respond" && r.headers["set-cookie"]).toBeFalsy();
    }
  });

  test("only same-site paths to land on", () => {
    expect(safeNext("/words?list=all")).toBe("/words?list=all");
    for (const bad of [
      "//evil.example/",
      "/\\evil.example",
      "https://evil.example",
      "",
      "words",
      "/x\r\nSet-Cookie: a=b",
    ])
      expect(safeNext(bad)).toBe(DEFAULT_NEXT);
  });

  test("too many failures from one IP: 429", async () => {
    const h = setup();
    for (let i = 0; i < FAILS_PER_IP; i++) await h.post({ token: "bad" });
    expect(status(await h.post({ token: GOOD }))).toBe(429);
    // Another IP is unaffected.
    expect(status(await h.post({ token: GOOD }, { "cf-connecting-ip": "198.51.100.7" }))).toBe(303);
  });

  test("sign-out clears the cookie", async () => {
    const h = setup();
    const r = await h.req(SIGN_OUT_PATH);
    expect(status(r)).toBe(303);
    expect(r.kind === "respond" && String(r.headers["set-cookie"])).toContain("Max-Age=0");
  });
});

describe("sessions end with their token", () => {
  test("revoking the token ends the session within RECHECK_MS", async () => {
    const h = setup();
    const c = h.cookieOf(await h.post({ token: GOOD }));
    expect(status(await h.req("/", { cookie: c }))).toBe("forward");
    h.revoked.add("t1");
    h.advance(RECHECK_MS + 1);
    expect(status(await h.req("/", { cookie: c }))).toBe(503);
  });

  test("the session expires after 12 h at most", async () => {
    const h = setup();
    const c = h.cookieOf(await h.post({ token: GOOD }));
    h.advance(SESSION_MAX_MS + 1);
    expect(status(await h.req("/", { cookie: c }))).toBe(503);
  });

  test("lianki.com unreachable on a re-check: closed, not open", async () => {
    const h = setup();
    const gate = createGate({
      publicHost: HOST,
      ownerEmail: OWNER,
      sessionKey: KEY,
      verify: async () => ({
        id: "t1",
        email: OWNER,
        kind: "token",
        sessionUntilMs: Date.now() + 1e7,
      }),
      active: async () => {
        throw new Error("down");
      },
      now: () => Date.now() + RECHECK_MS * 2,
    });
    const s = await sealSession(KEY, { tid: "t1", exp: Date.now() + 1e8 });
    const r = await gate.handle({
      method: "GET",
      url: "/",
      headers: { host: HOST, cookie: `${SESSION_COOKIE}=${s}` },
    });
    expect(status(r)).toBe(503);
    void h;
  });

  test("a handoff works once: the second POST gets 503", async () => {
    const h = setup();
    expect(status(await h.post({ handoff: HANDOFF, next: "/words" }))).toBe(303);
    expect(status(await h.post({ handoff: HANDOFF, next: "/words" }))).toBe(503);
  });

  test("sealed sessions: tamper and expiry", async () => {
    const s = await sealSession(KEY, { tid: "t1", exp: 2000 });
    expect(await openSession(KEY, s, 1000)).toEqual({ tid: "t1", exp: 2000 });
    expect(await openSession(KEY, s, 2000)).toBeNull();
    const [body, sig] = s.split(".");
    const other = Buffer.from(JSON.stringify({ tid: "t2", exp: 9e15 })).toString("base64url");
    expect(await openSession(KEY, `${other}.${sig}`, 1000)).toBeNull();
    expect(await openSession(KEY, `${body}.x${sig.slice(1)}`, 1000)).toBeNull();
  });
});

describe("tools: Authorization: Bearer", () => {
  test("a named token passes; a handoff or garbage does not", async () => {
    const h = setup();
    expect(status(await h.req("/api/words/lists", { authorization: `Bearer ${GOOD}` }))).toBe(
      "forward",
    );
    expect(status(await h.req("/", { authorization: `Bearer ${HANDOFF}` }))).toBe(503);
    expect(status(await h.req("/", { authorization: "Bearer nope" }))).toBe(503);
    expect(status(await h.req("/", { authorization: `Bearer ${OTHER}` }))).toBe(503);
  });
});

describe("what reaches the app, and what comes back", () => {
  test("upstream: his origin as Host/Origin, no gate cookie, no browser owner cookie", () => {
    const up = upstreamHeaders(
      {
        host: HOST,
        origin: `https://${HOST}`,
        referer: `https://${HOST}/words?x=1`,
        cookie: `${SESSION_COOKIE}=v; __Secure-better-auth.session_token=stolen; lk_pref=1`,
        "cf-connecting-ip": "1.2.3.4",
        "x-forwarded-host": "evil",
      },
      { publicHost: HOST, origin: ORIGIN, drop: [] },
    );
    expect(up.host).toBe("mac.example.ts.net:8443");
    expect(up.origin).toBe(ORIGIN);
    expect(up.referer).toBe(`${ORIGIN}/words?x=1`);
    expect(up.cookie).toBe("lk_pref=1");
    expect(up).not.toHaveProperty("cf-connecting-ip");
    expect(up).not.toHaveProperty("x-forwarded-host");
  });

  test("another site's Origin is dropped, not passed on", () => {
    const up = upstreamHeaders(
      { host: HOST, origin: "https://evil.example" },
      { publicHost: HOST, origin: ORIGIN, drop: [] },
    );
    expect(up).not.toHaveProperty("origin");
  });

  test("downstream: no better-auth cookie for the browser; redirects point at the tunnel", () => {
    const down = downstreamHeaders(
      {
        "set-cookie": ["__Secure-better-auth.session_token=x; Path=/", "lk_theme=dark; Path=/"],
        location: `${ORIGIN}/words`,
      },
      { publicHost: HOST, origin: ORIGIN },
    );
    expect(down["set-cookie"]).toEqual(["lk_theme=dark; Path=/"]);
    expect(down.location).toBe(`https://${HOST}/words`);
  });
});

describe("the profile menu's up check", () => {
  test("answers 503 (nothing there is a way in), readable by lianki.com only", async () => {
    const h = setup();
    const r = await h.req(UP_PATH);
    expect(status(r)).toBe(503);
    if (r.kind !== "respond") return;
    expect(r.headers["x-lianki-gate"]).toBe("1");
    expect(r.headers["access-control-allow-origin"]).toBe("https://lianki.com");
    expect(h.verifyCalls).toEqual([]);
  });
});

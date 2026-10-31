/**
 * The tunnel gate (scripts/dev/preview-gate.ts), the second review's fixes
 * (2026-11-01): upgraded sockets watched per token and closed on revoke,
 * expiry or a failed re-check; no open redirect through TAB/LF/CR or
 * backslashes; no global failure lockout; verification queued, never refused.
 */
import { describe, expect, test } from "bun:test";
import {
  AUTH_PATH,
  DEFAULT_NEXT,
  FAILS_PER_IP,
  RECHECK_MS,
  SESSION_COOKIE,
  SESSION_MAX_MS,
  SocketWatch,
  VERIFY_CONCURRENCY,
  createGate,
  limiter,
  safeNext,
  type GateResult,
  type Verified,
} from "../scripts/dev/preview-gate";

const HOST = "preview.lianki.com";
const OWNER = "owner@example.com";
const GOOD = `lkdev_${"g".repeat(43)}`;
const HANDOFF = `lkhand_${"h".repeat(43)}`;
const KEY = "k".repeat(64);

function setup() {
  const t = 1_800_000_000_000;
  let handoffUsed = false;
  const gate = createGate({
    publicHost: HOST,
    ownerEmail: OWNER,
    sessionKey: KEY,
    now: () => t,
    verify: async (token): Promise<Verified | null> => {
      if (token === GOOD)
        return { id: "t1", email: OWNER, kind: "token", sessionUntilMs: t + SESSION_MAX_MS };
      if (token === HANDOFF && !handoffUsed) {
        handoffUsed = true;
        return { id: "h1", email: OWNER, kind: "handoff", sessionUntilMs: t + SESSION_MAX_MS };
      }
      return null;
    },
    active: async (ids) => ids,
  });
  const req = (url: string, headers: Record<string, string> = {}, method = "GET", body = "") =>
    gate.handle({
      method,
      url,
      headers: { host: HOST, "cf-connecting-ip": "203.0.113.5", ...headers },
      body: async () => body,
    });
  const post = (raw: string, headers: Record<string, string> = {}) =>
    req(AUTH_PATH, { origin: `https://${HOST}`, ...headers }, "POST", raw);
  return { req, post };
}

const status = (r: GateResult) => (r.kind === "respond" ? r.status : "forward");
const location = (r: GateResult) => (r.kind === "respond" ? String(r.headers.location) : "");

describe("no open redirect after the handshake", () => {
  test("TAB, LF, CR, NUL, DEL, backslashes and protocol-relative paths: the default", () => {
    for (const v of [
      "/\t/evil.example/",
      "/\n/evil.example/",
      "/\r/evil.example/",
      "\t//evil.example/",
      "/\\evil.example",
      "\\\\evil.example",
      "\\/evil.example",
      "//evil.example",
      "///evil.example",
      "/\u0000/evil.example",
      "/\u007f/evil.example",
      "https://evil.example/",
      "javascript:alert(1)",
      "",
      "words",
    ])
      expect([v, safeNext(v)]).toEqual([v, DEFAULT_NEXT]);
  });

  test("encoded through the form (%09, %0a, %0d, %5c, //): the default, and it resolves to the preview origin", async () => {
    const h = setup();
    for (const enc of [
      "%2F%09%2Fevil.example%2F",
      "%2F%0a%2Fevil.example",
      "%2F%0d%2Fevil.example",
      "%2F%5Cevil.example",
      "%5C%5Cevil.example",
      "%2F%2Fevil.example",
      "%2F%5C%2Fevil.example",
    ]) {
      const r = await h.post(`token=${GOOD}&next=${enc}`);
      expect([enc, status(r), location(r)]).toEqual([enc, 303, DEFAULT_NEXT]);
      expect(new URL(location(r), `https://${HOST}`).origin).toBe(`https://${HOST}`);
    }
  });

  test("ordinary paths, and percent-encoded slashes inside a path, are kept", async () => {
    expect(safeNext("/words?list=all")).toBe("/words?list=all");
    expect(safeNext("/a%2F%2Fb?x=%2F%2Fy#z")).toBe("/a%2F%2Fb?x=%2F%2Fy#z");
    const h = setup();
    expect(location(await h.post(`token=${GOOD}&next=%2Fwords%3Flist%3Dall`))).toBe(
      "/words?list=all",
    );
  });
});

describe("no global lockout", () => {
  test("many IPs' failures never block a good token, handoff or bearer from another IP", async () => {
    const h = setup();
    for (let ip = 0; ip < 30; ip++)
      for (let i = 0; i < FAILS_PER_IP; i++)
        await h.post("token=bad", { "cf-connecting-ip": `198.51.100.${ip}` });
    expect(status(await h.post(`token=${GOOD}`))).toBe(303);
    expect(status(await h.post(`handoff=${HANDOFF}`))).toBe(303);
    expect(status(await h.req("/", { authorization: `Bearer ${GOOD}` }))).toBe("forward");
  });

  test("the per-IP limit still holds", async () => {
    const h = setup();
    for (let i = 0; i < FAILS_PER_IP; i++) await h.post("token=bad");
    expect(status(await h.post(`token=${GOOD}`))).toBe(429);
  });

  test("verification is bounded in concurrency, queued, never refused", async () => {
    let running = 0;
    let peak = 0;
    const gate = createGate({
      publicHost: HOST,
      ownerEmail: OWNER,
      sessionKey: KEY,
      verify: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return { id: "t1", email: OWNER, kind: "token", sessionUntilMs: Date.now() + 1e7 };
      },
      active: async (ids) => ids,
    });
    const rs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        gate.handle({
          method: "POST",
          url: AUTH_PATH,
          headers: { host: HOST, origin: `https://${HOST}`, "cf-connecting-ip": `203.0.113.${i}` },
          body: async () => `token=${GOOD}`,
        }),
      ),
    );
    expect(rs.every((r) => status(r) === 303)).toBe(true);
    expect(peak).toBeLessThanOrEqual(VERIFY_CONCURRENCY);
  });

  test("limiter: runs everything, never more than n at once", async () => {
    const lim = limiter(2);
    let running = 0;
    let peak = 0;
    const out = await Promise.all(
      [1, 2, 3, 4, 5].map((x) =>
        lim(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 2));
          running--;
          return x;
        }),
      ),
    );
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });
});

describe("upgraded sockets are watched (SocketWatch)", () => {
  function watchSetup() {
    let t = 1_000_000;
    const revoked = new Set<string>();
    let down = false;
    let checks = 0;
    const timers: { f: () => void; ms: number; live: boolean }[] = [];
    const w = new SocketWatch({
      now: () => t,
      active: async (ids) => {
        checks++;
        if (down) throw new Error("lianki.com unreachable");
        return ids.filter((i) => !revoked.has(i));
      },
      every: (f, ms) => {
        const x = { f, ms, live: true };
        timers.push(x);
        return x;
      },
      stop: (x) => {
        (x as { live: boolean }).live = false;
      },
    });
    const tick = async () => {
      for (const x of timers.filter((y) => y.live)) x.f();
      await new Promise((r) => setTimeout(r, 0));
    };
    return {
      w,
      revoked,
      timers,
      tick,
      setDown: () => (down = true),
      advance: (ms: number) => (t += ms),
      checks: () => checks,
      now: () => t,
    };
  }

  test("forwarded requests carry the session end, so an upgrade can be watched", async () => {
    const h = setup();
    const r = await h.post(`token=${GOOD}`);
    const cookie = String(r.kind === "respond" && r.headers["set-cookie"]).split(";")[0];
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    const f = await h.req("/_next/webpack-hmr", { cookie });
    expect(f.kind === "forward" && f.untilMs).toBeGreaterThan(0);
    const b = await h.req("/api/version/debug", { authorization: `Bearer ${GOOD}` });
    expect(b.kind === "forward" && b.untilMs).toBeGreaterThan(0);
  });

  test("one timer per token, however many sockets, on the RECHECK_MS cadence", () => {
    const s = watchSetup();
    for (let i = 0; i < 5; i++) s.w.add("t1", s.now() + 1e6, () => {});
    s.w.add("t2", s.now() + 1e6, () => {});
    expect(s.w.count()).toEqual({ socks: 6, timers: 2 });
    expect(s.timers.filter((x) => x.live).map((x) => x.ms)).toEqual([RECHECK_MS, RECHECK_MS]);
  });

  test("revoking the token closes all its sockets at the next re-check; others stay", async () => {
    const s = watchSetup();
    const closed: string[] = [];
    s.w.add("t1", s.now() + 1e6, () => closed.push("hub"));
    s.w.add("t1", s.now() + 1e6, () => closed.push("hmr"));
    s.w.add("t2", s.now() + 1e6, () => closed.push("other"));
    await s.tick();
    expect(closed).toEqual([]);
    s.revoked.add("t1");
    await s.tick();
    expect(closed.sort()).toEqual(["hmr", "hub"]);
    expect(s.w.count()).toEqual({ socks: 1, timers: 1 });
  });

  test("a failed re-check (lianki.com unreachable) closes: fail closed", async () => {
    const s = watchSetup();
    let closed = false;
    s.w.add("t1", s.now() + 1e6, () => (closed = true));
    s.setDown();
    await s.tick();
    expect(closed).toBe(true);
    expect(s.w.count()).toEqual({ socks: 0, timers: 0 });
  });

  test("a socket closes when its session ends, even while the token is live", async () => {
    const s = watchSetup();
    const closed: string[] = [];
    s.w.add("t1", s.now() + 10_000, () => closed.push("short"));
    s.w.add("t1", s.now() + 1e6, () => closed.push("long"));
    s.advance(RECHECK_MS);
    await s.tick();
    expect(closed).toEqual(["short"]);
    expect(s.w.count().socks).toBe(1);
  });

  test("already ended: closed at once, never watched", () => {
    const s = watchSetup();
    let closed = false;
    s.w.add("t1", s.now() - 1, () => (closed = true));
    expect(closed).toBe(true);
    expect(s.w.count()).toEqual({ socks: 0, timers: 0 });
  });

  test("the last socket going away stops its token's timer: no re-checks for nothing", async () => {
    const s = watchSetup();
    const un = s.w.add("t1", s.now() + 1e6, () => {});
    un();
    un(); // twice is harmless
    expect(s.w.count()).toEqual({ socks: 0, timers: 0 });
    await s.tick();
    expect(s.checks()).toBe(0);
  });

  test("closeToken closes a token's sockets at once", () => {
    const s = watchSetup();
    let n = 0;
    s.w.add("t1", s.now() + 1e6, () => n++);
    s.w.add("t1", s.now() + 1e6, () => n++);
    s.w.closeToken("t1", "test");
    s.w.closeToken("nope", "test");
    expect(n).toBe(2);
    expect(s.w.count()).toEqual({ socks: 0, timers: 0 });
  });

  test("by default it uses setInterval at RECHECK_MS and clearInterval when done", () => {
    const calls: number[] = [];
    let cleared = 0;
    const [si, ci] = [globalThis.setInterval, globalThis.clearInterval];
    globalThis.setInterval = ((f: () => void, ms: number) => {
      calls.push(ms);
      return si(f, 1e9);
    }) as typeof setInterval;
    globalThis.clearInterval = ((x: ReturnType<typeof setInterval>) => {
      cleared++;
      ci(x);
    }) as typeof clearInterval;
    try {
      const w = new SocketWatch({ active: async (ids) => ids });
      const un = w.add("t1", Date.now() + 1e6, () => {});
      un();
    } finally {
      globalThis.setInterval = si;
      globalThis.clearInterval = ci;
    }
    expect(calls).toEqual([RECHECK_MS]);
    expect(cleared).toBe(1);
  });
});

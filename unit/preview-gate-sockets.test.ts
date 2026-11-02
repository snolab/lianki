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
  VerifyQueue,
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
});

describe("the token-check queue (VerifyQueue)", () => {
  /** A queue whose deadline timers the test fires by hand, and checks it releases by hand. */
  function q(o: Partial<{ concurrency: number; maxPending: number; perIp: number }> = {}) {
    const timers: { f: () => void; live: boolean }[] = [];
    const fails = new Map<string, number>();
    const queue = new VerifyQueue({
      concurrency: o.concurrency ?? 1,
      maxPending: o.maxPending ?? 3,
      perIp: o.perIp ?? 2,
      deadlineMs: 5000,
      admit: (ip, others) => (fails.get(ip) ?? 0) + others < FAILS_PER_IP,
      setTimer: (f) => {
        const x = { f, live: true };
        timers.push(x);
        return x;
      },
      clearTimer: (x) => {
        (x as { live: boolean }).live = false;
      },
    });
    const gates: (() => void)[] = [];
    let ran = 0;
    const job = () =>
      new Promise<string>((resolve) => {
        ran++;
        gates.push(() => resolve("done"));
      });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { queue, timers, fails, gates, job, ran: () => ran, flush };
  }

  test("a flood is refused at once past the bounds: 2 per IP, 32 (here 3) waiting behind the running ones", async () => {
    const h = q();
    const first = h.queue.run("a", h.job); // running
    const second = h.queue.run("a", h.job); // waiting
    expect(await h.queue.run("a", h.job)).toEqual({ ok: false, why: "ip" }); // a third from "a"
    const others = [h.queue.run("b", h.job), h.queue.run("c", h.job)];
    expect(await h.queue.run("d", h.job)).toEqual({ ok: false, why: "busy" }); // 3 waiting
    expect(h.queue.size()).toEqual({ running: 1, pending: 3 });
    // Drain: everything that was admitted runs, one at a time.
    for (let i = 0; i < 4; i++) {
      await h.flush();
      h.gates.shift()?.();
    }
    expect((await Promise.all([first, second, ...others])).every((r) => r.ok)).toBe(true);
    expect(h.queue.size()).toEqual({ running: 0, pending: 0 });
  });

  test("a waiter whose client went away is dropped, and never runs", async () => {
    const h = q();
    const running = h.queue.run("a", h.job);
    const ac = new AbortController();
    const waiting = h.queue.run("b", h.job, ac.signal);
    ac.abort();
    expect(await waiting).toEqual({ ok: false, why: "aborted" });
    expect(h.queue.size().pending).toBe(0);
    expect(h.queue.count("b")).toBe(0);
    await h.flush();
    h.gates.shift()?.();
    await running;
    expect(h.ran()).toBe(1); // b's check never ran
    // Already gone before it asked: not even queued.
    const gone = new AbortController();
    gone.abort();
    expect(await h.queue.run("c", h.job, gone.signal)).toEqual({ ok: false, why: "aborted" });
  });

  test("a waiter past its deadline gets 503 (timeout) and never runs", async () => {
    const h = q();
    const running = h.queue.run("a", h.job);
    const waiting = h.queue.run("b", h.job);
    for (const t of h.timers.filter((x) => x.live)) t.f();
    expect(await waiting).toEqual({ ok: false, why: "timeout" });
    await h.flush();
    h.gates.shift()?.();
    await running;
    expect(h.ran()).toBe(1);
  });

  test("the per-IP admission is checked again at its turn", async () => {
    const h = q();
    const running = h.queue.run("a", h.job);
    const waiting = h.queue.run("b", h.job);
    h.fails.set("b", FAILS_PER_IP); // b failed meanwhile, elsewhere
    await h.flush();
    h.gates.shift()?.();
    await running;
    expect(await waiting).toEqual({ ok: false, why: "ip" });
    expect(h.ran()).toBe(1);
  });

  test("in-flight attempts count towards the IP's failure limit", async () => {
    const h = q({ concurrency: 4, perIp: 4 });
    h.fails.set("a", FAILS_PER_IP - 2);
    const r1 = h.queue.run("a", h.job);
    const r2 = h.queue.run("a", h.job);
    // 8 failures + 2 in flight = the limit: the next is refused before it runs.
    expect(await h.queue.run("a", h.job)).toEqual({ ok: false, why: "ip" });
    await h.flush();
    for (const g of h.gates.splice(0)) g();
    await Promise.all([r1, r2]);
  });

  test("the gate: a flood of bad bearers on / never stalls the owner, and gets fast answers", async () => {
    let calls = 0;
    const slow: (() => void)[] = [];
    const gate = createGate({
      publicHost: HOST,
      ownerEmail: OWNER,
      sessionKey: KEY,
      verify: (token) => {
        calls++;
        if (token === GOOD)
          return Promise.resolve({
            id: "t1",
            email: OWNER,
            kind: "token",
            sessionUntilMs: Date.now() + 1e7,
          } as Verified);
        // lianki.com slow for the flood's tokens.
        return new Promise((r) => slow.push(() => r(null)));
      },
      active: async (ids) => ids,
    });
    const at = (ip: string, auth: string) =>
      gate.handle({
        method: "GET",
        url: "/",
        headers: { host: HOST, "cf-connecting-ip": ip, authorization: auth },
      });
    const bad = (i: number) => `Bearer lkdev_${String(i).padStart(43, "x")}`;
    // The owner's bearer, verified once before the flood.
    expect(status(await at("192.0.2.1", `Bearer ${GOOD}`))).toBe("forward");
    const flood: Promise<GateResult>[] = [];
    for (let ip = 0; ip < 40; ip++)
      for (let k = 0; k < 3; k++) flood.push(at(`198.51.100.${ip}`, bad(ip * 3 + k)));
    // Past the bounds the flood is answered at once (429 per IP, 503 busy), not queued.
    const settled = await Promise.race([
      Promise.all(flood.slice(-10)),
      new Promise((r) => setTimeout(() => r("hung"), 200)),
    ]);
    expect(settled).not.toBe("hung");
    // The owner's cached bearer is served at once, behind no queue.
    const t0 = performance.now();
    expect(status(await at("192.0.2.1", `Bearer ${GOOD}`))).toBe("forward");
    expect(performance.now() - t0).toBeLessThan(50);
    expect(calls).toBeLessThanOrEqual(1 + VERIFY_CONCURRENCY);
    for (const s of slow.splice(0)) s();
  });
});

describe("upgraded sockets are watched (SocketWatch)", () => {
  function watchSetup() {
    let t = 1_000_000;
    const revoked = new Set<string>();
    let down = false;
    let checks = 0;
    const timers: { f: () => void; ms: number; live: boolean }[] = [];
    const ends: { f: () => void; at: number; live: boolean }[] = [];
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
      once: (f, ms) => {
        const x = { f, at: t + ms, live: true };
        ends.push(x);
        return x;
      },
      cancel: (x) => {
        (x as { live: boolean }).live = false;
      },
    });
    /** Move the clock and fire the one-shot end timers that came due (no re-check tick). */
    const advanceTo = (ms: number) => {
      t = ms;
      for (const x of ends.filter((y) => y.live && y.at <= t)) {
        x.live = false;
        x.f();
      }
    };
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
      advanceTo,
      ends,
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

  test("a session end closes its socket at that moment, not at the next re-check; then re-arms", () => {
    const s = watchSetup();
    const closed: string[] = [];
    const t0 = s.now();
    s.w.add("t1", t0 + 7_000, () => closed.push("7s"));
    s.w.add("t1", t0 + 12_000, () => closed.push("12s"));
    s.w.add("t1", t0 + 1e6, () => closed.push("long"));
    // One one-shot timer per token, at the earliest end.
    expect(s.ends.filter((x) => x.live).map((x) => x.at)).toEqual([t0 + 7_000]);
    s.advanceTo(t0 + 6_999);
    expect(closed).toEqual([]);
    s.advanceTo(t0 + 7_000); // well before the 30 s re-check
    expect(closed).toEqual(["7s"]);
    // Re-armed for the next end.
    expect(s.ends.filter((x) => x.live).map((x) => x.at)).toEqual([t0 + 12_000]);
    s.advanceTo(t0 + 12_000);
    expect(closed).toEqual(["7s", "12s"]);
    expect(s.w.count()).toEqual({ socks: 1, timers: 1 });
    expect(s.checks()).toBe(0); // no network for any of it
  });

  test("an earlier session joining moves the end timer forward; the last socket leaving cancels it", () => {
    const s = watchSetup();
    const t0 = s.now();
    const un1 = s.w.add("t1", t0 + 20_000, () => {});
    const un2 = s.w.add("t1", t0 + 5_000, () => {});
    expect(s.ends.filter((x) => x.live).map((x) => x.at)).toEqual([t0 + 5_000]);
    un2();
    expect(s.ends.filter((x) => x.live).map((x) => x.at)).toEqual([t0 + 20_000]);
    un1();
    expect(s.ends.filter((x) => x.live)).toEqual([]);
  });

  test("no orphan one-shot timers: repeated re-checks before the end keep one; unwatching all leaves none", async () => {
    const s = watchSetup();
    const t0 = s.now();
    const un1 = s.w.add("t1", t0 + SESSION_MAX_MS, () => {});
    const un2 = s.w.add("t1", t0 + SESSION_MAX_MS + 5, () => {});
    for (let i = 0; i < 100; i++) {
      s.advance(RECHECK_MS);
      await s.w.check("t1");
    }
    expect(s.ends.filter((x) => x.live)).toHaveLength(1);
    un1();
    un2();
    expect(s.ends.filter((x) => x.live)).toHaveLength(0);
  });

  test("no orphan one-shot timers with the real setTimeout either", async () => {
    const live = new Set<unknown>();
    const [st, ct] = [globalThis.setTimeout, globalThis.clearTimeout];
    globalThis.setTimeout = ((f: () => void, ms?: number) => {
      const id = st(() => {
        live.delete(id);
        f();
      }, ms);
      live.add(id);
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      live.delete(id);
      ct(id);
    }) as typeof clearTimeout;
    try {
      const w = new SocketWatch({
        active: async (ids) => ids,
        every: () => ({}),
        stop: () => {},
      });
      const un = w.add("t1", Date.now() + SESSION_MAX_MS, () => {});
      for (let i = 0; i < 50; i++) await w.check("t1");
      expect(live.size).toBe(1);
      un();
      expect(live.size).toBe(0);
    } finally {
      globalThis.setTimeout = st;
      globalThis.clearTimeout = ct;
    }
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

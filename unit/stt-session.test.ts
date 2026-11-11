/**
 * POST /api/stt/session (lib/stt-worker/session.ts): 404 while the flag is
 * off; on, only an allowlisted account under its quotas gets a v2 ticket with
 * its own id and the configured limits, the ICE servers and the signal path.
 */
import { describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { CONFIG } from "@/lib/config";
import {
  b64url,
  importTicketKey,
  importTicketPublicKey,
  verifySttTicketV2,
} from "@/lib/stt-ticket";
import {
  STT_SIGNAL_PATH,
  cloudflareTurn,
  handleSttSession,
  stunServers,
  wssRoute,
  type SttSessionDeps,
} from "@/lib/stt-worker/session";
import type { SttDb } from "@/lib/stt-worker/store";

const NOW = Date.parse("2026-11-11T03:00:00Z"); // 12:00 JST

async function keys() {
  const p = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", p.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", p.publicKey));
  return {
    priv: await importTicketKey(JSON.stringify({ kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x })),
    pub: await importTicketPublicKey(b64url(raw)),
  };
}

function db() {
  return createTestD1(testSchema()) as unknown as SttDb;
}

const req = () => new Request("https://lianki.com/api/stt/session", { method: "POST" });

function deps(o: Partial<SttSessionDeps> & { priv?: CryptoKey; cfg?: Record<string, unknown> }) {
  const values = { ...o.cfg } as Record<string, unknown>;
  const val = (k: keyof typeof CONFIG) => (k in values ? values[k] : CONFIG[k].default);
  const d: SttSessionDeps = {
    flag: async () => true,
    user: { id: "u1" },
    allowed: async (id) => id === "u1",
    db: db(),
    num: async (k) => val(k) as number,
    text: async (k) => val(k) as string,
    key: async () => o.priv ?? null,
    now: () => NOW,
    ...o,
  };
  return d;
}

describe("/api/stt/session", () => {
  test("404 while the flag is off, or when it cannot be read; nothing else is looked at", async () => {
    let asked = false;
    const spy = { allowed: async () => ((asked = true), true) };
    expect((await handleSttSession(req(), deps({ ...spy, flag: async () => false }))).status).toBe(
      404,
    );
    const broken = deps({
      ...spy,
      flag: async () => {
        throw new Error("d1");
      },
    });
    expect((await handleSttSession(req(), broken)).status).toBe(404);
    expect(asked).toBe(false);
  });

  test("GET: 204 only for an allowlisted account with the flag on; else 404; no ticket", async () => {
    const get = new Request("https://lianki.com/api/stt/session");
    expect((await handleSttSession(get, deps({}))).status).toBe(204);
    expect((await handleSttSession(get, deps({ user: { id: "u2" } }))).status).toBe(404);
    expect((await handleSttSession(get, deps({ user: null }))).status).toBe(404);
    expect((await handleSttSession(get, deps({ flag: async () => false }))).status).toBe(404);
  });

  test("on: signed out 401, not on the list 403, no key 503", async () => {
    const k = await keys();
    const body = async (d: SttSessionDeps) => {
      const r = await handleSttSession(req(), d);
      return [r.status, ((await r.json()) as { error?: string }).error];
    };
    expect(await body(deps({ priv: k.priv, user: null }))).toEqual([401, "login-required"]);
    expect(await body(deps({ priv: k.priv, user: { id: "u2" } }))).toEqual([403, "not-allowed"]);
    expect(await body(deps({}))).toEqual([503, "tickets-off"]);
    expect(await body(deps({ priv: k.priv, cfg: { "stt.worker.sessionsPerAccount": 0 } }))).toEqual(
      [403, "off"],
    );
  });

  test("a v2 ticket for this account with the configured limits, STUN, the signal path", async () => {
    const k = await keys();
    const r = await handleSttSession(
      req(),
      deps({ priv: k.priv, cfg: { "stt.worker.maxUtteranceS": 30 } }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const b = (await r.json()) as {
      ticket: string;
      signal: string;
      iceServers: unknown[];
      limits: unknown;
      wss?: string;
    };
    expect(b.signal).toBe(STT_SIGNAL_PATH);
    expect(b.iceServers).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
    expect(b.limits).toEqual({ utteranceS: 30, sessionS: 900 });
    expect(b.wss).toBeUndefined();
    const v = await verifySttTicketV2(b.ticket, k.pub, new Map(), NOW);
    expect(v.ok && [v.payload.sub, v.payload.lim]).toEqual(["u1", { utt: 30, sess: 900 }]);
  });

  test("tickets per minute per account (D1), then again after the minute", async () => {
    const k = await keys();
    const d = deps({ priv: k.priv, cfg: { "stt.worker.ticketsPerMin": 2 } });
    expect((await handleSttSession(req(), d)).status).toBe(200);
    expect((await handleSttSession(req(), d)).status).toBe(200);
    const third = await handleSttSession(req(), d);
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: string }).error).toBe("too-many-tickets");
    expect((await handleSttSession(req(), { ...d, now: () => NOW + 61_000 })).status).toBe(200);
    // Another account has its own count.
    const other = { ...d, user: { id: "u3" }, allowed: async () => true };
    expect((await handleSttSession(req(), other)).status).toBe(200);
  });

  test("minutes per JST day, from the cost ledger's speech.stt.local rows", async () => {
    const k = await keys();
    const d = deps({ priv: k.priv, cfg: { "stt.worker.minutesPerDay": 1 } });
    const ins = (feature: string, units: number, day: string) =>
      d
        .db!.prepare(
          "INSERT INTO cost_ledger (user_id, feature, usd_micro, units, day, at) VALUES ('u1', ?1, 1, ?2, ?3, 'x')",
        )
        .bind(feature, units, day)
        .run();
    await ins("speech.stt.local", 50, "2026-11-11");
    await ins("speech.stt", 500, "2026-11-11"); // the cloud route: not this quota
    await ins("speech.stt.local", 500, "2026-11-10"); // yesterday
    expect((await handleSttSession(req(), d)).status).toBe(200);
    await ins("speech.stt.local", 10, "2026-11-11");
    const r = await handleSttSession(req(), d);
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([429, "daily-limit"]);
  });

  test("the WSS fallback and TURN only when configured", async () => {
    const k = await keys();
    const turn = async () => [{ urls: "turn:turn.example:3478", username: "u", credential: "c" }];
    const r = await handleSttSession(
      req(),
      deps({ priv: k.priv, turn, cfg: { "stt.worker.wssUrl": "wss://speech.example/x" } }),
    );
    const b = (await r.json()) as { wss: string; iceServers: unknown[] };
    expect(b.wss).toBe("wss://speech.example/x");
    expect(b.iceServers).toHaveLength(2);
  });
});

describe("helpers", () => {
  test("stun URLs only; wss only", () => {
    expect(stunServers("stun:a.b:3478, https://x stuns:c.d")).toEqual([
      { urls: ["stun:a.b:3478", "stuns:c.d"] },
    ]);
    expect(stunServers("")).toEqual([]);
    expect(wssRoute("ws://x")).toBeUndefined();
    expect(wssRoute("")).toBeUndefined();
  });

  test("no TURN key: no call, null", async () => {
    let called = false;
    const f = (async () => ((called = true), new Response("{}"))) as unknown as typeof fetch;
    expect(await cloudflareTurn({}, 900, f)).toBeNull();
    expect(called).toBe(false);
  });

  test("TURN: the key's credentials, ttl clamped", async () => {
    let body = "";
    const f = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return Response.json({
        iceServers: { urls: ["turn:t:3478"], username: "x", credential: "y" },
      });
    }) as unknown as typeof fetch;
    const s = await cloudflareTurn({ STT_TURN_KEY_ID: "abc", STT_TURN_KEY_TOKEN: "t" }, 5, f);
    expect(s).toEqual([{ urls: ["turn:t:3478"], username: "x", credential: "y" }]);
    expect(JSON.parse(body)).toEqual({ ttl: 60 });
  });
});

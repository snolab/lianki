import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { useBackend, useD1 } from "./support/testMocks";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { b64url } from "@/lib/stt-ticket";
import {
  LIVE_VIEW_AUD,
  LIVE_VIEW_COOKIE,
  LIVE_VIEW_MAX_S,
  importLiveViewPrivateKey,
  importLiveViewPublicKey,
  liveLabel,
  liveSourceOk,
  signLiveView,
  unsignedOverridesAllowed,
  verifyLiveView,
  type LiveViewClaim,
} from "@/lib/live-view/rules";
import {
  LIVE_VIEW_BODY_MAX,
  LIVE_VIEW_POSTS,
  clearPointer,
  currentPointer,
  handlePost,
  handleRequest,
  readCapped,
  readRow,
  writeSigned,
  type LiveViewDb,
} from "@/lib/live-view/server";
import { LIVE_VIEW_PUBLIC_KEYS, liveViewKeys, trustedLiveViewKeys } from "@/lib/live-view/keys";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  createLiveViewStore,
  liveWanted,
  setLiveWanted,
  useLiveView,
  widgetSource,
} from "@/lib/live-view/client";
import { liveViewFor } from "@/lib/live-view/shell.server";
import { createIslandStore } from "@/lib/islands/store";
import { LIVE_VIEW_ORIGINS } from "@/lib/live-view/origins";
import {
  hostGate,
  hostWidgetSrc,
  importPinned,
  moduleImports,
  setHostWidgetSrc,
} from "@lianki/debug-chat/debug-widget";
import { buildWidget } from "../scripts/dev/debug-widget-build";
import { buildIslands } from "../scripts/dev/islands-build";

const NOW = Date.parse("2026-11-01T03:00:00Z");
const T = Math.floor(NOW / 1000);
const MAC = LIVE_VIEW_ORIGINS[0];
const W = `${MAC}/lianki-widget/debug-chat.js`;
const I = `${MAC}/lianki-islands/islands.js`;

async function pair() {
  const p = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", p.privateKey);
  const raw = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", p.publicKey)));
  return {
    priv: await importLiveViewPrivateKey(jwk),
    pub: await importLiveViewPublicKey(raw),
    raw,
  };
}

const dev = await pair();
const other = await pair();
const KEYS = [dev.pub];

type Extra = Partial<Omit<LiveViewClaim, "aud">> & { aud?: string } & Record<string, unknown>;
const on = (serial: number, x: Extra = {}, key = dev.priv) =>
  signLiveView(key, {
    op: "on",
    serial,
    iat: T,
    exp: T + 3600,
    widget: W,
    islands: I,
    branch: "feat/live-view",
    sha: "abc1234def5678",
    ...x,
  } as Omit<LiveViewClaim, "aud">);
const req = (op: "off" | "status", serial: number, x: Extra = {}) =>
  signLiveView(dev.priv, { op, serial, iat: T, exp: T + 60, ...x } as Omit<LiveViewClaim, "aud">);

const db = () => createTestD1(testSchema()) as unknown as LiveViewDb;

describe("verifyLiveView", () => {
  test("a good pointer verifies, with its sources and label", async () => {
    const v = await verifyLiveView(await on(1), KEYS, { now: NOW, op: "on" });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.claim).toMatchObject({
      aud: LIVE_VIEW_AUD,
      op: "on",
      serial: 1,
      widget: W,
      islands: I,
    });
    expect(liveLabel(v.claim)).toBe("feat/live-view@abc1234");
    expect(liveLabel({})).toBe("?@");
  });

  test("expired is refused", async () => {
    const v = await verifyLiveView(await on(1), KEYS, { now: NOW + 3601_000 });
    expect(v).toEqual({ ok: false, error: "expired" });
  });

  test("a key that is not trusted is refused", async () => {
    expect(await verifyLiveView(await on(1, {}, other.priv), KEYS, { now: NOW })).toEqual({
      ok: false,
      error: "bad signature",
    });
    // …but any of several trusted keys will do (rotation).
    expect(
      (await verifyLiveView(await on(1, {}, other.priv), [dev.pub, other.pub], { now: NOW })).ok,
    ).toBe(true);
  });

  test("a tampered payload fails the signature", async () => {
    const [, sig] = (await on(1)).split(".");
    const forged = b64url(
      new TextEncoder().encode(
        JSON.stringify({
          aud: LIVE_VIEW_AUD,
          op: "on",
          serial: 1,
          iat: T,
          exp: T + 60,
          widget: "https://evil.ts.net/x.js",
          branch: "b",
          sha: "abcdef0",
        }),
      ),
    );
    expect(await verifyLiveView(`${forged}.${sig}`, KEYS, { now: NOW })).toEqual({
      ok: false,
      error: "bad signature",
    });
  });

  test("malformed tokens", async () => {
    for (const t of [undefined, 42, "", "a", "a.b.c", "abc.!!", "x".repeat(3000)])
      expect((await verifyLiveView(t, KEYS, { now: NOW })).ok).toBe(false);
    expect(await verifyLiveView(await on(1), [], { now: NOW })).toEqual({
      ok: false,
      error: "malformed",
    });
    // Signed, but not JSON.
    const body = b64url(new TextEncoder().encode("not json"));
    const sig = b64url(
      new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, dev.priv, new TextEncoder().encode(body)),
      ),
    );
    expect(await verifyLiveView(`${body}.${sig}`, KEYS, { now: NOW })).toEqual({
      ok: false,
      error: "malformed",
    });
  });

  test("audience, op and fields", async () => {
    const bad = async (x: Extra) =>
      (await verifyLiveView(await on(1, x), KEYS, { now: NOW })) as { error?: string };
    expect((await bad({ aud: "lianki-stt" })).error).toBe("wrong aud");
    expect((await bad({ op: "nope" as never })).error).toBe("malformed");
    expect((await bad({ serial: 0 })).error).toBe("malformed");
    expect((await bad({ serial: 1.5 })).error).toBe("malformed");
    expect((await bad({ iat: "x" as never })).error).toBe("malformed");
    expect((await bad({ branch: "a b" })).error).toBe("malformed");
    expect((await bad({ sha: "XYZ" })).error).toBe("malformed");
    expect((await bad({ widget: undefined, islands: undefined })).error).toBe("no source");
    expect((await bad({ widget: `${MAC.replace("https:", "http:")}/x.js` })).error).toBe(
      "bad source",
    );
    const w = await verifyLiveView(await req("off", 2), KEYS, { now: NOW, op: "on" });
    expect(w).toEqual({ ok: false, error: "wrong op" });
    // Only one source is fine.
    const one = await verifyLiveView(await on(1, { islands: undefined }), KEYS, { now: NOW });
    expect(one.ok && one.claim.islands).toBe(undefined);
  });

  test("lifetime: on ≤ 12 h, off/status ≤ 5 min, not issued in the future", async () => {
    const life = async (t: Promise<string>) =>
      ((await verifyLiveView(await t, KEYS, { now: NOW })) as { error?: string }).error;
    expect(await life(on(1, { exp: T + LIVE_VIEW_MAX_S }))).toBeUndefined();
    expect(await life(on(1, { exp: T + LIVE_VIEW_MAX_S + 1 }))).toBe("bad lifetime");
    expect(await life(on(1, { exp: T }))).toBe("bad lifetime");
    expect(await life(on(1, { iat: T + 3600, exp: T + 7200 }))).toBe("bad lifetime");
    expect(await life(req("off", 1, { exp: T + 301 }))).toBe("bad lifetime");
    expect(await life(req("status", 1))).toBeUndefined();
  });

  test("sources: exactly the owner's origins, over https; localhost only when allowed", () => {
    expect(LIVE_VIEW_ORIGINS).toContain("https://taku.onca-tint.ts.net");
    expect(liveSourceOk(W)).toBe(true);
    expect(liveSourceOk(`${MAC}/lianki-widget-compact/debug-chat.js`)).toBe(true);
    for (const u of [
      "https://lianki.com/x.js",
      "https://evil.com/x.js",
      // Signed or not, another tailnet host, another port, a tunnel not listed:
      "https://someone-else.onca-tint.ts.net/x.js",
      "https://mac.example-tailnet.ts.net/x.js",
      `${MAC}:8443/x.js`,
      "https://dev-mac.lianki.com/debug-chat.js",
      "https://evil-lianki.com/x.js",
      `${MAC.replace("https:", "http:")}/x.js`,
      `${MAC.replace("https://", "https://u:p@")}/x.js`,
      `${MAC}/x.js#frag`,
      "not a url",
      `${MAC}/${"a".repeat(300)}`,
      7,
    ])
      expect(liveSourceOk(u)).toBe(false);
    // An explicitly listed origin (a tunnel the owner runs) is fine.
    expect(
      liveSourceOk("https://dev-mac.lianki.com/x.js", false, ["https://dev-mac.lianki.com"]),
    ).toBe(true);
    expect(liveSourceOk("http://localhost:5180/debug-chat.js")).toBe(false);
    expect(liveSourceOk("http://localhost:5180/debug-chat.js", true)).toBe(true);
    expect(liveSourceOk("file:///etc/passwd", true)).toBe(false);
  });

  test("a signed pointer to an origin not on the list is refused", async () => {
    const v = await verifyLiveView(
      await on(1, { widget: "https://other.onca-tint.ts.net/x.js" }),
      KEYS,
      {
        now: NOW,
      },
    );
    expect(v).toEqual({ ok: false, error: "bad source" });
  });

  test("private key import refuses anything but an Ed25519 private JWK", async () => {
    await expect(importLiveViewPrivateKey({ kty: "OKP", crv: "Ed25519" })).rejects.toThrow();
    await expect(importLiveViewPrivateKey({ kty: "EC", crv: "P-256", d: "x" })).rejects.toThrow();
  });
});

describe("unsigned overrides (lk:agent-widget-src, lk:slots-src)", () => {
  test("refused on a production page of lianki.com, kept on dev builds and localhost", () => {
    expect(unsignedOverridesAllowed("production", "lianki.com")).toBe(false);
    expect(unsignedOverridesAllowed("production", undefined)).toBe(false);
    expect(unsignedOverridesAllowed("production", "localhost")).toBe(true);
    expect(unsignedOverridesAllowed("development", "mac.ts.net")).toBe(true);
  });

  test("the widget host gets the signed widget, else null on production (never the key)", () => {
    const live = { on: true as const, claim: { widget: W } as LiveViewClaim };
    expect(widgetSource(live, false)).toBe(W);
    expect(widgetSource({ on: false }, false)).toBeNull();
    expect(widgetSource({ on: true, claim: { islands: I } as LiveViewClaim }, false)).toBeNull();
    // Dev build / localhost: undefined = the host reads its old key.
    expect(widgetSource({ on: false }, true)).toBeUndefined();
    expect(
      widgetSource({ on: true, claim: { islands: I } as LiveViewClaim }, true),
    ).toBeUndefined();
    expect(widgetSource(live, true)).toBe(W);
  });
});

describe("the pointer store (D1) and POST /api/live-view", () => {
  test("on stores the pointer; status reads it; off clears it", async () => {
    const d = db();
    const r = await handlePost({ token: await on(10) }, d, KEYS, NOW);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ on: true, claim: { serial: 10, widget: W } });
    expect((await currentPointer(d, KEYS, NOW))?.claim.serial).toBe(10);
    const s = await handlePost({ token: await req("status", 1) }, d, KEYS, NOW);
    expect(s.body).toMatchObject({ on: true, claim: { branch: "feat/live-view" } });
    expect((await handlePost({ token: await req("off", 11) }, d, KEYS, NOW)).body).toEqual({
      on: false,
    });
    expect(await currentPointer(d, KEYS, NOW)).toBeNull();
    expect((await handlePost({ token: await req("status", 1) }, d, KEYS, NOW)).body).toEqual({
      on: false,
    });
    expect(await readRow(d)).toEqual({ pointer: null, serial: 11 });
  });

  test("replays and older serials are refused (409), even after off", async () => {
    const d = db();
    const first = await on(10);
    expect((await handlePost({ token: first }, d, KEYS, NOW)).status).toBe(200);
    expect((await handlePost({ token: first }, d, KEYS, NOW)).status).toBe(409);
    expect((await handlePost({ token: await on(9) }, d, KEYS, NOW)).status).toBe(409);
    expect((await handlePost({ token: await req("off", 10) }, d, KEYS, NOW)).status).toBe(409);
    expect((await handlePost({ token: await req("off", 12) }, d, KEYS, NOW)).status).toBe(200);
    expect((await handlePost({ token: first }, d, KEYS, NOW)).status).toBe(409);
    expect((await handlePost({ token: await on(11) }, d, KEYS, NOW)).status).toBe(409);
    expect((await handlePost({ token: await on(13) }, d, KEYS, NOW)).status).toBe(200);
  });

  test("unsigned, wrong key, expired: refused, nothing written", async () => {
    const d = db();
    expect((await handlePost(null, d, KEYS, NOW)).status).toBe(400);
    expect((await handlePost({ token: "x.y" }, d, KEYS, NOW)).status).toBe(400);
    expect((await handlePost({ token: await on(5, {}, other.priv) }, d, KEYS, NOW)).status).toBe(
      401,
    );
    expect((await handlePost({ token: await on(5) }, d, KEYS, NOW + 7200_000)).status).toBe(401);
    expect(await readRow(d)).toBeNull();
  });

  test("a stored pointer that expires reads as off", async () => {
    const d = db();
    await handlePost({ token: await on(1) }, d, KEYS, NOW);
    expect(await currentPointer(d, KEYS, NOW + 3600_000)).toBeNull();
    expect(await currentPointer(d, [other.pub], NOW)).toBeNull();
  });

  test("the owner's stop clears the pointer and keeps the serial", async () => {
    const d = db();
    expect(await writeSigned(d, await on(7), 7, NOW)).toBe(true);
    await clearPointer(d, NOW);
    expect(await readRow(d)).toEqual({ pointer: null, serial: 7 });
    expect(await writeSigned(d, await on(7), 7, NOW)).toBe(false);
  });

  test("localhost sources only where the server allows them (dev builds)", async () => {
    const local = await on(1, { widget: "http://localhost:5180/debug-chat.js" });
    expect((await handlePost({ token: local }, db(), KEYS, NOW)).status).toBe(401);
    expect((await handlePost({ token: local }, db(), KEYS, NOW, true)).status).toBe(200);
  });
});

describe("owner-only shell", () => {
  const saved = process.env.OWNER_EMAILS;
  const labels = () => ({ liveView: "Live view", normal: "Normal", waiting: "w", refused: "r" });
  beforeEach(() => {
    process.env.OWNER_EMAILS = "owner@example.com";
    useBackend("d1");
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.OWNER_EMAILS;
    else process.env.OWNER_EMAILS = saved;
    useBackend("mongodb");
  });

  test("nobody but the owner gets anything (not the switch, not the pointer)", async () => {
    const d = db();
    useD1(d);
    expect(await liveViewFor("someone@example.com", "1", labels)).toBeUndefined();
    expect(await liveViewFor(null, "1", labels)).toBeUndefined();
    process.env.OWNER_EMAILS = "";
    expect(await liveViewFor("owner@example.com", "1", labels)).toBeUndefined();
  });

  test("the owner: the switch; the pointer only while it is on and still valid", async () => {
    const d = db();
    useD1(d);
    expect(await liveViewFor("owner@example.com", undefined, labels)).toMatchObject({
      wanted: false,
      token: null,
    });
    // The real trusted key is the Mac's, so a test-signed pointer never verifies here.
    await writeSigned(d, await on(1), 1, Date.now());
    expect(await liveViewFor("Owner@Example.com", "1", labels)).toMatchObject({
      wanted: true,
      token: null,
    });
    // No table: stays normal rather than failing the page.
    useD1(createTestD1(""));
    expect(await liveViewFor("owner@example.com", "1", labels)).toMatchObject({ token: null });
    useBackend("mongodb");
    expect(await liveViewFor("owner@example.com", "1", labels)).toMatchObject({ token: null });
  });
});

describe("keys", () => {
  test("the committed key is a raw Ed25519 public key; test keys only off production", async () => {
    expect(LIVE_VIEW_PUBLIC_KEYS.length).toBeGreaterThan(0);
    for (const k of LIVE_VIEW_PUBLIC_KEYS) await importLiveViewPublicKey(k);
    expect(trustedLiveViewKeys("production", dev.raw)).toEqual([...LIVE_VIEW_PUBLIC_KEYS]);
    expect(trustedLiveViewKeys("test", dev.raw)).toEqual([...LIVE_VIEW_PUBLIC_KEYS, dev.raw]);
    expect(trustedLiveViewKeys("test", " ")).toEqual([...LIVE_VIEW_PUBLIC_KEYS]);
    expect((await liveViewKeys()).length).toBeGreaterThanOrEqual(1);
  });
});

describe("the page's live-view store", () => {
  const timers = () => {
    const t: { fn?: () => void; ms?: number } = {};
    return {
      t,
      timers: {
        setTimeout: (fn: () => void, ms: number) => {
          t.fn = fn;
          t.ms = ms;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: () => {
          t.fn = undefined;
        },
      },
    };
  };

  test("verifies on the page: good → on; wrong key → off with the reason; none → off", async () => {
    const { t, timers: tm } = timers();
    const s = createLiveViewStore(tm);
    let n = 0;
    const off = s.subscribe(() => n++);
    expect((await s.start(await on(1), { keys: KEYS, now: NOW })).on).toBe(true);
    expect(t.ms).toBe(3600_000);
    expect(await s.start(await on(1, {}, other.priv), { keys: KEYS, now: NOW })).toEqual({
      on: false,
      note: "live view refused: bad signature",
    });
    expect(await s.start(null)).toEqual({ on: false });
    expect(n).toBe(3);
    off();
  });

  test("turns itself off when the pointer expires (one local timer)", async () => {
    const { t, timers: tm } = timers();
    const s = createLiveViewStore(tm);
    await s.start(await on(1), { keys: KEYS, now: NOW });
    t.fn?.();
    expect(s.get()).toEqual({ on: false, note: "expired" });
    await s.start(await on(1), { keys: KEYS, now: NOW });
    s.stop();
    expect(s.get()).toEqual({ on: false });
  });

  test("refuses a localhost source on production even when signed", async () => {
    const s = createLiveViewStore();
    const local = await on(1, {
      widget: "http://localhost:5180/debug-chat.js",
      islands: undefined,
    });
    expect((await s.start(local, { keys: KEYS, now: NOW, allowLocal: false })).on).toBe(false);
    s.stop();
  });

  test("useLiveView renders off on the server", () => {
    function Probe() {
      return createElement("i", null, useLiveView().on ? "on" : "off");
    }
    expect(renderToString(createElement(Probe))).toContain("off");
  });

  test("setLiveWanted writes and clears the cookie (secure on https)", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { d: g.document, l: g.location };
    const doc = { cookie: "" };
    g.document = doc;
    g.location = { protocol: "https:" };
    try {
      setLiveWanted(true);
      expect(doc.cookie).toBe(
        `${LIVE_VIEW_COOKIE}=1; path=/; max-age=31536000; samesite=lax; secure`,
      );
      g.location = { protocol: "http:" };
      setLiveWanted(false);
      expect(doc.cookie).toBe(`${LIVE_VIEW_COOKIE}=; path=/; max-age=0; samesite=lax`);
    } finally {
      g.document = saved.d;
      g.location = saved.l;
    }
  });

  test("the device switch is the lk_live_view cookie", () => {
    expect(liveWanted(`a=1; ${LIVE_VIEW_COOKIE}=1`)).toBe(true);
    expect(liveWanted(`${LIVE_VIEW_COOKIE}=0`)).toBe(false);
    expect(liveWanted("")).toBe(false);
  });
});

describe("islands: the live-view permission", () => {
  const C = (() => null) as never;
  test("islands install under live view alone, and drop when it ends", () => {
    const s = createIslandStore();
    s.put({ "header.brand": { C, rev: "1" } });
    expect(s.get("header.brand")).toBeUndefined();
    s.setLive(NOW + 1000, NOW);
    expect(s.granted()).toBe(true);
    s.put({ "header.brand": { C, rev: "1" } });
    expect(s.names()).toEqual(["header.brand"]);
    // The code-run grant ending does not end live view.
    s.setGrant(NOW + 500, NOW);
    s.setGrant(null);
    expect(s.names()).toEqual(["header.brand"]);
    s.setLive(NOW + 1000, NOW); // same value: no-op
    s.setLive(null);
    expect(s.granted()).toBe(false);
    expect(s.names()).toEqual([]);
  });

  test("live view lapses on its own timer", () => {
    let fire: (() => void) | undefined;
    const s = createIslandStore({
      setTimeout: (fn) => {
        fire = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {},
    });
    s.setLive(NOW + 1000, NOW);
    fire?.();
    expect(s.granted()).toBe(false);
    s.setLive(NOW - 1, NOW);
    expect(s.granted()).toBe(false);
  });
});

describe("a start() still verifying never undoes a later stop() or start()", () => {
  test("stop() before the verify finishes: stays off, no timer", async () => {
    let timers = 0;
    const s = createLiveViewStore({
      setTimeout: () => {
        timers++;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {},
    });
    const p = s.start(await on(1), { keys: KEYS, now: NOW });
    s.stop();
    await p;
    expect(s.get()).toEqual({ on: false });
    expect(timers).toBe(0);
  });

  test("overlapping starts: the newest wins, whatever order they finish in", async () => {
    const s = createLiveViewStore();
    const older = s.start(await on(1, { branch: "old" }), { keys: KEYS, now: NOW });
    const newer = s.start(await on(2, { branch: "new" }), { keys: KEYS, now: NOW });
    await newer;
    await older;
    const st = s.get();
    expect(st.on && st.claim.branch).toBe("new");
    // A later start(null) wins over an earlier good one too.
    const good = s.start(await on(3), { keys: KEYS, now: NOW });
    await s.start(null);
    await good;
    expect(s.get()).toEqual({ on: false });
    s.stop();
  });

  test("a stop() while the keys are still importing is honoured too", async () => {
    const s = createLiveViewStore();
    const p = s.start(await on(1), { now: NOW }); // imports the bundled keys
    s.stop();
    await p;
    expect(s.get()).toEqual({ on: false });
  });
});

describe("POST /api/live-view: body cap and per-IP limit", () => {
  const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request("https://lianki.com/api/live-view", {
      method: "POST",
      body,
      headers: { "cf-connecting-ip": "203.0.113.7", ...headers },
    });

  test("a declared oversized body is 413 before anything is read or counted", async () => {
    const d = db();
    const r = await handleRequest(
      post("x", { "content-length": String(LIVE_VIEW_BODY_MAX + 1) }),
      d,
      KEYS,
      NOW,
    );
    expect(r.status).toBe(413);
    const bad = await handleRequest(post("x", { "content-length": "nope" }), d, KEYS, NOW);
    expect(bad.status).toBe(413);
  });

  test("a streamed body past the cap is cut off: 413", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
        if (pulled > 100) c.close();
      },
    });
    const r = await handleRequest(post(stream), db(), KEYS, NOW);
    expect(r.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  test("readCapped reads small bodies, empty ones, and multi-chunk ones", async () => {
    expect(await readCapped(new Request("https://x/", { method: "POST" }))).toBe("");
    const two = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("ab"));
        c.enqueue(new TextEncoder().encode("cd"));
        c.close();
      },
    });
    expect(await readCapped(new Request("https://x/", { method: "POST", body: two }))).toBe("abcd");
  });

  test("a good signed request passes; past the per-IP limit: 429 with Retry-After", async () => {
    const d = db();
    const ok = await handleRequest(post(JSON.stringify({ token: await on(1) })), d, KEYS, NOW);
    expect(ok.status).toBe(200);
    for (let i = 1; i < LIVE_VIEW_POSTS.max; i++) await handleRequest(post("{}"), d, KEYS, NOW + i);
    const over = await handleRequest(post("{}"), d, KEYS, NOW + 100);
    expect(over.status).toBe(429);
    expect(over.retryAfterS).toBeGreaterThan(0);
    // Another IP is not affected; neither is the same IP in the next window.
    expect(
      (await handleRequest(post("{}", { "cf-connecting-ip": "203.0.113.8" }), d, KEYS, NOW)).status,
    ).toBe(400);
    expect(
      (await handleRequest(post("not json"), d, KEYS, NOW + LIVE_VIEW_POSTS.windowMs + 1)).status,
    ).toBe(400);
  });
});

describe("pinned module import (no redirects, same origin, the fetched bytes)", () => {
  const deps = (r: Partial<Response>) => {
    const seen: { init?: RequestInit; imported?: string; revoked?: string } = {};
    return {
      seen,
      d: {
        fetch: async (_u: string, init: RequestInit) => {
          seen.init = init;
          return {
            ok: true,
            status: 200,
            redirected: false,
            url: W,
            text: async () => "export const x = 1",
            ...r,
          } as Response;
        },
        importer: async (u: string) => {
          seen.imported = u;
          return { x: 1 };
        },
        blobUrl: (code: string) => `blob:${code.length}`,
        revoke: (u: string) => void (seen.revoked = u),
      },
    };
  };

  test("imports exactly the fetched bytes, with redirects refused and no cookies", async () => {
    const { seen, d } = deps({});
    expect(await importPinned(W, d.importer, d)).toEqual({ x: 1 });
    expect(seen.init).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(seen.imported).toBe("blob:18");
    expect(seen.revoked).toBe("blob:18");
  });

  test("a redirect, another origin, or an error status is refused", async () => {
    for (const r of [
      { redirected: true },
      { url: "https://evil.example/x.js" },
      { ok: false, status: 404 },
    ]) {
      const { seen, d } = deps(r);
      await expect(importPinned(W, d.importer, d)).rejects.toThrow();
      expect(seen.imported).toBeUndefined();
    }
  });

  test("the default deps build a blob from the response", async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => new Response("export const y = 2")) as unknown as typeof fetch;
    try {
      let got = "";
      await importPinned(W, async (u) => {
        got = u;
        return {};
      });
      expect(got.startsWith("blob:")).toBe(true);
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe("the host's widget-source decision (TreeFragment, every package copy)", () => {
  test("a decision (a URL, or null) wins over the localStorage key; none reads the key", () => {
    setHostWidgetSrc(null);
    expect(hostWidgetSrc(() => "https://from-the-key")).toBeNull();
    setHostWidgetSrc(W);
    expect(hostWidgetSrc(() => "https://from-the-key")).toBe(W);
    setHostWidgetSrc(undefined);
    expect(hostWidgetSrc(() => "https://from-the-key")).toBe("https://from-the-key");
  });

  test("later code can neither assign nor redefine the gate", () => {
    const g = globalThis as Record<string, unknown>;
    expect(setHostWidgetSrc(null)).toBe(true);
    expect(() => {
      "use strict";
      g.__lkWidgetHostSrc = { v: "https://evil.example/x.js" };
    }).toThrow();
    expect(() =>
      Object.defineProperty(globalThis, "__lkWidgetHostSrc", {
        value: { v: "https://evil.example" },
      }),
    ).toThrow();
    expect(hostWidgetSrc(() => "key")).toBeNull();
    // Another copy of the package (a hot-loaded widget) reads the same answer.
    expect(hostGate(globalThis).get(() => "key")).toBeNull();
    setHostWidgetSrc(undefined);
  });

  test("a gate someone planted first, configurable: replaced by the host's", () => {
    const t: Record<string, unknown> = {};
    Object.defineProperty(t, "__lkWidgetHostSrc", {
      value: { v: "https://evil.example" },
      configurable: true,
    });
    const g = hostGate(t);
    expect(g.set(null)).toBe(true);
    expect((t.__lkWidgetHostSrc as { v: unknown }).v).toBeNull();
  });

  test("a gate someone planted first, frozen: the host fails closed", () => {
    const t: Record<string, unknown> = {};
    Object.defineProperty(t, "__lkWidgetHostSrc", { value: { v: "https://evil.example" } });
    const g = hostGate(t);
    expect(g.set("https://taku.onca-tint.ts.net/w.js")).toBe(false);
    expect(g.get(() => "key")).toBeNull();
    expect(g.set(undefined)).toBe(false);
    expect(g.get(() => "key")).toBeNull();
  });
});

describe("live modules must be single files (importPinned refuses imports)", () => {
  test("finds static, re-export and literal dynamic imports", () => {
    expect(moduleImports(`import x from "./dep.js";`)).toEqual(["./dep.js"]);
    expect(moduleImports(`const a=1;import "/side.js"`)).toEqual(["/side.js"]);
    expect(moduleImports(`import {a as b, c} from 'https://cdn.example/m.js'`)).toEqual([
      "https://cdn.example/m.js",
    ]);
    expect(moduleImports(`export * from "./all.js"`)).toEqual(["./all.js"]);
    expect(moduleImports(`export { a } from "./a.js"`)).toEqual(["./a.js"]);
    expect(moduleImports("f(); const m = await import(`./chunk.js`)")).toEqual(["./chunk.js"]);
    expect(moduleImports(`import("")`)).toEqual(["(empty)"]);
  });

  test("leaves plain code, computed imports and look-alikes alone", () => {
    expect(moduleImports(`export const a = 1; export function f() {}`)).toEqual([]);
    expect(moduleImports(`const lib = await import(blob);`)).toEqual([]);
    expect(moduleImports(`x.import("a"); const important = "b";`)).toEqual([]);
  });

  test("importPinned refuses a module that imports, with the reason", async () => {
    let imported = false;
    const d = {
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          redirected: false,
          url: W,
          text: async () => `import a from "./a.js";`,
        }) as Response,
      importer: async () => {
        imported = true;
        return {};
      },
      blobUrl: () => "blob:x",
      revoke: () => {},
    };
    await expect(importPinned(W, d.importer, d)).rejects.toThrow(/single-file/);
    expect(imported).toBe(false);
  });

  test("today's widget and islands bundles import nothing", async () => {
    expect(moduleImports((await buildWidget()).code)).toEqual([]);
    expect(moduleImports((await buildIslands()).code)).toEqual([]);
  }, 120_000);
});

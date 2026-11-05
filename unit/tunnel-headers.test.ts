/**
 * What a dev-tunnel response may never carry (lib/live-view/tunnel-headers.ts),
 * on preview.lianki.com (the gate) and its websockets' 101s
 * (scripts/dev/preview-gate.ts upgradeHeadFilter); service worker scripts
 * replaced by a self-removing worker; the dev-token cap as one statement (a concurrent-mint race); and
 * the audit rows for live-view and dev-token writes (lib/security/audit-log.ts).
 */
import { describe, expect, test } from "bun:test";
import { createTestD1 } from "../lib/d1/testDb";
import { testSchema } from "../lib/d1/testSchema";
import {
  MAX_LIVE_TOKENS,
  listTokens,
  mintHandoff,
  mintToken,
  revokeAll,
  revokeToken,
  type DevAccessDb,
} from "../lib/dev-access";
import {
  filterTunnelFetchHeaders,
  filterTunnelHeaders,
  isServiceWorkerScript,
  tunnelHeaderDropped,
} from "../lib/live-view/tunnel-headers";
import { audit } from "../lib/security/audit-log";
import {
  importLiveViewPrivateKey,
  importLiveViewPublicKey,
  signLiveView,
} from "../lib/live-view/rules";
import { clearPointer, handlePost, type LiveViewDb } from "../lib/live-view/server";
import { LIVE_VIEW_ORIGINS } from "../lib/live-view/origins";
import { b64url } from "../lib/stt-ticket";
import {
  MAX_HEAD_BYTES,
  SESSION_MAX_MS,
  createGate,
  downstreamHeaders,
  filterResponseHead,
  sealSession,
  SESSION_COOKIE,
  SW_KILL_SWITCH,
  upgradeHeadFilter,
} from "../scripts/dev/preview-gate";

const BAD = {
  "set-cookie": ["a=1; Path=/", "__Secure-better-auth.session_token=x"],
  "Clear-Site-Data": '"*"',
  "content-security-policy": "default-src *",
  "content-security-policy-report-only": "default-src *",
  "access-control-allow-origin": "*",
  "Access-Control-Allow-Credentials": "true",
  "strict-transport-security": "max-age=0",
  "service-worker-allowed": "/",
};
const GOOD = { "content-type": "text/html", etag: '"1"', "cache-control": "no-cache" };

describe("tunnel response headers", () => {
  test("every state-changing header is dropped, the rest kept", () => {
    const out = filterTunnelHeaders({ ...BAD, ...GOOD });
    expect(out).toEqual(GOOD);
    for (const k of Object.keys(BAD)) expect(tunnelHeaderDropped(k)).toBe(true);
    expect(tunnelHeaderDropped(" Set-Cookie ")).toBe(true);
    expect(tunnelHeaderDropped("x-access-control")).toBe(false);
  });

  test("the fetch Headers form drops the same", () => {
    const h = new Headers(GOOD);
    for (const [k, v] of Object.entries(BAD))
      for (const x of Array.isArray(v) ? v : [v]) h.append(k, x);
    const out = filterTunnelFetchHeaders(h);
    expect(out.getSetCookie()).toEqual([]);
    for (const k of Object.keys(BAD)) expect(out.has(k)).toBe(false);
    expect(out.get("content-type")).toBe("text/html");
  });

  test("the gate's downstream: filtered, a redirect to the dev origin pointed at the tunnel", () => {
    const down = downstreamHeaders(
      { ...BAD, ...GOOD, location: "https://mac.example:8443/words?x=1" },
      { publicHost: "preview.lianki.com", origin: "https://mac.example:8443" },
    );
    expect(Object.keys(down).sort()).toEqual([...Object.keys(GOOD), "location"].sort());
    expect(down.location).toBe("https://preview.lianki.com/words?x=1");
  });
});

describe("service worker scripts", () => {
  test("by name or by the browser's Service-Worker header", () => {
    for (const p of [
      "/sw.js",
      "/x/sw.js",
      "/firebase-messaging-sw.js",
      "/service-worker.js",
      "/SW.JS",
    ])
      expect(isServiceWorkerScript(p, null)).toBe(true);
    expect(isServiceWorkerScript("/_next/static/chunks/a.js", "script")).toBe(true);
    expect(isServiceWorkerScript("/_next/static/chunks/a.js", " Script ")).toBe(true);
    for (const p of ["/_next/static/chunks/a.js", "/words", "/swjs", "/answers.js"])
      expect(isServiceWorkerScript(p, null)).toBe(false);
  });

  test("the gate answers one with its self-removing worker, with or without a session", async () => {
    const key = "k".repeat(64);
    const gate = createGate({
      publicHost: "preview.lianki.com",
      ownerEmail: "o@example.com",
      sessionKey: key,
      verify: async () => null,
      active: async (ids) => ids,
    });
    const cookie = `${SESSION_COOKIE}=${await sealSession(key, { tid: "t1", exp: Date.now() + SESSION_MAX_MS })}`;
    const host = "preview.lianki.com";
    for (const headers of [{ host }, { host, cookie }]) {
      const r = await gate.handle({ method: "GET", url: "/sw.js", headers });
      expect(r.kind === "respond" && r.status).toBe(200);
      expect(r.kind === "respond" && r.body).toBe(SW_KILL_SWITCH);
      expect(r.kind === "respond" && r.headers["content-type"]).toContain("javascript");
      const s = await gate.handle({
        method: "GET",
        url: "/_next/static/x.js",
        headers: { ...headers, "service-worker": "script" },
      });
      expect(s.kind === "respond" && s.body).toBe(SW_KILL_SWITCH);
    }
    // A normal asset with the session still passes.
    const ok = await gate.handle({
      method: "GET",
      url: "/_next/static/x.js",
      headers: { host, cookie },
    });
    expect(ok.kind).toBe("forward");
  });
});

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("a websocket's 101, filtered", () => {
  const HEAD =
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: abc=\r\nSet-Cookie: s=1; Path=/\r\nContent-Security-Policy: default-src *\r\n" +
    'Access-Control-Allow-Origin: *\r\nStrict-Transport-Security: max-age=0\r\nClear-Site-Data: "*"\r\n' +
    "X-Ok: 1\r\n folded: continuation\r\nbad line\r\n";

  test("only the safe lines are kept", () => {
    expect(filterResponseHead(HEAD.slice(0, -2))).toBe(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: abc=\r\nX-Ok: 1\r\n\r\n",
    );
  });

  test("a head split across chunks, then frames pass unchanged", () => {
    const f = upgradeHeadFilter();
    const all = enc(`${HEAD}\r\n\x81\x02hi`);
    expect(f(all.subarray(0, 20))).toBeNull();
    expect(f(all.subarray(20, 60))).toBeNull();
    const out = f(all.subarray(60));
    expect(out).not.toBe("too-large");
    const text = dec(out as Uint8Array);
    expect(text.startsWith("HTTP/1.1 101 Switching Protocols\r\n")).toBe(true);
    expect(text).not.toMatch(
      /set-cookie|content-security|access-control|strict-transport|clear-site/i,
    );
    expect(text.endsWith("\r\n\r\n\x81\x02hi")).toBe(true);
    const frame = enc("\x81\x05Set-Cookie: x\r\n\r\n");
    expect(f(frame)).toBe(frame);
  });

  test("no head within the limit: given up", () => {
    const f = upgradeHeadFilter(64);
    expect(f(enc("HTTP/1.1 101 x\r\n" + "a: b\r\n".repeat(20)))).toBe("too-large");
    expect(MAX_HEAD_BYTES).toBe(16 * 1024);
  });
});

const T0 = 1_800_000_000_000;
const OWNER = { id: "u1", email: "owner@example.com" };

function d1() {
  const d = createTestD1(testSchema());
  d.raw().exec(
    "INSERT INTO user (id, email, name, emailVerified, createdAt, updatedAt) VALUES ('u1', 'owner@example.com', 'o', 1, 0, 0)",
  );
  return d;
}
const rows = (d: ReturnType<typeof createTestD1>) =>
  d.raw().prepare("SELECT kind, actor, subject, detail FROM security_audit ORDER BY id").all() as {
    kind: string;
    actor: string;
    subject: string | null;
    detail: string | null;
  }[];

describe("the dev-token cap is one statement", () => {
  test("concurrent mints never pass it", async () => {
    const d = d1();
    const db = d as unknown as DevAccessDb;
    const tries = await Promise.allSettled(
      Array.from({ length: MAX_LIVE_TOKENS + 7 }, (_, i) => mintToken(db, OWNER, `t${i}`, 7, T0)),
    );
    expect(tries.filter((t) => t.status === "fulfilled")).toHaveLength(MAX_LIVE_TOKENS);
    expect(tries.filter((t) => t.status === "rejected")).toHaveLength(7);
    expect(await listTokens(db, OWNER.id)).toHaveLength(MAX_LIVE_TOKENS);
  });

  test("revoked and expired tokens free their place; handoffs never count", async () => {
    const d = d1();
    const db = d as unknown as DevAccessDb;
    const ids: string[] = [];
    for (let i = 0; i < MAX_LIVE_TOKENS; i++)
      ids.push((await mintToken(db, OWNER, `t${i}`, 1, T0)).id);
    await mintHandoff(db, OWNER, T0);
    await expect(mintToken(db, OWNER, "x", 7, T0)).rejects.toThrow("at most");
    await revokeToken(db, OWNER.id, ids[0], T0);
    await mintToken(db, OWNER, "x", 7, T0);
    // A day later the 1-day ones have expired.
    await mintToken(db, OWNER, "y", 7, T0 + 86_400_001);
  });
});

describe("audit rows", () => {
  test("dev tokens: mint, handoff, revoke, revoke all — ids only", async () => {
    const d = d1();
    const db = d as unknown as DevAccessDb;
    const t = await mintToken(db, OWNER, "iPhone", 7, T0);
    const h = await mintHandoff(db, OWNER, T0);
    expect(await revokeToken(db, OWNER.id, t.id, T0)).toBe(true);
    expect(await revokeToken(db, OWNER.id, t.id, T0)).toBe(false); // not live: no row
    await revokeAll(db, OWNER.id, T0);
    expect(rows(d)).toEqual([
      { kind: "dev-token.mint", actor: "u1", subject: t.id, detail: null },
      { kind: "dev-handoff.mint", actor: "u1", subject: h.id, detail: null },
      { kind: "dev-token.revoke", actor: "u1", subject: t.id, detail: null },
      { kind: "dev-token.revoke-all", actor: "u1", subject: null, detail: null },
    ]);
    const dump = JSON.stringify(d.raw().prepare("SELECT * FROM security_audit").all());
    expect(dump).not.toContain(t.token);
    expect(dump).not.toContain(h.token);
  });

  test("live view: on and off from the Mac's key, the owner's stop; never the pointer", async () => {
    const p = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const priv = await importLiveViewPrivateKey(await crypto.subtle.exportKey("jwk", p.privateKey));
    const pub = await importLiveViewPublicKey(
      b64url(new Uint8Array(await crypto.subtle.exportKey("raw", p.publicKey))),
    );
    const now = Date.parse("2026-11-05T03:00:00Z");
    const iat = Math.floor(now / 1000);
    const d = d1();
    const db = d as unknown as LiveViewDb;
    const token = await signLiveView(priv, {
      op: "on",
      serial: 5,
      iat,
      exp: iat + 3600,
      widget: `${LIVE_VIEW_ORIGINS[0]}/lianki-widget/debug-chat.js`,
      branch: "feat/x",
      sha: "abcdef1",
    });
    expect((await handlePost({ token }, db, [pub], now)).status).toBe(200);
    expect((await handlePost({ token }, db, [pub], now)).status).toBe(409); // replay: no row
    const off = await signLiveView(priv, { op: "off", serial: 6, iat, exp: iat + 60 });
    expect((await handlePost({ token: off }, db, [pub], now)).status).toBe(200);
    await clearPointer(db, now, "u1");
    expect(rows(d)).toEqual([
      { kind: "live-view.on", actor: "mac-key", subject: "5", detail: "feat/x@abcdef1" },
      { kind: "live-view.off", actor: "mac-key", subject: "6", detail: null },
      { kind: "live-view.stop", actor: "u1", subject: null, detail: null },
    ]);
    expect(JSON.stringify(rows(d))).not.toContain(token.split(".")[1]);
  });

  test("a failed audit insert never throws (best effort)", async () => {
    expect(await audit(createTestD1("") as never, { kind: "live-view.stop", actor: "x" })).toBe(
      false,
    );
  });
});

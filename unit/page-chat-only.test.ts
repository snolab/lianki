import { describe, expect, it } from "bun:test";
import { pageChatTicket as mint } from "../lib/page-chat-ticket";
import {
  pageChatTicket as verify,
  partnerTicket,
  liChatTicket,
  PAGE_CHAT_HEADER,
  EMBED_HEADER,
  SUB_THREAD_HEADER,
  SUB_ORIGIN_HEADER,
} from "../workers/push/src/auth";
import {
  PAGE_CHAT_TICKET_AUD,
  PARTNER_TICKET_AUD,
  PARTNER_SUBPROTOCOL,
  b64url,
  fromB64url,
  signSttTicket,
  verifySttTicket,
} from "../lib/stt-ticket";
import { threadHashKey } from "../lib/li-thread";
import type { LiTicketDeps } from "../lib/li-ticket-route";
import { pageChatFetch, type ChatGmRequest } from "../src/page-chat-fetch";
import { consentedFrameTicket } from "../src/pill-chat";
import { portableSource, portableChatPath } from "../lib/portable-chat-url";
import push from "../workers/push/src/index";
import { buildMessages, parsePartnerRequest } from "../lib/partner-ai";

const NOW = 1800000000000,
  HOST = "https://example.test";
async function setup(owner = true) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const calls: string[] = [];
  const deps: LiTicketDeps = {
    backend: () => "d1",
    d1: () => {
      throw Error("no bearer-token database read");
    },
    sessionUser: async () => ({ id: "account_1", email: "viewer@example.test" }),
    isDev: async () => owner,
    flags: async () => ({ "ext.pill-chat": true, "ext.pill-chat-users": true }),
    allow: async (id) => (calls.push(id), true),
    key: async () => pair.privateKey,
    threadKey: async () => threadHashKey("synthetic-page-chat-test-key"),
    now: () => NOW,
  };
  const request = (headers: Record<string, string> = {}, method = "POST") =>
    new Request("https://lianki.com/api/chat/page-ticket", {
      method,
      headers: { "x-lianki-userscript": "1", "x-lianki-host-origin": HOST, ...headers },
    });
  const issued = async () => {
    const r = await mint(request(), deps);
    expect(r.status).toBe(200);
    return ((await r.json()) as { ticket: string }).ticket;
  };
  return { pair, pub, deps, calls, request, issued };
}
const payload = (t: string) => JSON.parse(new TextDecoder().decode(fromB64url(t.split(".")[0]!)));
const upgrade = (t: string, origin = "https://lianki.com", host = HOST) =>
  new Request("https://lianki.com/api/version/debug?ho=" + encodeURIComponent(host), {
    headers: {
      upgrade: "websocket",
      origin,
      "sec-websocket-protocol": PARTNER_SUBPROTOCOL + ", " + t,
    },
  });

describe("portable Li page-realm issuer and signed scope", () => {
  it("owner and account: 60 seconds, own identity, mandatory source/thread, distinct audience", async () => {
    for (const owner of [true, false]) {
      const s = await setup(owner),
        t = await s.issued(),
        p = payload(t);
      expect(p).toMatchObject({ aud: PAGE_CHAT_TICKET_AUD, sub: "account_1", ho: HOST });
      expect(p.own).toBe(owner ? true : undefined);
      expect(p.th).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(p.exp - p.iat).toBe(60);
      expect(p.email).toBeUndefined();
      const v = await verify(upgrade(t), s.pub, new Map(), NOW);
      expect(v).toMatchObject({ sub: "account_1", owner, chatOnly: true, ho: HOST, th: p.th });
      expect(await partnerTicket(upgrade(t), s.pub, new Map(), NOW)).toBeNull();
      expect(await liChatTicket(upgrade(t), s.pub, new Map(), NOW)).toBeNull();
    }
  });
  it("never accepts an API token, a missing identity/header/source, a disabled feature or wrong method", async () => {
    const s = await setup();
    for (const req of [
      s.request({ authorization: "Bearer synthetic-not-a-secret" }),
      s.request({ "x-lianki-userscript": "" }),
      s.request({ "x-lianki-host-origin": "" }),
      s.request({ "x-lianki-host-origin": "javascript:alert(1)" }),
      s.request({}, "GET"),
    ])
      expect((await mint(req, s.deps)).status).toBe(404);
    s.deps.sessionUser = async () => null;
    expect((await mint(s.request(), s.deps)).status).toBe(404);
    const off = await setup();
    off.deps.flags = async () => ({});
    expect((await mint(off.request(), off.deps)).status).toBe(404);
    expect(s.calls).toEqual([]);
  });
  it("rate and key failures fail closed; no account-selected alternate identity", async () => {
    const s = await setup();
    s.deps.allow = async () => false;
    expect((await mint(s.request(), s.deps)).status).toBe(429);
    s.deps.allow = async () => true;
    s.deps.key = async () => null;
    expect((await mint(s.request(), s.deps)).status).toBe(503);
  });
  it("wrong origin/site, expiration, replay and signature tampering cannot upgrade the scope", async () => {
    const s = await setup(false),
      t = await s.issued(),
      seen = new Map<string, number>();
    expect(await verify(upgrade(t, HOST), s.pub, new Map(), NOW)).toBeNull();
    expect(
      await verify(upgrade(t, undefined, "https://other.test"), s.pub, new Map(), NOW),
    ).toBeNull();
    expect(await verify(upgrade(t), s.pub, new Map(), NOW + 70000)).toBeNull();
    expect(await verify(upgrade(t), s.pub, seen, NOW)).not.toBeNull();
    expect(await verify(upgrade(t), s.pub, seen, NOW)).toBeNull();
    const p = { ...payload(t), own: true };
    const forged = b64url(new TextEncoder().encode(JSON.stringify(p))) + "." + t.split(".")[1];
    expect(await verify(upgrade(forged), s.pub, new Map(), NOW)).toBeNull();
    const unbound = await signSttTicket(s.pair.privateKey, {
      aud: PAGE_CHAT_TICKET_AUD,
      sub: "account_1",
      now: NOW,
    });
    expect(await verify(upgrade(unbound.ticket), s.pub, new Map(), NOW)).toBeNull();
    expect(
      (await verifySttTicket(t, s.pair.publicKey, new Map(), NOW, PARTNER_TICKET_AUD)).ok,
    ).toBe(false);
  });
  it("ingress discards claimed identity/cookie and stamps the signed limited scope", async () => {
    const s = await setup(),
      t = await s.issued();
    const seen: Headers[] = [];
    const env = {
      PARTNER_TICKET_PUB: s.pub,
      DEBUG: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async (req: Request) => (seen.push(req.headers), new Response("hub")),
        }),
      },
      MAIN: { fetch: async () => Response.json({ userId: "not-the-signed-user", owner: true }) },
    };
    // The real ingress clock must match this synthetic ticket.
    const live = await signSttTicket(s.pair.privateKey, {
      aud: PAGE_CHAT_TICKET_AUD,
      sub: "account_1",
      own: true,
      ho: HOST,
      th: payload(t).th,
    });
    const req = upgrade(live.ticket);
    const h = new Headers(req.headers);
    h.set("cookie", "synthetic-cookie");
    h.set("x-debug-user", "attacker");
    h.set("x-debug-owner", "0");
    h.set(PAGE_CHAT_HEADER, "0");
    h.set("x-debug-box", "fake-box");
    expect(await (await push.fetch(new Request(req, { headers: h }), env as never)).text()).toBe(
      "hub",
    );
    expect(seen[0]!.get("cookie")).toBeNull();
    expect(seen[0]!.get("x-debug-user")).toBe("account_1");
    expect(seen[0]!.get("x-debug-owner")).toBe("1");
    expect(seen[0]!.get(PAGE_CHAT_HEADER)).toBe("1");
    expect(seen[0]!.get("x-debug-box")).toBeNull();
    expect(seen[0]!.get(EMBED_HEADER)).toBeTruthy();
    expect(seen[0]!.get(SUB_THREAD_HEADER)).toBe(payload(t).th);
    expect(seen[0]!.get(SUB_ORIGIN_HEADER)).toBe(HOST);
  });
});

describe("page ticket authenticated identity echo", () => {
  it("the 随身Li frame takes a real issuer ticket for the consented account, refuses cookie B for consent A", async () => {
    const s = await setup();
    const brokered = () =>
      pageChatFetch("https://lianki.com", HOST, (r) => {
        void mint(new Request(r.url, { method: r.method, headers: r.headers }), s.deps).then(
          async (response) => {
            r.onload({ status: response.status, responseText: await response.text() });
          },
        );
      });
    let changed = 0;
    const ask = () =>
      consentedFrameTicket({
        fetch: brokered(),
        origin: "https://lianki.com",
        principal: "account_1",
        onAccountMismatch: () => void changed++,
        report: () => {},
      });
    s.deps.sessionUser = async () => ({ id: "account_1", email: "viewer@example.test" });
    const ticket = await ask();
    expect(typeof ticket).toBe("string");
    expect(payload(ticket!).sub).toBe("account_1");
    expect(changed).toBe(0);
    s.deps.sessionUser = async () => ({ id: "account_2", email: "viewer@example.test" });
    expect(await ask()).toBeNull();
    expect(changed).toBe(1);
  });
  it("echoes the authenticated cookie account, never a caller-chosen principal", async () => {
    const s = await setup();
    for (const id of ["account_1", "account_2"]) {
      s.deps.sessionUser = async () => ({ id, email: "viewer@example.test" });
      const r = await mint(s.request({ "x-lianki-chat-principal": "account_1" }), s.deps);
      const body = (await r.json()) as { ticket: string; principal: string };
      expect(r.status).toBe(200);
      expect(body.principal).toBe(id);
      expect(payload(body.ticket).sub).toBe(body.principal);
    }
  });
});

describe("page broker: no general credentials or advanced HTTP routes", () => {
  it("uses only fixed cookie-authenticated chat endpoints; never forwards arbitrary caller headers", async () => {
    const calls: Parameters<ChatGmRequest>[0][] = [];
    const f = pageChatFetch("https://lianki.com", HOST, (r) => {
      calls.push(r);
      r.onload({
        status: 200,
        responseText: JSON.stringify({ on: true, ticket: "synthetic-chat-cap" }),
      });
    });
    const response = await f("https://lianki.com/api/ext/pill-chat", {
      headers: { Authorization: "synthetic-private-api-token" },
    });
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ on: true, ticket: "synthetic-chat-cap" });
    await f("https://lianki.com/api/chat/page-ticket", {
      method: "POST",
      headers: {
        Authorization: "synthetic-private-api-token",
        "x-lianki-host-origin": "https://other.test",
      },
    });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.withCredentials).toBe(true);
      expect(c.headers.Authorization).toBeUndefined();
    }
    expect(calls[1]!.headers).toEqual({ "x-lianki-userscript": "1", "x-lianki-host-origin": HOST });
  });
  for (const event of ["onerror", "ontimeout"] as const)
    it("reports " + event + " without falling back to general credentials", async () => {
      const calls: Parameters<ChatGmRequest>[0][] = [];
      const fetch = pageChatFetch("https://lianki.com", HOST, (request) => {
        calls.push(request);
        request[event]();
      });
      await expect(
        fetch("https://lianki.com/api/chat/page-ticket", { method: "POST" }),
      ).rejects.toThrow(event === "onerror" ? "connection failed" : "timed out");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.headers.Authorization).toBeUndefined();
    });
  for (const [capability, path] of [
    ["eval", "/api/version/debug/control"],
    ["token", "/api/token"],
    ["settings", "/api/preferences"],
    ["payment", "/api/payments/checkout"],
    ["private-data", "/api/profile"],
    ["pairing", "/api/debug/pair"],
  ])
    it("refuses " + capability + " before any request", async () => {
      let calls = 0;
      const f = pageChatFetch("https://lianki.com", HOST, () => {
        calls++;
      });
      await expect(f("https://lianki.com" + path, { method: "POST" })).rejects.toThrow("Chat only");
      expect(calls).toBe(0);
    });
  it("also refuses host substitutions, read endpoints with the wrong method and ticket GET", async () => {
    let calls = 0;
    const f = pageChatFetch("https://lianki.com", HOST, () => {
      calls++;
    });
    for (const [url, method] of [
      ["https://elsewhere.test/api/ext/pill-chat", "GET"],
      ["https://lianki.com/api/ext/pill-chat", "POST"],
      ["https://lianki.com/api/chat/page-ticket", "GET"],
    ])
      await expect(f(url!, { method })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

describe("safe direct chat destination", () => {
  it("opens /chat with source origin only, never private query/fragment or a redirect", () => {
    expect(portableChatPath("https://example.test/private?q=synthetic-secret#fragment")).toBe(
      "/chat?from=https%3A%2F%2Fexample.test",
    );
    expect(portableChatPath()).toBe("/chat");
    const credentialUrl = new URL("https://example.test");
    credentialUrl.username = "synthetic-user";
    credentialUrl.password = "synthetic-password";
    for (const v of [
      "javascript:alert(1)",
      "data:text/html,test",
      credentialUrl.href,
      "broken",
      null,
      ["https://example.test"],
    ])
      expect(portableSource(v)).toBeNull();
  });
});

describe("chat-only model request excludes private summaries", () => {
  it("keeps only the site chat, ignores even a mistakenly supplied summary/roster/polish", () => {
    const req = parsePartnerRequest({
      userId: "account_1",
      owner: true,
      chatOnly: true,
      history: [{ role: "user", text: "Hello from this site" }],
      roster: [{ id: "hidden", name: "private-roster-sentinel" }],
      polish: [{ id: "old", text: "private-polish-sentinel" }],
    })!;
    expect(req.chatOnly).toBe(true);
    expect(req.roster).toBeUndefined();
    expect(req.polish).toBeUndefined();
    const body = JSON.stringify(
      buildMessages(req, { lists: ["private-summary-sentinel"] } as never, NOW),
    );
    expect(body).toContain("Hello from this site");
    expect(body).toContain("chat-only");
    expect(body).not.toContain("private-summary-sentinel");
    expect(body).not.toContain("private-roster-sentinel");
    expect(parsePartnerRequest({ ...req, chatOnly: false })).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BYOK_PRESETS, RELAY_PRESETS, presetOf } from "@/lib/byok/presets";
import {
  checkBackend,
  checkRedirect,
  checkTarget,
  dnsAnswersOk,
  dohResolver,
  endpointOf,
  ipBlocked,
  looksLikeIp,
  parseInput,
  PROXY_LIMITS,
  PROXY_RATE,
} from "@/lib/byok/proxy-guard";
import { handleProxy, type ProxyDeps } from "@/lib/byok/proxy-server";
import { checkRateLimit } from "@/lib/rateLimit";
import { cleanBackend, gapOf, type ByokActive } from "@/lib/byok/config";
import { byokComplete } from "@/lib/byok/call";

/**
 * docs/byok.md "The relay": POST /api/byok/proxy forwards a user's own key to
 * an ALLOWLISTED provider only, and keeps nothing. Every guard is here.
 */

// Built at runtime so no key-shaped literal is ever committed.
const KEY = ["tst", "relay", crypto.randomUUID().replaceAll("-", "")].join("_");
const TEXT = `private sentence ${crypto.randomUUID()}`;
const ORIGIN = "https://lianki.com";
const openai = presetOf("openai")!;
const anthropic = presetOf("anthropic")!;

const body = (over: Record<string, unknown> = {}) => ({
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: TEXT }],
  maxTokens: 64,
  ...over,
});

function req(
  b: unknown = body(),
  h: Record<string, string> = {},
  opts: { method?: string; raw?: string } = {},
) {
  return new Request(`${ORIGIN}/api/byok/proxy`, {
    method: opts.method ?? "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      host: "lianki.com",
      "sec-fetch-site": "same-origin",
      authorization: `Bearer ${KEY}`,
      cookie: "session=abc",
      ...h,
    },
    body: opts.method === "GET" ? undefined : (opts.raw ?? JSON.stringify(b)),
  });
}

const okJson = (v: unknown = { choices: [{ message: { content: "Bonjour" } }] }) =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

type Call = { url: string; init: RequestInit };
let calls: Call[];
let hits: string[];
let logs: string[];
const consoleBackup: Record<string, (...a: unknown[]) => void> = {};
const LEVELS = ["log", "info", "warn", "error", "debug", "trace"] as const;

function deps(over: Partial<ProxyDeps> = {}, answer: (c: Call) => Response = () => okJson()) {
  return {
    fetch: async (url: string, init: RequestInit) => {
      const c = { url, init };
      calls.push(c);
      return answer(c);
    },
    resolve: async () => ({ ok: true as const }),
    hit: async (key: string) => {
      hits.push(key);
      return { allowed: true, retryAfterMs: 0 };
    },
    ip: "198.51.100.7",
    userId: "user-1",
    ...over,
  } satisfies ProxyDeps;
}

beforeEach(() => {
  calls = [];
  hits = [];
  logs = [];
  for (const l of LEVELS) {
    consoleBackup[l] = console[l];
    (console as unknown as Record<string, unknown>)[l] = (...a: unknown[]) =>
      logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  }
});
afterEach(() => {
  for (const l of LEVELS) (console as unknown as Record<string, unknown>)[l] = consoleBackup[l];
  // Nothing the relay saw may appear in anything logged, in any test.
  for (const line of logs) {
    expect(line).not.toContain(KEY);
    expect(line).not.toContain(TEXT);
    expect(line.toLowerCase()).not.toContain("authorization");
    expect(line).not.toContain("api.openai.com");
  }
});

// ── IP ranges ─────────────────────────────────────────────────────────────

describe("ipBlocked", () => {
  const blocked = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1", // CGNAT
    "100.127.255.255",
    "127.0.0.1",
    "127.255.0.9",
    "169.254.169.254", // AWS / GCP / Azure metadata
    "169.254.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.170",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1", // multicast
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1", // IPv4-mapped
    "::ffff:7f00:1", // IPv4-mapped, hex
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::127.0.0.1", // IPv4-compatible
    "::ffff:0:10.0.0.1",
    "64:ff9b::a9fe:a9fe", // NAT64 → metadata
    "64:ff9b:1::1",
    "2002:7f00:1::1", // 6to4 → loopback
    "2001::1", // Teredo
    "2001:db8::1",
    "fc00::1",
    "fd00:ec2::254", // AWS IMDS over IPv6
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "100::1",
    "not-an-ip",
    "1.2.3",
    "256.1.1.1",
  ];
  for (const ip of blocked) it(`refuses ${ip}`, () => expect(ipBlocked(ip)).toBe(true));
  for (const ip of ["8.8.8.8", "1.1.1.1", "104.18.6.192", "2606:4700::1111", "2a00:1450::1"])
    it(`allows public ${ip}`, () => expect(ipBlocked(ip)).toBe(false));

  it("sees IPv4 in any spelling as an IP literal", () => {
    for (const h of [
      "2130706433",
      "0177.0.0.1",
      "0x7f.1",
      "0x7f000001",
      "127.1",
      "[::1]",
      "1.2.3.4.",
    ])
      expect(looksLikeIp(h)).toBe(true);
    expect(looksLikeIp("api.openai.com")).toBe(false);
  });
});

// ── The allowlist and URL rules ───────────────────────────────────────────

describe("checkTarget / checkBackend (allowlist)", () => {
  it("allows each allowlisted preset at its standard address, and only those", () => {
    expect(RELAY_PRESETS.map((p) => p.id).sort()).toEqual(
      ["anthropic", "deepseek", "gemini", "openai", "openrouter"].sort(),
    );
    for (const p of RELAY_PRESETS) {
      const t = checkBackend(p.id, p.baseUrl);
      expect(t.ok).toBe(true);
    }
    expect(checkBackend("anthropic", "https://api.anthropic.com/v1")).toMatchObject({
      ok: true,
      url: "https://api.anthropic.com/v1/messages",
    });
  });

  it("never relays a custom backend or a local server", () => {
    expect(checkBackend("custom", "https://my.example.com/v1")).toEqual({
      ok: false,
      reason: "provider",
    });
    expect(checkBackend("ollama", "http://localhost:11434/v1")).toEqual({
      ok: false,
      reason: "provider",
    });
    expect(checkBackend("nope", "https://api.openai.com/v1")).toEqual({
      ok: false,
      reason: "provider",
    });
    expect(
      BYOK_PRESETS.filter((p) => !p.relay)
        .map((p) => p.id)
        .sort(),
    ).toEqual(["custom", "ollama"]);
  });

  const refused: [string, string][] = [
    ["http://api.openai.com/v1/chat/completions", "scheme"],
    ["ftp://api.openai.com/v1/chat/completions", "scheme"],
    ["https://api.openai.com:8443/v1/chat/completions", "scheme"],
    [`https://${["u", "p"].join(":")}@api.openai.com/v1/chat/completions`, "url"],
    ["https://api.openai.com/v1/chat/completions?x=1", "url"],
    ["https://api.openai.com/v1/chat/completions#a", "url"],
    ["https://api.openai.com/v1/chat%2fcompletions", "url"],
    ["https://api.openai.com/v1/%2e%2e/chat/completions", "url"],
    ["https://api.openai.com\\@evil.example/v1/chat/completions", "url"],
    ["https://api.openai.com/v1/models", "path"],
    ["https://api.openai.com/v1/files", "path"],
    ["https://api.openai.com/", "path"],
    ["https://evil.example/v1/chat/completions", "host"],
    ["https://api.openai.com.evil.example/v1/chat/completions", "host"],
    ["https://api.openai.com./v1/chat/completions", "host"],
    ["https://API.OPENAI.COM.evil/v1/chat/completions", "host"],
    ["https://127.0.0.1/v1/chat/completions", "host"],
    ["https://2130706433/v1/chat/completions", "host"], // decimal 127.0.0.1
    ["https://0177.0.0.1/v1/chat/completions", "host"], // octal
    ["https://0x7f.0.0.1/v1/chat/completions", "host"], // hex
    ["https://0x7f000001/v1/chat/completions", "host"],
    ["https://127.1/v1/chat/completions", "host"],
    ["https://169.254.169.254/v1/chat/completions", "host"],
    ["https://[::1]/v1/chat/completions", "host"],
    ["https://[::ffff:127.0.0.1]/v1/chat/completions", "host"],
    ["https://[::ffff:a9fe:a9fe]/v1/chat/completions", "host"],
    ["https://[fd00:ec2::254]/v1/chat/completions", "host"],
    ["https://10.0.0.1/v1/chat/completions", "host"],
    ["https://100.64.0.1/v1/chat/completions", "host"],
    ["https://metadata.google.internal/v1/chat/completions", "host"],
    ["https://localhost/v1/chat/completions", "host"],
    ["https://lianki.com/v1/chat/completions", "host"],
    ["https://www.lianki.com/v1/chat/completions", "host"],
    ["https://lianki.snomiao.workers.dev/v1/chat/completions", "host"],
    ["https://router.home.arpa/v1/chat/completions", "host"],
    ["not a url", "url"],
  ];
  for (const [url, reason] of refused)
    it(`refuses ${url}`, () => {
      const r = checkTarget(url, openai);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(reason as never);
    });

  it("refuses another provider's host, and the anthropic path for openai", () => {
    expect(checkTarget("https://api.anthropic.com/v1/messages", openai).ok).toBe(false);
    expect(checkTarget("https://api.openai.com/v1/chat/completions", anthropic).ok).toBe(false);
    expect(checkTarget("https://api.anthropic.com/v1/complete", anthropic).ok).toBe(false);
  });

  it("builds the endpoint from the base URL by protocol", () => {
    expect(endpointOf("https://api.openai.com/v1/", openai)).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(endpointOf("https://api.anthropic.com/v1", anthropic)).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });
});

describe("checkRedirect", () => {
  const cur = "https://api.openai.com/v1/chat/completions";
  it("follows only 307/308 to the same allowlisted host and path", () => {
    expect(checkRedirect(307, "/v1/chat/completions", cur, openai, 0).ok).toBe(true);
    expect(checkRedirect(308, cur, cur, openai, 0).ok).toBe(true);
    for (const s of [301, 302, 303]) expect(checkRedirect(s, cur, cur, openai, 0).ok).toBe(false);
  });
  it("refuses a redirect to a private, other or unlisted address", () => {
    for (const loc of [
      "http://169.254.169.254/latest/meta-data/",
      "https://169.254.169.254/v1/chat/completions",
      "https://[::ffff:127.0.0.1]/v1/chat/completions",
      "https://evil.example/v1/chat/completions",
      "https://api.anthropic.com/v1/messages", // allowlisted, but not this provider
      "https://lianki.com/api/byok/proxy",
      "/v1/models",
      "",
    ])
      expect(checkRedirect(307, loc, cur, openai, 0).ok).toBe(false);
    expect(checkRedirect(307, null, cur, openai, 0).ok).toBe(false);
  });
  it("stops after maxHops", () => {
    expect(checkRedirect(307, cur, cur, openai, PROXY_LIMITS.maxHops).ok).toBe(false);
  });
});

describe("DNS (DoH)", () => {
  it("accepts only all-public answers, and never a CNAME into ours", () => {
    expect(dnsAnswersOk([{ type: 1, data: "104.18.6.192" }])).toBe(true);
    expect(dnsAnswersOk([])).toBe(false);
    expect(
      dnsAnswersOk([
        { type: 1, data: "104.18.6.192" },
        { type: 1, data: "10.0.0.1" },
      ]),
    ).toBe(false);
    expect(dnsAnswersOk([{ type: 28, data: "fd00:ec2::254" }])).toBe(false);
    expect(dnsAnswersOk([{ type: 28, data: "::ffff:169.254.169.254" }])).toBe(false);
    expect(dnsAnswersOk([{ type: 1, data: "169.254.169.254" }])).toBe(false);
    expect(
      dnsAnswersOk([
        { type: 5, data: "lianki.com." },
        { type: 1, data: "104.18.6.192" },
      ]),
    ).toBe(false);
    expect(
      dnsAnswersOk([
        { type: 5, data: "metadata.google.internal." },
        { type: 1, data: "8.8.8.8" },
      ]),
    ).toBe(false);
  });

  it("calls DoH the way a Worker's fetch accepts: redirect manual, and a redirect is refused", async () => {
    // workerd throws on redirect: "error", which failed every call in production.
    const inits: RequestInit[] = [];
    const answer = (status: number) =>
      (async (_u: string, init: RequestInit) => {
        inits.push(init);
        return new Response(
          JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "104.18.6.192" }] }),
          { status, headers: status === 302 ? { location: "https://evil.example/" } : {} },
        );
      }) as unknown as typeof fetch;
    expect(await dohResolver(answer(200))("api.openai.com")).toEqual({ ok: true });
    expect(inits.length).toBeGreaterThan(0);
    expect(inits.every((i) => i.redirect === "manual")).toBe(true);
    expect(await dohResolver(answer(302))("api.openai.com")).toEqual({ ok: false });
  });

  it("asks Cloudflare DoH for A and AAAA, fails closed, and refuses a private answer (rebinding)", async () => {
    const asked: string[] = [];
    const doh = (answers: Record<string, unknown[]>, status = 200) =>
      (async (url: string | URL | Request) => {
        const u = new URL(String(url));
        asked.push(`${u.host} ${u.searchParams.get("type")}`);
        return new Response(
          JSON.stringify({ Status: 0, Answer: answers[u.searchParams.get("type")!] }),
          {
            status,
          },
        );
      }) as unknown as typeof fetch;
    expect(
      await dohResolver(doh({ A: [{ type: 1, data: "104.18.6.192" }], AAAA: [] }))(
        "api.openai.com",
      ),
    ).toEqual({ ok: true });
    expect(asked).toEqual(["cloudflare-dns.com A", "cloudflare-dns.com AAAA"]);
    expect(
      await dohResolver(doh({ A: [{ type: 1, data: "127.0.0.1" }], AAAA: [] }))("api.openai.com"),
    ).toEqual({ ok: false });
    expect(
      await dohResolver(doh({ A: [], AAAA: [{ type: 28, data: "::1" }] }))("api.openai.com"),
    ).toEqual({ ok: false });
    expect(await dohResolver(doh({ A: [], AAAA: [] }))("api.openai.com")).toEqual({ ok: false });
    expect(await dohResolver(doh({}, 500))("api.openai.com")).toEqual({ ok: false });
    const thrower = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await dohResolver(thrower)("api.openai.com")).toEqual({ ok: false });
  });
});

describe("parseInput", () => {
  it("takes only the known fields within bounds", () => {
    expect(parseInput(body())).not.toBeNull();
    expect(parseInput(body({ extra: 1 }))).toBeNull();
    expect(parseInput(body({ tools: [] }))).toBeNull();
    expect(parseInput(body({ apiKey: KEY }))).toBeNull();
    expect(parseInput(body({ messages: [] }))).toBeNull();
    expect(parseInput(body({ messages: [{ role: "tool", content: "x" }] }))).toBeNull();
    expect(parseInput(body({ messages: [{ role: "user", content: "x", name: "n" }] }))).toBeNull();
    expect(
      parseInput(body({ messages: Array(41).fill({ role: "user", content: "x" }) })),
    ).toBeNull();
    expect(
      parseInput(body({ messages: [{ role: "user", content: "x".repeat(48_001) }] })),
    ).toBeNull();
    expect(parseInput(body({ maxTokens: 0 }))).toBeNull();
    expect(parseInput(body({ maxTokens: 4097 }))).toBeNull();
    expect(parseInput(body({ temperature: 3 }))).toBeNull();
    expect(parseInput(body({ model: "bad model" }))).toBeNull();
    expect(parseInput([])).toBeNull();
  });
});

// ── The handler ───────────────────────────────────────────────────────────

describe("handleProxy", () => {
  it("forwards one call to the allowlisted endpoint with only the needed headers", async () => {
    const d = deps();
    const res = await handleProxy(req(), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ choices: [{ message: { content: "Bonjour" } }] });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(c.init.method).toBe("POST");
    expect(c.init.redirect).toBe("manual");
    expect(c.init.cache).toBe("no-store");
    const h = c.init.headers as Record<string, string>;
    expect(Object.keys(h).sort()).toEqual(["authorization", "content-type"]);
    expect(h.authorization).toBe(`Bearer ${KEY}`);
    const sent = JSON.parse(String(c.init.body));
    expect(Object.keys(sent).sort()).toEqual(["max_tokens", "messages", "model", "temperature"]);
    // One log line of counts only.
    expect(logs).toHaveLength(1);
    const line = JSON.parse(logs[0]);
    expect(Object.keys(line).sort()).toEqual([
      "bytes",
      "event",
      "hops",
      "ms",
      "outcome",
      "provider",
      "status",
    ]);
    expect(line).toMatchObject({
      event: "byok.proxy",
      provider: "openai",
      outcome: "ok",
      status: 200,
    });
  });

  it("speaks Anthropic's /v1/messages for the anthropic preset, with x-api-key", async () => {
    const res = await handleProxy(
      req(
        body({
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          model: "claude-haiku-4-5",
          messages: [
            { role: "system", content: "s" },
            { role: "user", content: TEXT },
          ],
        }),
      ),
      deps({}, () => okJson({ content: [{ type: "text", text: "hi" }] })),
    );
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe(KEY);
    expect(h.authorization).toBeUndefined();
    expect(h["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
    expect(JSON.parse(String(calls[0].init.body)).system).toBe("s");
  });

  it("is same-origin JSON POST only", async () => {
    for (const r of [
      req(body(), { origin: "https://evil.example" }),
      req(body(), { "sec-fetch-site": "cross-site" }),
      req(body(), { "content-type": "text/plain" }),
      req(body(), {}, { method: "PUT" }),
      req(undefined, {}, { method: "GET" }),
    ]) {
      const res = await handleProxy(r, deps());
      expect(res.status).toBe(403);
      expect((await res.json()).proxyError).toBe("origin");
    }
    const noOrigin = new Request(`${ORIGIN}/api/byok/proxy`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body()),
    });
    expect((await handleProxy(noOrigin, deps())).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("caps the request body (declared and streamed)", async () => {
    const big = JSON.stringify(
      body({ messages: [{ role: "user", content: "x".repeat(PROXY_LIMITS.maxBodyBytes) }] }),
    );
    expect((await handleProxy(req(undefined, {}, { raw: big }), deps())).status).toBe(413);
    // Declared too big: refused on the header, whatever the body really is.
    const declared = req(undefined, { "content-length": String(PROXY_LIMITS.maxBodyBytes + 1) });
    expect(declared.headers.get("content-length")).toBe(String(PROXY_LIMITS.maxBodyBytes + 1));
    expect((await handleProxy(declared, deps())).status).toBe(413);
    // Declared small, sent big: the bytes are counted anyway.
    const understated = req(undefined, { "content-length": "10" }, { raw: big });
    expect(understated.headers.get("content-length")).toBe("10");
    expect((await handleProxy(understated, deps())).status).toBe(413);
    // No length at all (a stream): the bytes are counted anyway.
    const lying = new Request(`${ORIGIN}/api/byok/proxy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        host: "lianki.com",
        authorization: `Bearer ${KEY}`,
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
      // @ts-expect-error Bun/undici need duplex for a stream body
      duplex: "half",
    });
    expect((await handleProxy(lying, deps())).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("needs the key in Authorization, never in the body", async () => {
    expect((await handleProxy(req(body(), { authorization: "" }), deps())).status).toBe(400);
    expect(
      (await handleProxy(req(body(), { authorization: `Bearer ${KEY} x` }), deps())).status,
    ).toBe(400);
    expect(
      (await handleProxy(req(body({ apiKey: KEY }), { authorization: "" }), deps())).status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("refuses every non-allowlisted backend without fetching", async () => {
    for (const b of [
      body({ provider: "custom", baseUrl: "https://my.example.com/v1" }),
      body({ provider: "ollama", baseUrl: "http://localhost:11434/v1" }),
      body({ baseUrl: "https://169.254.169.254/v1" }),
      body({ baseUrl: "https://[::ffff:127.0.0.1]/v1" }),
      body({ baseUrl: "https://2130706433/v1" }),
      body({ baseUrl: "https://metadata.google.internal/v1" }),
      body({ baseUrl: "https://lianki.com/api" }),
      body({ baseUrl: "https://evil.example/v1" }),
      body({ baseUrl: "https://api.openai.com/v1/files#" }),
    ]) {
      const res = await handleProxy(req(b), deps());
      expect(res.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses an allowlisted host whose DNS answers privately (hijack / rebinding)", async () => {
    const res = await handleProxy(req(), deps({ resolve: async () => ({ ok: false }) }));
    expect(res.status).toBe(403);
    expect((await res.json()).proxyError).toBe("dns");
    const threw = await handleProxy(
      req(),
      deps({ resolve: async () => Promise.reject(new Error("x")) }),
    );
    expect(threw.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("follows a same-host 307 after re-resolving, and refuses a redirect to a private address", async () => {
    const resolved: string[] = [];
    let n = 0;
    const res = await handleProxy(
      req(),
      deps({ resolve: async (h) => (resolved.push(h), { ok: true }) }, () =>
        n++ === 0
          ? new Response(null, { status: 307, headers: { location: "/v1/chat/completions" } })
          : okJson(),
      ),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(resolved).toEqual(["api.openai.com", "api.openai.com"]);

    for (const location of [
      "http://169.254.169.254/latest/meta-data/iam/",
      "https://[fd00:ec2::254]/v1/chat/completions",
      "https://10.0.0.1/v1/chat/completions",
      "https://evil.example/v1/chat/completions",
    ]) {
      calls = [];
      const r = await handleProxy(
        req(),
        deps({}, () => new Response(null, { status: 307, headers: { location } })),
      );
      expect(r.status).toBe(502);
      expect((await r.json()).proxyError).toBe("redirect");
      expect(calls).toHaveLength(1);
    }
    calls = [];
    const loop = await handleProxy(
      req(),
      deps(
        {},
        () => new Response(null, { status: 308, headers: { location: "/v1/chat/completions" } }),
      ),
    );
    expect(loop.status).toBe(502);
    expect(calls).toHaveLength(PROXY_LIMITS.maxHops + 1);
  });

  it("never echoes the provider's error text (it can contain the key)", async () => {
    const echo = () =>
      new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const res = await handleProxy(req(), deps({}, echo));
    expect(res.status).toBe(502);
    const t = await res.text();
    expect(t).not.toContain(KEY);
    expect(JSON.parse(t)).toEqual({ proxyError: "auth", status: 401 });
    const r500 = await handleProxy(
      req(),
      deps({}, () => new Response(`boom ${KEY}`, { status: 500 })),
    );
    expect(await r500.text()).not.toContain(KEY);
  });

  it("caps the answer: declared length, streamed length, and only JSON", async () => {
    const declared = await handleProxy(
      req(),
      deps(
        {},
        () =>
          new Response("{}", {
            headers: {
              "content-type": "application/json",
              "content-length": String(PROXY_LIMITS.maxResponseBytes + 1),
            },
          }),
      ),
    );
    expect(declared.status).toBe(502);
    const streamed = await handleProxy(
      req(),
      deps(
        {},
        () =>
          new Response(
            new ReadableStream({
              start(c) {
                const chunk = new Uint8Array(256 * 1024).fill(32);
                for (let i = 0; i < 5; i++) c.enqueue(chunk);
                c.close();
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );
    expect(streamed.status).toBe(200);
    let failed = false;
    try {
      await streamed.arrayBuffer();
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    const html = await handleProxy(
      req(),
      deps({}, () => new Response("<html>", { headers: { "content-type": "text/html" } })),
    );
    expect(html.status).toBe(502);
    expect((await html.json()).proxyError).toBe("type");
  });

  it("times out", async () => {
    const res = await handleProxy(
      req(),
      deps({ timeoutMs: 20 }, (c) => {
        throw new Error(c.init.signal?.aborted ? "aborted" : "x");
      }),
    );
    expect([504]).toContain(res.status);
    const slow = await handleProxy(req(), {
      ...deps({ timeoutMs: 20 }),
      fetch: (_u, init) =>
        new Promise((_, rej) =>
          init.signal?.addEventListener("abort", () => rej(new Error("abort"))),
        ),
    });
    expect(slow.status).toBe(504);
    expect((await slow.json()).proxyError).toBe("timeout");
  });

  it("rate-limits per IP, per user and globally — counters hold no key, text or URL", async () => {
    await handleProxy(req(), deps());
    expect(hits.sort()).toEqual([
      "byok-proxy:global",
      "byok-proxy:ip:198.51.100.7",
      "byok-proxy:user:user-1",
    ]);
    hits = [];
    await handleProxy(req(), deps({ userId: null, ip: "unknown" }));
    expect(hits).toEqual(["byok-proxy:global"]);

    // The real in-memory counter (the D1 one has its own tests): IP limit reached → 429.
    const ip = `203.0.113.${Math.floor(Math.random() * 200)}-${crypto.randomUUID()}`;
    const mem = deps({
      ip,
      userId: null,
      hit: async (key, limit) => checkRateLimit(key.replace("global", `global-${ip}`), limit),
    });
    let last: Response | null = null;
    for (let i = 0; i <= PROXY_RATE.ip.max; i++) last = await handleProxy(req(), mem);
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(calls).toHaveLength(PROXY_RATE.ip.max + 2);

    // A refused or failing counter refuses the call (fails closed).
    calls = [];
    const down = await handleProxy(
      req(),
      deps({
        hit: async () => {
          throw new Error("d1");
        },
      }),
    );
    expect(down.status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it("writes nothing anywhere: no cache API, no storage, only the counters", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const prev = g.caches;
    const touched: string[] = [];
    g.caches = new Proxy(
      {},
      { get: (_t, p) => (touched.push(String(p)), () => Promise.resolve(undefined)) },
    );
    try {
      await handleProxy(req(), deps());
    } finally {
      g.caches = prev;
    }
    expect(touched).toEqual([]);
    expect(hits.join(" ")).not.toContain(KEY);
  });
});

// ── The client side ───────────────────────────────────────────────────────

describe("client: 经 Lianki 转发", () => {
  const active = (relay: boolean): ByokActive => ({
    backend: {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      ...(relay ? { relay } : {}),
    },
    apiKey: KEY,
    preset: openai,
  });

  it("goes to /api/byok/proxy with the key in Authorization only", async () => {
    const seen: Call[] = [];
    const r = await byokComplete(
      active(true),
      [{ role: "user", content: "x" }],
      { maxTokens: 8 },
      {
        fetch: (async (url: string, init: RequestInit) => {
          seen.push({ url, init });
          return okJson();
        }) as unknown as typeof fetch,
        pageHost: "lianki.com",
      },
    );
    expect(r).toEqual({ ok: true, text: "Bonjour" });
    expect(seen[0].url).toBe("/api/byok/proxy");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(String(seen[0].init.body)).not.toContain(KEY);
    expect(parseInput(JSON.parse(String(seen[0].init.body)))).not.toBeNull();
  });

  it("maps the relay's errors", async () => {
    const answer = (status: number, v: unknown) =>
      (async () => new Response(JSON.stringify(v), { status })) as unknown as typeof fetch;
    const run = (f: typeof fetch) =>
      byokComplete(active(true), [{ role: "user", content: "x" }], { maxTokens: 8 }, { fetch: f });
    expect(await run(answer(429, { proxyError: "rate" }))).toEqual({ ok: false, kind: "rate" });
    expect(await run(answer(403, { proxyError: "host" }))).toEqual({
      ok: false,
      kind: "relay-refused",
    });
    expect(await run(answer(502, { proxyError: "auth", status: 401 }))).toEqual({
      ok: false,
      kind: "auth",
      status: 401,
    });
    expect(await run(answer(413, { proxyError: "too-large" }))).toEqual({
      ok: false,
      kind: "too-large",
    });
  });

  it("maps the relay's other answers, a network error and its own timeout", async () => {
    const answer = (status: number, v: unknown) =>
      (async () =>
        new Response(typeof v === "string" ? v : JSON.stringify(v), {
          status,
        })) as unknown as typeof fetch;
    const run = (f: typeof fetch, timeoutMs?: number) =>
      byokComplete(
        active(true),
        [{ role: "user", content: "x" }],
        { maxTokens: 8 },
        { fetch: f, timeoutMs },
      );
    expect(await run(answer(502, { proxyError: "http", status: 500 }))).toEqual({
      ok: false,
      kind: "http",
      status: 500,
    });
    expect(await run(answer(504, { proxyError: "timeout" }))).toEqual({
      ok: false,
      kind: "timeout",
    });
    expect(await run(answer(504, { proxyError: "network" }))).toEqual({ ok: false, kind: "cors" });
    expect(await run(answer(502, { proxyError: "type" }))).toEqual({ ok: false, kind: "empty" });
    expect(await run(answer(500, "<html>"))).toEqual({ ok: false, kind: "http", status: 500 });
    expect(await run(answer(200, "<html>"))).toEqual({ ok: false, kind: "empty" });
    expect(await run(answer(200, { choices: [] }))).toEqual({ ok: false, kind: "empty" });
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await run(down)).toEqual({ ok: false, kind: "cors" });
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_, rej) =>
        init.signal?.addEventListener("abort", () => rej(new Error("abort"))),
      )) as unknown as typeof fetch;
    expect(await run(hang, 10)).toEqual({ ok: false, kind: "timeout" });
  });

  it("offers relaying only for allowlisted presets at their standard address", () => {
    expect(
      cleanBackend({
        provider: "custom",
        baseUrl: "https://my.example.com/v1",
        model: "m",
        relay: true,
      }),
    ).toEqual({
      provider: "custom",
      baseUrl: "https://my.example.com/v1",
      model: "m",
    });
    expect(
      cleanBackend({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "m",
        relay: true,
      })?.relay,
    ).toBe(true);
    expect(
      gapOf(
        { provider: "openai", baseUrl: "https://proxy.example.com/v1", model: "m", relay: true },
        KEY,
      ),
    ).toBe("relay");
    expect(
      gapOf(
        { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "m", relay: true },
        KEY,
      ),
    ).toBeNull();
  });
});

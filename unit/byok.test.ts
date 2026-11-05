import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BYOK_PRESETS, presetOf } from "@/lib/byok/presets";
import {
  BYOK_ACK_KEY,
  BYOK_BACKEND_KEY,
  BYOK_KEY,
  BYOK_NOTICE_VERSION,
  MODEL_RE,
  activeByok,
  checkBaseUrl,
  cleanBackend,
  emptyDevice,
  hasAck,
  loadDevice,
  removeDevice,
  saveAck,
  saveDevice,
  saveSyncedBackend,
  withEnabled,
  type ByokActive,
} from "@/lib/byok/config";
import { byokComplete, byokRequest, testByok } from "@/lib/byok/call";
import { prefBindings } from "@/lib/prefs/bindings";
import { checkPref, PREF_KEYS } from "@/lib/prefs/schema";
import { fetchPiece } from "@/app/(app)/read/[id]/use-select-translate";
import { fetchGloss } from "@/app/(app)/read/[id]/use-select-gloss";

/** docs/byok.md: the user's own AI, browser-only; the key never leaves the device. */
const SECRET = "sk-test-SECRET-never-leaves-0000";
const g = globalThis as unknown as Record<string, unknown>;
let m: Map<string, string>;
const store = () => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
});
const realFetch = globalThis.fetch;

beforeEach(() => {
  m = new Map();
  g.localStorage = store();
});
afterEach(() => {
  delete g.localStorage;
  globalThis.fetch = realFetch;
});

const active = (provider = "openai", baseUrl?: string): ByokActive => {
  const p = presetOf(provider)!;
  return {
    backend: { provider: p.id, baseUrl: baseUrl ?? p.baseUrl, model: p.model || "m" },
    apiKey: SECRET,
    preset: p,
  };
};

type Call = { url: string; init: RequestInit };
/** A fetch that records every call; our API and the provider answer as given. */
function recorder(answer: (url: string) => unknown) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    return new Response(JSON.stringify(answer(u)), { status: 200 });
  }) as typeof fetch;
  return { calls, f };
}
const ours = (url: string) => url.startsWith("/") || /lianki\.com/.test(url);
const carries = (c: Call) =>
  `${c.url} ${JSON.stringify(c.init.headers ?? {})} ${String(c.init.body ?? "")}`;

describe("presets", () => {
  it("are valid data: unique ids, usable URLs and models, a browser verdict each", () => {
    const ids = BYOK_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const want of [
      "openai",
      "anthropic",
      "deepseek",
      "gemini",
      "openrouter",
      "ollama",
      "custom",
    ])
      expect(ids).toContain(want);
    for (const p of BYOK_PRESETS) {
      expect(typeof p.browser).toBe("boolean");
      expect(["openai", "anthropic"]).toContain(p.protocol);
      if (p.id === "custom") continue;
      expect(checkBaseUrl(p.baseUrl).ok).toBe(true);
      expect(MODEL_RE.test(p.model)).toBe(true);
      if (!p.keyless) expect(p.baseUrl.startsWith("https://")).toBe(true);
      if (p.policyUrl) expect(p.policyUrl.startsWith("https://")).toBe(true);
    }
    expect(presetOf("anthropic")!.protocol).toBe("anthropic");
    expect(presetOf("ollama")!.keyless).toBe(true);
  });
});

describe("custom URL rules", () => {
  it("takes https anywhere and http only on this computer", () => {
    expect(checkBaseUrl("https://api.example.com/v1/")).toEqual({
      ok: true,
      url: "https://api.example.com/v1",
    });
    expect(checkBaseUrl("http://localhost:11434/v1").ok).toBe(true);
    expect(checkBaseUrl("http://127.0.0.1:8080").ok).toBe(true);
    expect(checkBaseUrl("http://[::1]:8080/v1").ok).toBe(true);
  });
  it("refuses everything else", () => {
    for (const bad of [
      "http://api.example.com/v1",
      "http://192.168.1.2:11434",
      "ftp://x.example",
      "javascript:alert(1)",
      "data:text/plain,x",
      "not a url",
      "",
      // A user:password part, built so no literal looks like a credential.
      ["https://user", "x@api.example.com"].join(":"),
      "https://api.example.com/v1?key=1",
      "https://api.example.com/v1#x",
    ])
      expect(checkBaseUrl(bad).ok).toBe(false);
  });
  it("never Lianki's own hosts or the page's own origin", () => {
    for (const host of [
      "https://lianki.com/api",
      "https://www.lianki.com",
      "https://dev.LIANKI.com/v1",
    ])
      expect(checkBaseUrl(host)).toEqual({ ok: false, error: "ours" });
    expect(checkBaseUrl("https://preview.example.dev/v1", "preview.example.dev")).toEqual({
      ok: false,
      error: "ours",
    });
  });
});

describe("the privacy notice gates the switch", () => {
  it("cannot turn on without the acknowledgement", () => {
    const d = emptyDevice();
    expect(withEnabled(d, true, false)).toEqual({ ok: false, reason: "ack" });
    expect(withEnabled(d, false, false).ok).toBe(true);
    const r = withEnabled(d, true, true);
    expect(r.ok && r.device.enabled).toBe(true);
  });
  it("is kept per notice version: a changed notice asks again", () => {
    expect(hasAck()).toBe(false);
    saveAck();
    expect(hasAck()).toBe(true);
    expect(hasAck(undefined, BYOK_NOTICE_VERSION + 1)).toBe(false);
    expect(JSON.parse(m.get(BYOK_ACK_KEY)!).v).toBe(BYOK_NOTICE_VERSION);
  });
  it("a record switched on by hand is not used until the notice is acknowledged", () => {
    saveDevice({ ...emptyDevice(), enabled: true, apiKey: SECRET });
    expect(activeByok(undefined, "lianki.com")).toBeNull();
    saveAck();
    expect(activeByok(undefined, "lianki.com")?.apiKey).toBe(SECRET);
  });
});

describe("storage", () => {
  it("the key lives in lk:byok only, and remove deletes it", () => {
    saveDevice({ ...emptyDevice(), apiKey: SECRET });
    expect(loadDevice()?.apiKey).toBe(SECRET);
    for (const [k, v] of m) if (k !== BYOK_KEY) expect(v).not.toContain(SECRET);
    removeDevice();
    expect(m.has(BYOK_KEY)).toBe(false);
    expect([...m.values()].join()).not.toContain(SECRET);
  });
  it("the synced backend never holds the key, and wins over the device's", () => {
    saveAck();
    saveDevice({ ...emptyDevice("openai"), enabled: true, apiKey: SECRET });
    saveSyncedBackend({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    });
    expect(m.get(BYOK_BACKEND_KEY)).not.toContain(SECRET);
    expect(activeByok(undefined, "lianki.com")?.backend.provider).toBe("deepseek");
    saveSyncedBackend(null);
    expect(activeByok(undefined, "lianki.com")?.backend.provider).toBe("openai");
  });
  it("an incomplete record is not used", () => {
    saveAck();
    saveDevice({ ...emptyDevice("openai"), enabled: true, apiKey: "" });
    expect(activeByok(undefined, "lianki.com")).toBeNull();
    saveDevice({ ...emptyDevice("ollama"), enabled: true, apiKey: "" });
    expect(activeByok(undefined, "lianki.com")?.preset.id).toBe("ollama");
  });
});

describe("prefs sync", () => {
  it("excludes lk:byok: no binding ever reads the key", () => {
    saveDevice({ ...emptyDevice(), enabled: true, apiKey: SECRET });
    saveAck();
    for (const b of prefBindings()) expect(JSON.stringify(b.get() ?? null)).not.toContain(SECRET);
    for (const k of PREF_KEYS) expect(k).not.toMatch(/key|secret|token/i);
  });
  it("byok.backend takes the backend exactly, never a key", () => {
    const b = { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };
    expect(checkPref("byok.backend", b)).toEqual(b);
    expect(checkPref("byok.backend", null)).toBeNull();
    expect(checkPref("byok.backend", { ...b, apiKey: SECRET })).toBeUndefined();
    expect(checkPref("byok.backend", { ...b, baseUrl: "http://example.com/v1" })).toBeUndefined();
    expect(checkPref("byok.backend", { ...b, baseUrl: "https://lianki.com/api" })).toBeUndefined();
    expect(checkPref("byok.backend", { ...b, provider: "nope" })).toBeUndefined();
    expect(
      checkPref("byok.backend", { ...b, baseUrl: "https://api.openai.com/v1/" }),
    ).toBeUndefined();
    expect(cleanBackend({ ...b, apiKey: SECRET })).toEqual(b);
  });
});

describe("the call", () => {
  it("anthropic: its browser header, x-api-key, no cookies, no referrer", () => {
    const r = byokRequest(active("anthropic"), [{ role: "user", content: "hi" }], {
      maxTokens: 5,
    })!;
    expect(r.url).toBe("https://api.anthropic.com/v1/messages");
    const h = r.init.headers as Record<string, string>;
    expect(h["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(h["x-api-key"]).toBe(SECRET);
    expect(r.init.credentials).toBe("omit");
    expect(r.init.referrerPolicy).toBe("no-referrer");
  });
  it("openai-compatible: bearer to <base>/chat/completions", () => {
    const r = byokRequest(active("gemini"), [{ role: "user", content: "hi" }], { maxTokens: 5 })!;
    expect(r.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect((r.init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
  });
  it("is never made to our origin, whatever the record says", async () => {
    const { calls, f } = recorder(() => ({}));
    for (const url of [
      "https://lianki.com/v1",
      "https://app.example.dev/v1",
      "http://evil.example",
    ]) {
      const r = await byokComplete(
        active("custom", url),
        [],
        { maxTokens: 1 },
        {
          fetch: f,
          pageHost: "app.example.dev",
        },
      );
      expect(r).toEqual({ ok: false, kind: "bad-url" });
    }
    expect(calls.length).toBe(0);
  });
  it("an error never carries the provider's message (it can echo the key)", async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({ error: { message: `Incorrect API key provided: ${SECRET}` } }),
        {
          status: 401,
        },
      )) as unknown as typeof fetch;
    const r = await testByok(active(), { fetch: f, pageHost: "lianki.com" });
    expect(r).toEqual({ ok: false, kind: "auth", status: 401 });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
  it("explains a network error by where it went", async () => {
    const f = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const d = { fetch: f, pageHost: "lianki.com" };
    expect(await testByok(active("ollama"), d)).toEqual({ ok: false, kind: "local" });
    expect(await testByok(active("openai"), d)).toEqual({ ok: false, kind: "opaque-auth" });
    expect(await testByok(active("deepseek"), d)).toEqual({ ok: false, kind: "cors" });
  });
});

describe("the reader with the user's own AI", () => {
  const on = () => {
    saveAck();
    saveDevice({ ...emptyDevice("openai"), enabled: true, apiKey: SECRET });
    return activeByok(undefined, "lianki.com")!;
  };

  it("translation goes to the provider only: our API (and its shared cache) is never called", async () => {
    const { calls, f } = recorder((u) =>
      ours(u) ? { text: "server" } : { choices: [{ message: { content: "« Bonjour »" } }] },
    );
    globalThis.fetch = f;
    const out = await fetchPiece("book1", "fr", "en", "Hello there, own path.", on());
    expect(out).toBe("« Bonjour »");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls.some((c) => ours(c.url))).toBe(false);
  });

  it("off: the translation asks our API, and nothing it sends holds the key", async () => {
    saveDevice({ ...emptyDevice("openai"), enabled: false, apiKey: SECRET });
    const { calls, f } = recorder(() => ({ text: "Bonjour" }));
    globalThis.fetch = f;
    const out = await fetchPiece("book1", "fr", "en", "Hello there, server path.", null);
    expect(out).toBe("Bonjour");
    expect(calls[0].url).toBe("/api/read/book1/translate");
    for (const c of calls) expect(carries(c)).not.toContain(SECRET);
  });

  it("gloss: our route is asked without a model (own: true), the provider for the rest; the key only to the provider", async () => {
    const { calls, f } = recorder((u) =>
      ours(u)
        ? { term: "fauve", back: null, ask: { lang: "fr", term: "fauve" } }
        : { choices: [{ message: { content: '{"fauve":"wild beast"}' } }] },
    );
    const g1 = await fetchGloss("book1", "fauve", "un fauve", on(), {
      fetch: f,
      pageHost: "lianki.com",
    });
    expect(g1).toEqual({ term: "fauve", back: "wild beast", own: true });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/read/book1/gloss",
      "https://api.openai.com/v1/chat/completions",
    ]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      w: "fauve",
      ex: "un fauve",
      own: true,
    });
    for (const c of calls.filter((c) => ours(c.url))) expect(carries(c)).not.toContain(SECRET);
    expect(carries(calls[1])).toContain(SECRET);
  });
});

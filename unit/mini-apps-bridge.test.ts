/**
 * The host side of the mini-app protocol (lib/mini-apps/bridge.ts;
 * docs/mini-apps.md, "The SDK"), and the SDK itself (public/m/sdk.js) run
 * against a fake parent window.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  PROTOCOL,
  createBridge,
  fromFrame,
  parseRequest,
  replyTarget,
  themeEvent,
  type BridgeDeps,
} from "../lib/mini-apps/bridge";
import type { CapabilityId } from "../lib/mini-apps/capabilities";
import type { Choice, Grants } from "../lib/mini-apps/grants";

const req = (id: number, method: string, args: Record<string, unknown> = {}) => ({
  id,
  method,
  args,
});

function setup(
  o: { grants?: Grants; choices?: (Choice | null)[]; status?: number; body?: unknown } = {},
) {
  const prompts: CapabilityId[] = [];
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const seen: Grants[] = [];
  let stored: Grants = { ...o.grants };
  const choices = [...(o.choices ?? [])];
  const deps: BridgeDeps = {
    manifest: {
      slug: "calc",
      name: "Calc",
      icon: "🧮",
      version: "1.0.0",
      permissions: ["storage", "chat:write"],
    },
    grants: () => stored,
    prompt: async (cap) => {
      prompts.push(cap);
      return choices.shift() ?? null;
    },
    decide: async (cap, choice) => {
      stored = {
        ...stored,
        [cap]: choice === "app" ? "allow" : choice === "deny" ? "deny" : "once",
      };
      return stored;
    },
    call: async (method, args) => {
      calls.push({ method, args });
      return { status: o.status ?? 200, body: o.body ?? { value: 42 } };
    },
    onGrants: (g) => seen.push(g),
  };
  return { bridge: createBridge(deps), prompts, calls, seen };
}

describe("messages", () => {
  test("only well-formed requests are taken", () => {
    expect(
      parseRequest({ lk: PROTOCOL, id: 1, method: "storage.get", args: { key: "a" } }),
    ).toEqual(req(1, "storage.get", { key: "a" }));
    expect(parseRequest({ lk: PROTOCOL, id: 2, method: "manifest" })).toEqual(req(2, "manifest"));
    for (const bad of [
      null,
      "x",
      { lk: "other", id: 1, method: "m" },
      { lk: PROTOCOL, id: -1, method: "m" },
      { lk: PROTOCOL, id: 1.5, method: "m" },
      { lk: PROTOCOL, id: 1, method: 3 },
      { lk: PROTOCOL, id: 1, method: "m".repeat(41) },
      { lk: PROTOCOL, id: 1, method: "m", args: [1] },
      { lk: PROTOCOL, id: 1, method: "m", args: null },
    ])
      expect(parseRequest(bad)).toBeNull();
  });

  test("only from our own frame's window and the app's origin", () => {
    const win = {};
    expect(fromFrame({ source: win, origin: "null" }, win, "null")).toBe(true);
    expect(fromFrame({ source: {}, origin: "null" }, win, "null")).toBe(false);
    expect(fromFrame({ source: win, origin: "https://evil.com" }, win, "null")).toBe(false);
    expect(fromFrame({ source: null, origin: "null" }, null, "null")).toBe(false);
    expect(
      fromFrame({ source: win, origin: "https://m.lianki.com" }, win, "https://m.lianki.com"),
    ).toBe(true);
    expect(replyTarget("null")).toBe("*");
    expect(replyTarget("https://m.lianki.com")).toBe("https://m.lianki.com");
  });
});

describe("the bridge", () => {
  test("manifest: the app's own declaration and where each capability stands", async () => {
    const { bridge } = setup({ grants: { storage: "allow" } });
    const r = await bridge.handle(req(1, "manifest"));
    expect(r).toEqual({
      lk: PROTOCOL,
      id: 1,
      ok: true,
      result: {
        slug: "calc",
        name: "Calc",
        icon: "🧮",
        version: "1.0.0",
        permissions: ["storage", "chat:write"],
        grants: { storage: "granted", "chat:write": "prompt" },
      },
    });
  });

  test("first use prompts; 'for this app' is remembered, no second prompt", async () => {
    const { bridge, prompts, calls, seen } = setup({ choices: ["app"] });
    const a = await bridge.handle(req(1, "storage.get", { key: "k" }));
    expect(a).toEqual({ lk: PROTOCOL, id: 1, ok: true, result: { value: 42 } });
    await bridge.handle(req(2, "storage.set", { key: "k", value: 1 }));
    expect(prompts).toEqual(["storage"]);
    expect(calls.map((c) => c.method)).toEqual(["storage.get", "storage.set"]);
    expect(seen.at(-1)).toEqual({ storage: "allow" });
    expect(bridge.grants()).toEqual({ storage: "allow" });
  });

  test("concurrent calls share one prompt", async () => {
    const { bridge, prompts } = setup({ choices: ["app"] });
    const [a, b] = await Promise.all([
      bridge.handle(req(1, "storage.get")),
      bridge.handle(req(2, "storage.get")),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(prompts).toEqual(["storage"]);
  });

  test("'this time' covers one call; the next asks again", async () => {
    const { bridge, prompts } = setup({ choices: ["once", "deny"] });
    expect((await bridge.handle(req(1, "chat.say", { text: "hi" }))).ok).toBe(true);
    expect(bridge.grants()).toEqual({});
    const r = await bridge.handle(req(2, "chat.say", { text: "hi" }));
    expect(r).toEqual({
      lk: PROTOCOL,
      id: 2,
      ok: false,
      error: "permission-denied",
      permission: "chat:write",
    });
    expect(prompts).toEqual(["chat:write", "chat:write"]);
    // Denied is remembered: no third prompt.
    await bridge.handle(req(3, "chat.say", { text: "hi" }));
    expect(prompts.length).toBe(2);
  });

  test("dismissed: this call fails, the next asks again", async () => {
    const { bridge, prompts } = setup({ choices: [null, "app"] });
    expect((await bridge.handle(req(1, "storage.list"))).ok).toBe(false);
    expect((await bridge.handle(req(2, "storage.list"))).ok).toBe(true);
    expect(prompts).toEqual(["storage", "storage"]);
  });

  test("request(permission) asks up front and says where it stands", async () => {
    const { bridge, calls } = setup({ choices: ["app", null] });
    expect(await bridge.handle(req(1, "request", { permission: "storage" }))).toMatchObject({
      ok: true,
      result: "granted",
    });
    expect(await bridge.handle(req(2, "request", { permission: "chat:write" }))).toMatchObject({
      ok: true,
      result: "prompt",
    });
    expect(await bridge.handle(req(3, "request", { permission: "prefs:read" }))).toMatchObject({
      ok: true,
      result: "undeclared",
    });
    expect(await bridge.handle(req(4, "request", { permission: "eval" }))).toMatchObject({
      ok: false,
      error: "unknown-permission",
    });
    expect(calls).toEqual([]);
  });

  test("undeclared and unknown methods never prompt or call", async () => {
    const { bridge, prompts, calls } = setup();
    expect(await bridge.handle(req(1, "prefs.get"))).toEqual({
      lk: PROTOCOL,
      id: 1,
      ok: false,
      error: "permission-undeclared",
      permission: "prefs:read",
    });
    expect(await bridge.handle(req(2, "eval"))).toMatchObject({
      ok: false,
      error: "unknown-method",
    });
    expect(prompts).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a server refusal is passed on as its code; a throw as 'failed'", async () => {
    const { bridge } = setup({
      grants: { storage: "allow" },
      status: 413,
      body: { error: "storage-full" },
    });
    expect(await bridge.handle(req(1, "storage.set"))).toMatchObject({
      ok: false,
      error: "storage-full",
    });
    const odd = setup({ grants: { storage: "allow" }, status: 500, body: null });
    expect(await odd.bridge.handle(req(2, "storage.set"))).toMatchObject({
      ok: false,
      error: "failed",
    });
    const throws = createBridge({
      ...setupDeps(),
      call: async () => {
        throw new Error("network");
      },
    });
    expect(await throws.handle(req(3, "storage.get"))).toMatchObject({
      ok: false,
      error: "failed",
    });
  });
});

function setupDeps(): BridgeDeps {
  return {
    manifest: { slug: "a", name: "A", icon: "A", version: "1.0.0", permissions: ["storage"] },
    grants: () => ({ storage: "allow" }),
    prompt: async () => null,
    decide: async () => ({}),
    call: async () => ({ status: 200, body: {} }),
  };
}

describe("the SDK (public/m/sdk.js)", () => {
  const src = readFileSync(new URL("../public/m/sdk.js", import.meta.url), "utf8");

  /** Run the SDK in a fake window whose parent answers through `answer`. */
  function sdk(
    answer: (m: { id: number; method: string; args: Record<string, unknown> }) => unknown,
  ) {
    const listeners: ((e: { source: unknown; data: unknown }) => void)[] = [];
    const parent = {
      postMessage(m: { id: number; method: string; args: Record<string, unknown> }) {
        const reply = answer(m);
        queueMicrotask(() => {
          // A message from elsewhere first: ignored.
          for (const l of listeners) l({ source: {}, data: reply });
          for (const l of listeners) l({ source: parent, data: reply });
        });
      },
    };
    const win: Record<string, unknown> = {
      parent,
      addEventListener: (_t: string, l: (typeof listeners)[number]) => listeners.push(l),
    };
    new Function("window", src)(win);
    new Function("window", src)(win); // loaded twice: the first stays
    return win.lianki as {
      version: string;
      manifest(): Promise<unknown>;
      request(p: string): Promise<string>;
      storage: {
        get(k: string): Promise<unknown>;
        set(k: string, v?: unknown): Promise<void>;
        list(p?: string): Promise<unknown>;
      };
      prefs: { get(k?: string[]): Promise<unknown>; set(k: string, v: unknown): Promise<void> };
      chat: { read(n?: number): Promise<unknown>; say(t: unknown): Promise<unknown> };
      ui: { card(c?: unknown): Promise<unknown> };
    };
  }

  test("each method posts one request and resolves with its part of the reply", async () => {
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    const lk = sdk((m) => {
      sent.push({ method: m.method, args: m.args });
      const result =
        m.method === "storage.get"
          ? { value: 7 }
          : m.method === "prefs.get"
            ? { prefs: { "ui.paper": "b" } }
            : m.method === "chat.read"
              ? { lines: [] }
              : m.method === "chat.say"
                ? { id: "l1" }
                : m.method === "ui.card"
                  ? { choice: "Yes" }
                  : m.method === "request"
                    ? "granted"
                    : { ok: true };
      return { lk: PROTOCOL, id: m.id, ok: true, result };
    });
    expect(lk.version).toBe(PROTOCOL);
    expect(await lk.storage.get("a")).toBe(7);
    expect(await lk.storage.set("a")).toBeUndefined();
    expect(await lk.storage.list()).toEqual({ ok: true });
    expect(await lk.prefs.get(["ui.paper"])).toEqual({ "ui.paper": "b" });
    expect(await lk.prefs.get()).toEqual({ "ui.paper": "b" });
    expect(await lk.prefs.set("ui.paper", "a")).toBeUndefined();
    expect(await lk.chat.read()).toEqual([]);
    expect(await lk.chat.say(42)).toBe("l1");
    expect(await lk.ui.card({ title: "T", options: ["Yes"] })).toBe("Yes");
    expect(await lk.ui.card()).toBe("Yes");
    expect(await lk.request("storage")).toBe("granted");
    expect(await lk.manifest()).toEqual({ ok: true });
    expect(sent.map((s) => s.method)).toEqual([
      "storage.get",
      "storage.set",
      "storage.list",
      "prefs.get",
      "prefs.get",
      "prefs.set",
      "chat.read",
      "chat.say",
      "ui.card",
      "ui.card",
      "request",
      "manifest",
    ]);
    expect(sent[1]!.args).toEqual({ key: "a", value: null });
    expect(sent[7]!.args).toEqual({ text: "42" });
  });

  test("a refusal rejects with its code and permission", async () => {
    const lk = sdk((m) => ({
      lk: PROTOCOL,
      id: m.id,
      ok: false,
      error: "permission-denied",
      permission: "storage",
    }));
    const err = (await lk.storage.get("a").catch((e) => e)) as Error & {
      code: string;
      permission: string;
    };
    expect(err.code).toBe("permission-denied");
    expect(err.permission).toBe("storage");
    const bare = sdk((m) => ({ lk: PROTOCOL, id: m.id, ok: false }));
    expect(((await bare.storage.get("a").catch((e) => e)) as { code: string }).code).toBe("failed");
    const junk = sdk(() => null);
    const pending = Promise.race([
      junk.storage.get("a"),
      new Promise((r) => setTimeout(() => r("open"), 20)),
    ]);
    expect(await pending).toBe("open");
  });

  test("the host's theme sets <html data-theme>; anything else is left alone", () => {
    const attrs: Record<string, string> = {};
    const listeners: ((e: { source: unknown; data: unknown }) => void)[] = [];
    const parent = { postMessage() {} };
    const win: Record<string, unknown> = {
      parent,
      addEventListener: (_t: string, l: (typeof listeners)[number]) => listeners.push(l),
    };
    const doc = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
    new Function("window", "document", src)(win, doc);
    for (const l of listeners) l({ source: parent, data: themeEvent("dark") });
    expect(attrs["data-theme"]).toBe("dark");
    for (const l of listeners)
      l({ source: parent, data: { lk: PROTOCOL, event: "theme", theme: "pink" } });
    for (const l of listeners) l({ source: {}, data: themeEvent("light") });
    expect(attrs["data-theme"]).toBe("dark");
  });
});

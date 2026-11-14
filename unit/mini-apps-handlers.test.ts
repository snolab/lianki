/**
 * Mini apps' routes (lib/mini-apps/handlers.ts; docs/mini-apps.md) over the
 * test D1 (node:sqlite, the real migrations) and an in-memory R2: the flag
 * and account gates, publishing, the grant flow and each capability, the
 * frame (srcdoc and its own origin), the ticketed file, delete; and the chat
 * port over a fake lianki-push.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import {
  act,
  appInfo,
  appPrefKeys,
  hostView,
  listMine,
  publish,
  removeApp,
  serveApp,
  type MiniBucket,
  type MiniConfig,
  type MiniDeps,
  type MiniWho,
} from "../lib/mini-apps/handlers";
import { kvGet, kvList, kvSet, upsertApp, type MiniDb } from "../lib/mini-apps/store";
import {
  type ChatPort,
  type PortSocket,
  laneOfApp,
  parseCard,
  pushChatPort,
  waitForTap,
} from "../lib/mini-apps/chat";
import { createMiniDeps } from "../lib/mini-apps/deps";
import { CONFIG } from "../lib/config";
import { signTicket } from "../lib/mini-apps/ticket";

const mig = (f: string) => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), "utf8");
const SCHEMA = [
  "CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT);",
  "CREATE TABLE api_tokens (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, user_id TEXT, scopes TEXT, expires_at TEXT, last_used_at TEXT);",
  mig("0020_user_prefs.sql"),
  mig("0057_chat_line.sql"),
  mig("0078_mini_apps.sql"),
].join("\n");

const DEV: MiniWho = { id: "u1", email: "dev@example.com", dev: true };
const USER: MiniWho = { id: "u2", email: "user@example.com", dev: false };
const T0 = 1_800_000_000_000;
const SECRET = "x".repeat(40);
const HTML = `<!doctype html><html><head><link rel="stylesheet" href="/m/presets/lianki.css"></head><body><script>1</script></body></html>`;
const MANIFEST = {
  slug: "calc",
  name: "Calc",
  icon: "🧮",
  version: "0.1.0",
  permissions: ["storage", "prefs:read", "prefs:write", "chat:read", "chat:write", "chat:ask"],
};

const config = (over: Partial<MiniConfig> = {}): MiniConfig => ({
  maxBytes: 4096,
  storageBytes: 64,
  perAccount: 2,
  callsPerMinute: 100,
  cardWaitMs: 1000,
  origin: "",
  scripts: CONFIG["miniApps.scriptOrigins"].default,
  styles: CONFIG["miniApps.styleOrigins"].default,
  fonts: CONFIG["miniApps.fontOrigins"].default,
  prefKeys: CONFIG["miniApps.prefKeys"].default,
  ...over,
});

function memBucket() {
  const store = new Map<string, string>();
  const b: MiniBucket & { store: typeof store } = {
    store,
    async put(k, v) {
      store.set(k, v);
    },
    async get(k) {
      const v = store.get(k);
      return v === undefined ? null : { text: async () => v };
    },
    async delete(k) {
      for (const x of Array.isArray(k) ? k : [k]) store.delete(x);
    },
  };
  return b;
}

let db: MiniDb;
let bucket: ReturnType<typeof memBucket>;
let who: MiniWho | null;
let on: boolean;
let cfg: MiniConfig;
let chat: ChatPort;
let chatLog: string[];
let deps: MiniDeps;
beforeEach(() => {
  const d = createTestD1(SCHEMA);
  d.raw().exec(
    "INSERT INTO user (id, email) VALUES ('u1', 'dev@example.com'), ('u2', 'user@example.com')",
  );
  db = d as unknown as MiniDb;
  bucket = memBucket();
  who = DEV;
  on = true;
  cfg = config();
  chatLog = [];
  chat = {
    read: async (_u, limit) => [
      { id: "l1", from: "owner", lane: null, text: `hi ${limit}`, at: 1 },
    ],
    say: async (_u, lane, text) => (chatLog.push(`${lane}:${text}`), { id: "l2" }),
    card: async (_u, lane, ask) => (
      chatLog.push(`${lane}?${ask.title}`), { choice: ask.options[0]! }
    ),
  };
  deps = {
    who: async () => who,
    on: async () => on,
    db: () => db,
    bucket: () => bucket,
    config: async () => cfg,
    chat: () => chat,
    secret: () => SECRET,
    now: () => T0,
  };
});

const post = (body: unknown, url = "https://lianki.com/api/my/mini-apps") =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const pub = (manifest: unknown = MANIFEST, html: unknown = HTML) =>
  publish(post({ manifest, html }), deps);
const call = (method: string, args: Record<string, unknown> = {}, slug = "calc") =>
  act(post({ action: "call", method, args }), slug, deps);
const decide = (permission: string, choice: string) =>
  act(post({ action: "decide", permission, choice }), "calc", deps);
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("gates", () => {
  test("flag off or a guest: every route is 404", async () => {
    for (const set of [() => (on = false), () => (who = null)]) {
      set();
      expect((await listMine(deps)).status).toBe(404);
      expect((await pub()).status).toBe(404);
      expect((await appInfo("calc", deps)).status).toBe(404);
      expect((await removeApp("calc", deps)).status).toBe(404);
      expect((await call("storage.get", { key: "a" })).status).toBe(404);
      expect(await hostView("calc", "https://lianki.com", deps)).toBeNull();
      on = true;
      who = DEV;
    }
  });

  test("phase 1: publishing needs dev; an account sees only its own apps", async () => {
    who = USER;
    expect(await body(await pub())).toEqual({ error: "dev-required" });
    who = DEV;
    expect((await pub()).status).toBe(201);
    who = USER;
    expect(await body(await listMine(deps))).toMatchObject({ apps: [], canPublish: false });
    expect((await appInfo("calc", deps)).status).toBe(404);
    expect((await call("storage.get", { key: "a" })).status).toBe(404);
    expect((await removeApp("calc", deps)).status).toBe(404);
    expect(await hostView("calc", "https://lianki.com", deps)).toBeNull();
  });
});

describe("publish", () => {
  test("stores the file and manifest in R2 and a row in D1; a republish keeps the id", async () => {
    const r = await pub();
    expect(r.status).toBe(201);
    expect(await body(r)).toEqual({
      slug: "calc",
      version: "0.1.0",
      size: HTML.length,
      url: "/m/calc",
    });
    expect(bucket.store.get("mini-apps/u1/calc/index.html")).toBe(HTML);
    expect(JSON.parse(bucket.store.get("mini-apps/u1/calc/manifest.json")!)).toMatchObject({
      slug: "calc",
    });
    const [{ id }] = (await db.prepare("SELECT id FROM mini_app").all<{ id: string }>()).results;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const again = await pub({ ...MANIFEST, version: "0.2.0" }, HTML.replace("1", "2"));
    expect(again.status).toBe(200);
    const rows = (
      await db.prepare("SELECT id, version FROM mini_app").all<{ id: string; version: string }>()
    ).results;
    expect(rows).toEqual([{ id, version: "0.2.0" }]);
    const list = await body(await listMine(deps));
    expect(list).toMatchObject({ canPublish: true, maxBytes: 4096, perAccount: 2 });
    expect((list.apps as { slug: string; grants: unknown }[])[0]).toMatchObject({
      slug: "calc",
      grants: {},
    });
    expect(await body(await appInfo("calc", deps))).toMatchObject({
      name: "Calc",
      version: "0.2.0",
    });
    expect((await appInfo("Bad", deps)).status).toBe(404);
    expect((await appInfo("other", deps)).status).toBe(404);
  });

  test("refuses bad bodies, manifests, files, sources and past the caps", async () => {
    expect(await body(await publish(post("{nope"), deps))).toEqual({ error: "invalid-json" });
    expect(await body(await pub({ slug: "Bad", name: "x" }))).toEqual({ error: "bad-slug" });
    expect(await body(await pub(MANIFEST, "plain text"))).toEqual({ error: "not-html" });
    const big = await pub(MANIFEST, `<div>${"x".repeat(5000)}</div>`);
    expect(big.status).toBe(413);
    expect(await body(big)).toEqual({ error: "too-big", max: 4096 });
    const huge = new Request("https://lianki.com/api/my/mini-apps", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(10 ** 6) },
      body: "{}",
    });
    expect((await publish(huge, deps)).status).toBe(413);
    expect((await publish(post("x".repeat(80 * 1024)), deps)).status).toBe(413);
    expect(
      await body(await pub(MANIFEST, '<script src="https://evil.example/x@1.0.0.js"></script>')),
    ).toEqual({
      error: "script-source",
      url: "https://evil.example/x@1.0.0.js",
    });
    expect((await pub({ ...MANIFEST, slug: "a" })).status).toBe(201);
    expect((await pub({ ...MANIFEST, slug: "b" })).status).toBe(201);
    const capped = await pub({ ...MANIFEST, slug: "c" });
    expect(capped.status).toBe(413);
    expect(await body(capped)).toEqual({ error: "app-cap", max: 2 });
    // Republishing one that exists is not a new app.
    expect((await pub({ ...MANIFEST, slug: "a" })).status).toBe(200);
  });

  test("rate-limited per account", async () => {
    deps.allow = () => false;
    expect((await pub()).status).toBe(429);
  });
});

describe("grants and calls", () => {
  beforeEach(async () => {
    await pub();
  });

  test("no answer yet: the call is refused until the user decides", async () => {
    const r = await call("storage.get", { key: "a" });
    expect(r.status).toBe(403);
    expect(await body(r)).toEqual({ error: "permission-required", permission: "storage" });
    expect(await body(await decide("storage", "app"))).toEqual({ grants: { storage: "allow" } });
    expect(await body(await call("storage.get", { key: "a" }))).toEqual({ value: null });
  });

  test("once: one call, then the prompt again", async () => {
    await decide("storage", "once");
    expect((await call("storage.set", { key: "a", value: 1 })).status).toBe(200);
    expect(await body(await call("storage.get", { key: "a" }))).toEqual({
      error: "permission-required",
      permission: "storage",
    });
  });

  test("deny stays; revoke forgets it", async () => {
    await decide("storage", "deny");
    expect(await body(await call("storage.get", { key: "a" }))).toEqual({
      error: "permission-denied",
      permission: "storage",
    });
    expect(
      await body(await act(post({ action: "revoke", permission: "storage" }), "calc", deps)),
    ).toEqual({
      grants: {},
    });
    expect((await call("storage.get", { key: "a" })).status).toBe(403);
  });

  test("bad requests and undeclared capabilities", async () => {
    await pub({ ...MANIFEST, slug: "bare", permissions: [] });
    expect(await body(await call("storage.get", { key: "a" }, "bare"))).toEqual({
      error: "permission-undeclared",
      permission: "storage",
    });
    expect(
      await body(
        await act(post({ action: "decide", permission: "storage", choice: "app" }), "bare", deps),
      ),
    ).toEqual({
      error: "permission-undeclared",
    });
    expect(await body(await decide("storage", "always"))).toEqual({ error: "bad-choice" });
    expect(
      await body(await act(post({ action: "revoke", permission: "eval" }), "calc", deps)),
    ).toEqual({
      error: "bad-request",
    });
    expect(await body(await act(post({ action: "fly" }), "calc", deps))).toEqual({
      error: "bad-request",
    });
    expect(await body(await act(post("null"), "calc", deps))).toEqual({ error: "bad-request" });
    expect(await body(await act(post("{x"), "calc", deps))).toEqual({ error: "invalid-json" });
    expect((await act(post("x".repeat(300 * 1024)), "calc", deps)).status).toBe(413);
    expect(await body(await call("eval"))).toEqual({ error: "unknown-method" });
    expect((await act(post({ action: "call" }), "nope", deps)).status).toBe(404);
    expect((await act(post({ action: "call" }), "Bad", deps)).status).toBe(404);
  });

  test("rate limit on calls", async () => {
    await decide("storage", "app");
    deps.allow = () => false;
    expect((await call("storage.get", { key: "a" })).status).toBe(429);
  });

  test("storage: get, set, list, delete, the per-app cap, bad keys", async () => {
    await decide("storage", "app");
    expect(await body(await call("storage.set", { key: "h", value: [1, 2] }))).toEqual({
      ok: true,
    });
    expect(await body(await call("storage.get", { key: "h" }))).toEqual({ value: [1, 2] });
    expect(await body(await call("storage.list"))).toEqual({ keys: ["h"], bytes: 6, max: 64 });
    expect(await body(await call("storage.list", { prefix: "x" }))).toEqual({
      keys: [],
      bytes: 6,
      max: 64,
    });
    const full = await call("storage.set", { key: "big", value: "y".repeat(80) });
    expect(full.status).toBe(413);
    expect(await body(full)).toEqual({ error: "storage-full", max: 64 });
    // Overwriting a key does not count it twice.
    expect((await call("storage.set", { key: "h", value: "z".repeat(50) })).status).toBe(200);
    expect(await body(await call("storage.set", { key: "h", value: null }))).toEqual({ ok: true });
    expect(await body(await call("storage.get", { key: "h" }))).toEqual({ value: null });
    expect(await body(await call("storage.get", { key: "a b" }))).toEqual({ error: "bad-key" });
    expect(await body(await call("storage.set", { key: 5 }))).toEqual({ error: "bad-key" });
  });

  test("prefs: only the allowlisted keys, each checked by its schema", async () => {
    await decide("prefs:read", "app");
    await decide("prefs:write", "app");
    expect(await body(await call("prefs.set", { key: "ui.paper", value: "b" }))).toEqual({
      ok: true,
    });
    const got = await body(await call("prefs.get"));
    expect(got.prefs).toEqual({ "ui.paper": "b" });
    expect(got.keys).toContain("ui.locale");
    expect(
      await body(await call("prefs.get", { keys: ["ui.paper", "byok.backend"] })),
    ).toMatchObject({
      prefs: { "ui.paper": "b" },
    });
    expect(await body(await call("prefs.set", { key: "byok.backend", value: null }))).toEqual({
      error: "pref-not-allowed",
    });
    expect(await body(await call("prefs.set", { key: "ui.paper", value: "zzz" }))).toEqual({
      error: "bad-value",
    });
    expect(appPrefKeys("ui.paper, nope, ui.paper,ui.locale")).toEqual(["ui.paper", "ui.locale"]);
  });

  test("chat: read, say and card go to the port, named after the app", async () => {
    for (const p of ["chat:read", "chat:write", "chat:ask"]) await decide(p, "app");
    expect(await body(await call("chat.read", { limit: 5 }))).toEqual({
      lines: [{ id: "l1", from: "owner", lane: null, text: "hi 5", at: 1 }],
    });
    expect(await body(await call("chat.read"))).toMatchObject({ lines: [{ text: "hi 20" }] });
    expect(await body(await call("chat.say", { text: " 6 × 7 = 42 " }))).toEqual({ id: "l2" });
    expect(await body(await call("chat.say", { text: "" }))).toEqual({ error: "bad-text" });
    expect(await body(await call("ui.card", { title: "Keep?", options: ["Yes", "No"] }))).toEqual({
      choice: "Yes",
    });
    expect(await body(await call("ui.card", { title: "", options: [] }))).toEqual({
      error: "bad-card",
    });
    expect(chatLog).toEqual(["app-calc:6 × 7 = 42", "app-calc?Keep?"]);
    chat = {
      read: chat.read,
      say: async () => ({ error: "chat-refused" }),
      card: async () => ({ error: "chat-refused" }),
    };
    expect((await call("chat.say", { text: "x" })).status).toBe(502);
    expect((await call("ui.card", { title: "t", options: ["a"] })).status).toBe(502);
    deps.chat = undefined;
    for (const m of ["chat.read", "chat.say", "ui.card"])
      expect(await body(await call(m, { text: "x", title: "t", options: ["a"] }))).toEqual({
        error: "chat-unavailable",
      });
  });
});

describe("the frame", () => {
  beforeEach(async () => {
    await pub();
  });

  test("srcdoc: the CSP meta and the SDK first, opaque sandbox", async () => {
    const v = await hostView("calc", "https://lianki.com", deps);
    expect(v).toMatchObject({ slug: "calc", name: "Calc", grants: {} });
    if (v?.frame.mode !== "srcdoc") throw new Error("expected srcdoc");
    expect(v.frame.sandbox).toBe("allow-scripts allow-forms");
    expect(v.frame.srcdoc).toStartWith(
      '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;'
        .replace("&#39;", "'")
        .replace("&#39;", "'"),
    );
    expect(v.frame.srcdoc).toContain('<script src="https://lianki.com/m/sdk.js"></script><html>');
    bucket.store.clear();
    expect(await hostView("calc", "https://lianki.com", deps)).toBeNull();
    expect(await hostView("nope", "https://lianki.com", deps)).toBeNull();
    expect(await hostView("Bad", "https://lianki.com", deps)).toBeNull();
  });

  test("its own origin: a ticketed src; no usable secret falls back to srcdoc", async () => {
    cfg = config({ origin: "https://m.lianki.com" });
    const v = await hostView("calc", "https://lianki.com", deps);
    if (v?.frame.mode !== "origin") throw new Error("expected origin");
    expect(v.frame.origin).toBe("https://m.lianki.com");
    expect(v.frame.src).toStartWith("https://m.lianki.com/api/m/calc?t=");
    expect(v.frame.sandbox).toBe("allow-scripts allow-forms");
    cfg = config({ origin: "https://{app}.liankiapps.com" });
    const per = await hostView("calc", "https://lianki.com", deps);
    expect(per?.frame.sandbox).toBe("allow-scripts allow-forms allow-same-origin");
    deps.secret = () => "short";
    expect((await hostView("calc", "https://lianki.com", deps))?.frame.mode).toBe("srcdoc");
  });

  test("the ticketed file: only on its own origin, with the CSP header", async () => {
    cfg = config({ origin: "https://m.lianki.com" });
    const v = await hostView("calc", "https://lianki.com", deps);
    if (v?.frame.mode !== "origin") throw new Error("expected origin");
    const r = await serveApp(new Request(v.frame.src), "calc", deps);
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors https://lianki.com");
    expect(csp).toContain("sandbox allow-scripts allow-forms");
    expect(csp).toContain("https://lianki.com/m/ https://m.lianki.com/m/");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await r.text();
    expect(html).toStartWith('<!doctype html><script src="https://lianki.com/m/sdk.js"></script>');
    expect(html).not.toContain("http-equiv");
    // Another host, another slug, no ticket, a republished file, the flag off: 404.
    const t = new URL(v.frame.src).searchParams.get("t")!;
    expect(
      (await serveApp(new Request(`https://lianki.com/api/m/calc?t=${t}`), "calc", deps)).status,
    ).toBe(404);
    expect((await serveApp(new Request(v.frame.src), "other", deps)).status).toBe(404);
    expect(
      (await serveApp(new Request("https://m.lianki.com/api/m/calc"), "calc", deps)).status,
    ).toBe(404);
    expect((await serveApp(new Request(v.frame.src), "Bad", deps)).status).toBe(404);
    deps.secret = () => undefined;
    expect((await serveApp(new Request(v.frame.src), "calc", deps)).status).toBe(404);
    deps.secret = () => SECRET;
    cfg = config({ origin: "" });
    expect((await serveApp(new Request(v.frame.src), "calc", deps)).status).toBe(404);
    cfg = config({ origin: "https://m.lianki.com" });
    bucket.store.clear();
    expect((await serveApp(new Request(v.frame.src), "calc", deps)).status).toBe(404);
    await pub(MANIFEST, HTML.replace("1", "3"));
    expect((await serveApp(new Request(v.frame.src), "calc", deps)).status).toBe(404);
    // A ticket for an app id that is not this row's.
    const forged = await signTicket(
      {
        u: "u1",
        a: "ffffffffffffffff",
        s: "calc",
        h: "x",
        b: "https://lianki.com",
        f: "https://lianki.com",
        e: T0 + 1000,
      },
      SECRET,
    );
    expect(
      (await serveApp(new Request(`https://m.lianki.com/api/m/calc?t=${forged}`), "calc", deps))
        .status,
    ).toBe(404);
    on = false;
    expect((await serveApp(new Request(v.frame.src), "calc", deps)).status).toBe(404);
  });

  test("delete: files, row, grants and storage go", async () => {
    await decide("storage", "app");
    await call("storage.set", { key: "a", value: 1 });
    expect(await body(await removeApp("calc", deps))).toEqual({ ok: true });
    expect(bucket.store.size).toBe(0);
    for (const t of ["mini_app", "mini_app_grant", "mini_app_kv"])
      expect((await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n).toBe(
        0,
      );
    expect((await removeApp("calc", deps)).status).toBe(404);
    expect((await removeApp("Bad", deps)).status).toBe(404);
  });
});

describe("store", () => {
  test("kv rows are per app; a row past the cap is refused atomically", async () => {
    expect(await kvSet(db, "a1", "k", "v", 10, T0)).toBe(true);
    expect(await kvSet(db, "a2", "k", "vvvv", 10, T0)).toBe(true);
    expect(await kvSet(db, "a1", "k2", "too long", 10, T0)).toBe(false);
    expect(await kvGet(db, "a2", "k")).toBe("vvvv");
    expect(await kvList(db, "a1")).toEqual({ keys: ["k"], bytes: 4 });
  });

  test("a bad stored permissions column reads as none", async () => {
    await upsertApp(
      db,
      {
        id: "0123456789abcdef",
        ownerId: "u1",
        slug: "x",
        name: "X",
        icon: "X",
        version: "1.0.0",
        permissions: [],
        size: 1,
        sha256: "s",
        r2Key: "k",
        now: T0,
      },
      5,
    );
    db.prepare("UPDATE mini_app SET permissions = 'not json'").run();
    expect((await body(await appInfo("x", deps))).permissions).toEqual([]);
    db.prepare("UPDATE mini_app SET permissions = '{}'").run();
    expect((await body(await appInfo("x", deps))).permissions).toEqual([]);
    expect(() =>
      upsertApp(
        db,
        {
          id: "1",
          ownerId: "bad id!",
          slug: "x",
          name: "",
          icon: "",
          version: "",
          permissions: [],
          size: 0,
          sha256: "",
          r2Key: "",
          now: 0,
        },
        1,
      ),
    ).not.toThrow();
  });
});

describe("the real adapters", () => {
  test("createMiniDeps reads the account, dev, the flag and the config", async () => {
    const values: Record<string, number | string> = Object.fromEntries(
      Object.entries(CONFIG)
        .filter(([k]) => k.startsWith("miniApps."))
        .map(([k, v]) => [k, v.default as number | string]),
    );
    const d = createMiniDeps({
      user: async () => ({ id: "u1", email: "dev@example.com" }),
      isDev: (e) => e === "dev@example.com",
      on: async () => true,
      db: () => db,
      bucket: () => bucket,
      value: async (k) => values[k]!,
      push: () => null,
      secret: () => SECRET,
    });
    expect(await d.who()).toEqual({ id: "u1", email: "dev@example.com", dev: true });
    expect(await d.config()).toMatchObject({
      maxBytes: 2 * 1024 * 1024,
      origin: "",
      perAccount: 20,
    });
    expect(d.db()).toBe(db);
    expect(d.bucket()).toBe(bucket);
    expect(d.secret?.()).toBe(SECRET);
    expect(d.allow?.("u1", 1)).toBe(true);
    expect(await d.chat!().say(DEV, "app-x", "hi")).toEqual({ error: "chat-unavailable" });
    const guest = createMiniDeps({
      user: async () => ({ id: "u1", email: null }),
      isDev: () => true,
      on: async () => true,
      db: () => db,
      bucket: () => bucket,
      value: async () => 0,
    });
    expect(await guest.who()).toBeNull();
    expect(await guest.chat!().card(DEV, "a", { title: "t", options: ["a"] }, 10)).toEqual({
      error: "chat-unavailable",
    });
  });
});

describe("the chat port", () => {
  test("cards are checked", () => {
    expect(parseCard({ title: " Keep? ", options: [" Yes ", "No"] })).toEqual({
      title: "Keep?",
      options: ["Yes", "No"],
    });
    for (const bad of [
      null,
      { title: 1, options: ["a"] },
      { title: " ", options: ["a"] },
      { title: "x".repeat(501), options: ["a"] },
      { title: "t", options: [] },
      { title: "t", options: Array(9).fill("a") },
      { title: "t", options: [""] },
      { title: "t", options: [3] },
      { title: "t", options: ["x".repeat(121)] },
      { title: "t" },
    ])
      expect(parseCard(bad)).toBeNull();
    expect(laneOfApp("calc")).toBe("app-calc");
    expect(laneOfApp("x".repeat(40)).length).toBe(40);
  });

  test("read is the account's own D1 history", async () => {
    db.prepare(
      "INSERT INTO chat_line (user_id, id, thread, sender, lane, text, at_ms) VALUES ('u1','a','owner','owner',NULL,'mine',1), ('u2','b','u2','friend',NULL,'theirs',2)",
    ).run();
    const port = pushChatPort({ db: db as never, push: null });
    expect(await port.read(DEV, 999)).toEqual([
      { id: "a", from: "owner", lane: null, text: "mine", at: 1 },
    ]);
  });

  test("say: a token for exactly chat:write, named after the app, revoked after", async () => {
    const seen: { auth: string | null; body: unknown; scopes?: string }[] = [];
    const revoked: string[][] = [];
    const push = {
      fetch: async (_url: string, init?: RequestInit) => {
        const row = await db
          .prepare("SELECT name, scopes FROM api_tokens")
          .first<{ name: string; scopes: string }>();
        seen.push({
          auth: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
          scopes: `${row?.name} ${row?.scopes}`,
        });
        return Response.json({ ok: true, id: "line1" });
      },
    };
    const port = pushChatPort({
      db: db as never,
      push,
      now: () => T0,
      revoked: async (ids) => void revoked.push(ids),
    });
    expect(await port.say(DEV, "app-calc", "hello")).toEqual({ id: "line1" });
    expect(seen[0]!.auth).toMatch(/^Bearer lk_[0-9a-f]{64}$/);
    expect(seen[0]!.body).toEqual({ op: "say", text: "hello" });
    expect(seen[0]!.scopes).toBe('app-calc ["chat:write"]');
    expect(await db.prepare("SELECT COUNT(*) AS n FROM api_tokens").first<{ n: number }>()).toEqual(
      { n: 0 },
    );
    expect(revoked.length).toBe(1);
    const refused = pushChatPort({
      db: db as never,
      push: { fetch: async () => new Response("no", { status: 403 }) },
    });
    expect(await refused.say(DEV, "app-calc", "x")).toEqual({ error: "chat-refused" });
    const failing = pushChatPort({
      db: db as never,
      push: { fetch: async () => Response.json({ ok: true, id: "l" }) },
      revoked: async () => Promise.reject(new Error("down")),
    });
    expect(await failing.say(DEV, "app-calc", "x")).toEqual({ id: "l" });
  });

  /** A fake token socket: what the hub would send, in order. */
  function fakeSocket(
    script: (sent: string, emit: (m: unknown) => void, close: () => void) => void,
  ) {
    const listeners: Record<string, ((e: { data?: unknown }) => void)[]> = {
      message: [],
      close: [],
    };
    const emit = (m: unknown) =>
      queueMicrotask(() =>
        listeners.message!.forEach((l) =>
          l({ data: typeof m === "string" ? m : JSON.stringify(m) }),
        ),
      );
    const close = () => queueMicrotask(() => listeners.close!.forEach((l) => l({})));
    const ws: PortSocket & { closed: boolean } = {
      closed: false,
      accept() {},
      send(d) {
        script(d, emit, close);
      },
      close() {
        this.closed = true;
        throw new Error("already closed"); // a close that throws is ignored
      },
      addEventListener(t, fn) {
        listeners[t]!.push(fn);
      },
    };
    return ws;
  }

  test("card: listens, posts the ask once ready, resolves with the tap of that ask", async () => {
    const posts: unknown[] = [];
    const ws = fakeSocket((sent, emit) => {
      expect(JSON.parse(sent)).toMatchObject({ type: "auth" });
      emit("not json");
      emit({ type: "ready" });
    });
    const push = {
      fetch: async (_u: string, init?: RequestInit) => {
        if (new Headers(init?.headers).get("upgrade"))
          return Object.assign(new Response(null), { webSocket: ws });
        posts.push(JSON.parse(String(init?.body)));
        queueMicrotask(() => {
          for (const l of (ws as unknown as { _l?: never })._l ?? []) void l;
        });
        setTimeout(() => {
          // Another ask's answer first, then ours.
          (ws as unknown as { emitAnswer: (id: string) => void }).emitAnswer?.("other");
        }, 0);
        return Response.json({ ok: true, id: "l", askId: "ask1" });
      },
    };
    // Wire the answers through the same socket.
    const listeners: ((e: { data?: unknown }) => void)[] = [];
    const orig = ws.addEventListener.bind(ws);
    ws.addEventListener = (t, fn) => {
      if (t === "message") listeners.push(fn);
      orig(t, fn);
    };
    (ws as unknown as { emitAnswer: (id: string) => void }).emitAnswer = (id) => {
      for (const l of listeners)
        l({ data: JSON.stringify({ type: "answered", askId: id, labels: { q1: ["No"] } }) });
      for (const l of listeners)
        l({ data: JSON.stringify({ type: "answered", askId: "ask1", labels: { q1: ["Yes"] } }) });
    };
    const port = pushChatPort({ db: db as never, push, now: () => T0 });
    expect(
      await port.card(DEV, "app-calc", { title: "Keep?", options: ["Yes", "No"] }, 5000),
    ).toEqual({ choice: "Yes" });
    expect(posts).toEqual([
      { op: "ask", question: "Keep?", options: ["Yes", "No"], expiresAt: T0 + 5000 },
    ]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM api_tokens").first<{ n: number }>()).toEqual(
      { n: 0 },
    );
  });

  test("card: no socket, a refused ask, an error event, a close, a timeout", async () => {
    const noSocket = pushChatPort({
      db: db as never,
      push: { fetch: async () => new Response(null) },
    });
    expect(await noSocket.card(DEV, "a", { title: "t", options: ["a"] }, 100)).toEqual({
      error: "chat-unavailable",
    });
    const runs: [string, (emit: (m: unknown) => void, close: () => void) => void][] = [
      ["refused", (emit) => emit({ type: "ready" })],
      ["error", (emit) => emit({ type: "error" })],
      ["close", (_e, close) => close()],
      ["timeout", () => {}],
    ];
    for (const [name, run] of runs) {
      const ws = fakeSocket((_s, emit, close) => run(emit, close));
      const r = await waitForTap(ws, "lk_x", 20, async (then) => then({}));
      expect([name, r]).toEqual([
        name,
        name === "refused" || name === "error" ? { error: "chat-refused" } : { choice: null },
      ]);
    }
    const blank = fakeSocket((_s, emit) => {
      emit({ type: "ready" });
      setTimeout(() => emit({ type: "answered", askId: "q" }), 1);
    });
    expect(await waitForTap(blank, "lk_x", 200, async (then) => then({ askId: "q" }))).toEqual({
      choice: null,
    });
  });
});

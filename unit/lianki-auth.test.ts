import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { request } from "http";
import { join } from "path";
import { s256 } from "@/lib/cli-login";
import {
  authMain,
  configPath,
  nextHlc,
  parseValue,
  readConfig,
  writeConfig,
  type AuthDeps,
  type CliConfig,
} from "../scripts/dev/lianki-auth";

const TOKEN = `lk_${"9f".repeat(32)}`;
const OTHER = `lk_${"0e".repeat(32)}`;
/**
 * The simulated browser's GET. Not global fetch: other suites replace it and
 * do not always put it back.
 */
function get(url: string): Promise<{ status: number; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: async () => body }));
    })
      .on("error", reject)
      .end();
  });
}

/** Everything any test printed, checked for tokens at the end. */
const printed: string[] = [];

type Call = { method: string; path: string; auth: string | null; body: unknown };

function fakeDeps(
  over: Partial<AuthDeps> & { server?: Partial<Record<string, Response | (() => Response)>> } = {},
) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const vault = new Map<string, string>();
  let config: CliConfig = { sites: {} };
  let prefs: Record<
    string,
    { value: unknown; hlc: { timestamp: number; counter: number; deviceId: string } }
  > = {
    "words.readAloud": {
      value: false,
      hlc: { timestamp: 5e12, counter: 2, deviceId: "phone0001" },
    },
  };
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const server = over.server ?? {};
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("Authorization");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, auth, body });
    const key = `${method} ${u.pathname}`;
    const o = server[key];
    if (o) return typeof o === "function" ? o() : o.clone();
    if (key === "POST /api/cli-login/token")
      return json({
        token: TOKEN,
        id: "hash",
        name: "lianki CLI test-mac",
        email: "me@example.com",
      });
    if (key === "DELETE /api/cli-login/token") return json({ ok: true });
    if (u.pathname === "/api/prefs") {
      if (auth !== `Bearer ${TOKEN}`) return json({ error: "Login required" }, 401);
      if (method === "GET") return json({ user: "u1", prefs, cursor: 1 });
      const ops = body.ops as { key: string; value: unknown; hlc: never }[];
      for (const op of ops) prefs = { ...prefs, [op.key]: { value: op.value, hlc: op.hlc } };
      return json({
        user: "u1",
        prefs: Object.fromEntries(ops.map((o) => [o.key, prefs[o.key]])),
        rejected: [],
      });
    }
    return json({ error: "nope" }, 404);
  }) as typeof fetch;

  const d: AuthDeps = {
    base: "https://lianki.test",
    fetch: fetchFake,
    store: {
      async set(site, token) {
        vault.set(site, token);
        return "keychain";
      },
      async get(site) {
        return vault.get(site) ?? null;
      },
      async delete(site) {
        vault.delete(site);
      },
    },
    config: {
      read: () => structuredClone(config),
      write: (c) => {
        config = structuredClone(c);
      },
    },
    out: (s) => {
      out.push(s);
      printed.push(s);
    },
    err: (s) => {
      err.push(s);
      printed.push(s);
    },
    openUrl: () => {},
    hostname: "test-mac",
    env: {},
    readStdin: async () => `${TOKEN}\n`,
    timeoutMs: 2000,
    ...over,
  };
  return { d, calls, out, err, vault, config: () => config };
}

/** The browser: after "approval", the page sends it to the loopback URL with a code. */
const browser =
  (q: (state: string) => string) =>
  async (url: string): Promise<void> => {
    const u = new URL(url);
    const back = new URL(u.searchParams.get("redirect_uri")!);
    const r = await get(`${back}?${q(u.searchParams.get("state")!)}`);
    printed.push(await r.text());
  };

describe("lianki auth login (browser)", () => {
  test("a one-time code comes back; the token arrives in the exchange's body and is stored, never printed", async () => {
    let opened = "";
    const f = fakeDeps({
      openUrl: async (url) => {
        opened = url;
        await browser((s) => `code=onetimecode123&state=${s}`)(url);
      },
    });
    expect(await authMain(["auth", "login"], f.d)).toBe(0);

    const u = new URL(opened);
    expect(u.origin + u.pathname).toBe("https://lianki.test/cli-login");
    expect(u.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/cb$/);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("host")).toBe("test-mac");

    const x = f.calls.find((c) => c.path === "/api/cli-login/token")!;
    const body = x.body as { code: string; code_verifier: string; redirect_uri: string };
    expect(body.code).toBe("onetimecode123");
    expect(body.redirect_uri).toBe(u.searchParams.get("redirect_uri")!);
    expect(await s256(body.code_verifier)).toBe(u.searchParams.get("code_challenge")!);

    expect(f.vault.get("lianki.test")).toBe(TOKEN);
    expect(f.config().sites["lianki.test"]).toEqual({
      storage: "keychain",
      email: "me@example.com",
      name: "lianki CLI test-mac",
      tokenId: "hash",
    });
    expect(f.out.join("\n")).toContain("me@example.com");
  });

  test("a callback with another state is refused, and no code is exchanged", async () => {
    const f = fakeDeps({
      timeoutMs: 300,
      openUrl: async (url) => {
        const back = new URL(new URL(url).searchParams.get("redirect_uri")!);
        const wrong = await get(`${back}?code=stolen&state=someoneelse`);
        expect(wrong.status).toBe(400);
        expect((await get(`${back.origin}/other`)).status).toBe(404);
      },
    });
    expect(await authMain(["auth", "login"], f.d)).toBe(1);
    expect(f.err.join("\n")).toContain("timed out");
    expect(f.calls.some((c) => c.path === "/api/cli-login/token")).toBe(false);
  });

  test("Deny in the browser stops the wait", async () => {
    const f = fakeDeps({ openUrl: browser((s) => `error=access_denied&state=${s}`) });
    expect(await authMain(["auth", "login"], f.d)).toBe(1);
    expect(f.err.join("\n")).toContain("denied");
    const g = fakeDeps({ openUrl: browser((s) => `state=${s}`) });
    expect(await authMain(["auth", "login"], g.d)).toBe(1);
    expect(g.err.join("\n")).toContain("no code");
  });

  test("a refused exchange stores nothing", async () => {
    const f = fakeDeps({
      openUrl: browser((s) => `code=c&state=${s}`),
      server: {
        "POST /api/cli-login/token": new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
      },
    });
    expect(await authMain(["auth", "login"], f.d)).toBe(1);
    expect(f.err.join("\n")).toContain("400 invalid_grant");
    expect(f.vault.size).toBe(0);
    const g = fakeDeps({
      openUrl: browser((s) => `code=c&state=${s}`),
      server: { "POST /api/cli-login/token": new Response("oops", { status: 502 }) },
    });
    expect(await authMain(["auth", "login"], g.d)).toBe(1);
  });
});

describe("lianki auth login --token (paste)", () => {
  test("from the argument, stdin (-) or LIANKI_TOKEN, checked against the server first", async () => {
    for (const [argv, env] of [
      [["auth", "login", "--token", TOKEN], {}],
      [["auth", "login", "--token", "-"], {}],
      [["auth", "login"], { LIANKI_TOKEN: TOKEN }],
    ] as const) {
      const f = fakeDeps({ env });
      expect(await authMain([...argv], f.d)).toBe(0);
      expect(f.vault.get("lianki.test")).toBe(TOKEN);
      expect(f.config().sites["lianki.test"].user).toBe("u1");
    }
  });

  test("not an lk_ token, a refused one, or a missing value", async () => {
    const f = fakeDeps();
    expect(await authMain(["auth", "login", "--token", "hunter2"], f.d)).toBe(1);
    expect(await authMain(["auth", "login", "--token", OTHER], f.d)).toBe(1);
    expect(f.err.join("\n")).toContain("refused the token (401)");
    expect(await authMain(["auth", "login", "--token"], f.d)).toBe(2);
    expect(f.vault.size).toBe(0);
  });
});

describe("lianki auth status / logout", () => {
  test("status: not signed in, signed in, refused, and LIANKI_TOKEN", async () => {
    const f = fakeDeps();
    expect(await authMain(["auth", "status"], f.d)).toBe(1);
    expect(f.out.pop()).toContain("Not signed in");
    await authMain(["auth", "login", "--token", TOKEN], f.d);
    f.out.length = 0;
    expect(await authMain(["auth", "status"], f.d)).toBe(0);
    expect(f.out.join("\n")).toContain("the server accepts it");

    const g = fakeDeps({ openUrl: browser((s) => `code=c&state=${s}`) });
    await authMain(["auth", "login"], g.d);
    g.out.length = 0;
    expect(await authMain(["auth", "status"], g.d)).toBe(0);
    expect(g.out.join("\n")).toContain('token: "lianki CLI test-mac", stored in Keychain');

    const h = fakeDeps({ env: { LIANKI_TOKEN: OTHER } });
    expect(await authMain(["auth", "status"], h.d)).toBe(1);
    expect(h.out.join("\n")).toContain("refused it (401)");
    const i = fakeDeps({ env: { LIANKI_TOKEN: "junk" } });
    expect(await authMain(["auth", "status"], i.d)).toBe(1);
    expect(i.out.join("\n")).toContain("not an lk_ token");
  });

  test("logout revokes the token with itself, then forgets it", async () => {
    const f = fakeDeps();
    await authMain(["auth", "login", "--token", TOKEN], f.d);
    expect(await authMain(["auth", "logout"], f.d)).toBe(0);
    const del = f.calls.find((c) => c.method === "DELETE")!;
    expect(del).toMatchObject({ path: "/api/cli-login/token", auth: `Bearer ${TOKEN}` });
    expect(f.vault.size).toBe(0);
    expect(f.config().sites).toEqual({});
    expect(await authMain(["auth", "logout"], f.d)).toBe(0);
    expect(f.out.pop()).toBe("Not signed in.");
  });

  test("logout when the server cannot revoke, or with only LIANKI_TOKEN", async () => {
    const f = fakeDeps({
      server: {
        "DELETE /api/cli-login/token": () => {
          throw new Error("offline");
        },
      },
    });
    await authMain(["auth", "login", "--token", TOKEN], f.d);
    expect(await authMain(["auth", "logout"], f.d)).toBe(1);
    expect(f.out.pop()).toContain("could not revoke");
    expect(f.vault.size).toBe(0);
    const g = fakeDeps({ env: { LIANKI_TOKEN: TOKEN } });
    expect(await authMain(["auth", "logout"], g.d)).toBe(0);
    expect(g.out.pop()).toContain("LIANKI_TOKEN is set");
  });
});

describe("lianki settings", () => {
  async function signedIn() {
    const f = fakeDeps();
    await authMain(["auth", "login", "--token", TOKEN], f.d);
    f.out.length = 0;
    return f;
  }

  test("list and get read /api/prefs with the Bearer token", async () => {
    const f = await signedIn();
    expect(await authMain(["settings", "list"], f.d)).toBe(0);
    expect(f.out).toContain("words.readAloud = false");
    expect(f.out).toContain("words.showAll = (not set)");
    f.out.length = 0;
    expect(await authMain(["settings", "get", "words.readAloud"], f.d)).toBe(0);
    expect(await authMain(["settings", "get", "words.showAll"], f.d)).toBe(0);
    expect(f.out).toEqual(["false", "(not set)"]);
    expect(
      f.calls.filter((c) => c.path === "/api/prefs").every((c) => c.auth === `Bearer ${TOKEN}`),
    ).toBe(true);
  });

  test("set validates by the registry, then writes with a clock newer than the stored one", async () => {
    const f = await signedIn();
    expect(await authMain(["settings", "set", "words.readAloud", "true"], f.d)).toBe(0);
    expect(await authMain(["settings", "set", "swipe.variant", "native"], f.d)).toBe(0);
    expect(f.out).toEqual(["words.readAloud = true", 'swipe.variant = "native"']);
    const patch = f.calls.filter((c) => c.method === "PATCH")[0].body as {
      ops: { hlc: { timestamp: number; counter: number; deviceId: string } }[];
    };
    expect(patch.ops[0].hlc).toMatchObject({ timestamp: 5e12, counter: 3 });
    expect(patch.ops[0].hlc.deviceId).toMatch(/^cli[0-9a-f]{16}$/);
    // The device id is kept.
    const again = f.calls.filter((c) => c.method === "PATCH")[1].body as typeof patch;
    expect(again.ops[0].hlc.deviceId).toBe(patch.ops[0].hlc.deviceId);
  });

  test("unknown keys, bad values, no login, and server refusals", async () => {
    const f = await signedIn();
    expect(await authMain(["settings", "get", "nope"], f.d)).toBe(2);
    expect(await authMain(["settings", "set"], f.d)).toBe(2);
    expect(await authMain(["settings", "set", "swipe.variant", "fast"], f.d)).toBe(2);
    expect(await authMain(["settings", "set", "words.readAloud", "{"], f.d)).toBe(2);
    expect(await authMain(["settings", "frob"], f.d)).toBe(2);
    expect(await authMain(["settings", "list"], fakeDeps().d)).toBe(1);

    const g = fakeDeps({
      env: { LIANKI_TOKEN: TOKEN },
      server: {
        "PATCH /api/prefs": new Response(
          JSON.stringify({ prefs: {}, rejected: ["words.readAloud"] }),
        ),
      },
    });
    expect(await authMain(["settings", "set", "words.readAloud", "true"], g.d)).toBe(1);
    expect(g.err.pop()).toContain("refused");
    const h = fakeDeps({ env: { LIANKI_TOKEN: OTHER } });
    expect(await authMain(["settings", "list"], h.d)).toBe(1);
    expect(h.err.pop()).toContain("401");
  });

  test("parseValue and nextHlc", () => {
    expect(parseValue("chat-voice.rate", "1.25")).toEqual({ ok: true, value: 1.25 });
    expect(parseValue("ui.locale", "ja")).toEqual({ ok: true, value: "ja" });
    expect(parseValue("ui.locale", '"ja"')).toEqual({ ok: true, value: "ja" });
    expect(parseValue("nav-pins.pinned", '["/words"]')).toEqual({ ok: true, value: ["/words"] });
    expect(parseValue("nav-pins.pinned", '["https://evil.com"]')).toEqual({ ok: false });
    expect(parseValue("not.a.key", "1")).toEqual({ ok: false });
    expect(nextHlc(undefined, "cli00000001", 100)).toEqual({
      timestamp: 100,
      counter: 0,
      deviceId: "cli00000001",
    });
    expect(nextHlc({ timestamp: 50, counter: 9, deviceId: "x" }, "cli00000001", 100).counter).toBe(
      0,
    );
    expect(nextHlc({ timestamp: 200, counter: 9, deviceId: "x" }, "cli00000001", 100)).toEqual({
      timestamp: 200,
      counter: 10,
      deviceId: "cli00000001",
    });
  });
});

describe("storage and usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "lianki-auth-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the config file is 0600 in a 0700 folder, and a missing or broken one reads empty", () => {
    const p = join(dir, "sub", "cli.json");
    expect(readConfig(p)).toEqual({ sites: {} });
    writeConfig(
      { deviceId: "cli1", sites: { "lianki.com": { storage: "file", token: TOKEN } } },
      p,
    );
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700);
    expect(readConfig(p).sites["lianki.com"].storage).toBe("file");
    writeFileSync(p, "{");
    expect(readConfig(p)).toEqual({ sites: {} });
    expect(configPath()).toMatch(/lianki\/cli\.json$/);
  });

  test("file storage: the token is kept in the 0600 config, and read back from it", async () => {
    const f = fakeDeps();
    f.d.store = {
      set: async () => "file",
      get: async (_s, meta) => meta?.token ?? null,
      delete: async () => {},
    };
    expect(await authMain(["auth", "login", "--token", TOKEN], f.d)).toBe(0);
    expect(f.config().sites["lianki.test"]).toMatchObject({ storage: "file", token: TOKEN });
    expect(f.out.pop()).toContain("(mode 0600)");
    expect(await authMain(["settings", "get", "words.readAloud"], f.d)).toBe(0);
  });

  test("usage errors", async () => {
    const f = fakeDeps();
    expect(await authMain(["auth"], f.d)).toBe(2);
    expect(await authMain(["frob"], f.d)).toBe(2);
    expect(f.err.join("\n")).toContain("usage: lianki auth");
  });

  test("no token was ever printed by any command", () => {
    const all = printed.join("\n");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(OTHER);
    expect(all).not.toMatch(/lk_[0-9a-f]{8,}/);
  });
});

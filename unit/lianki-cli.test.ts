// The npm package `lianki` (packages/lianki-cli): every command against a fake
// Lianki, the browser login against a real loopback listener, the token file,
// the JSON envelope and exit codes, and that no command ever prints the token.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "fs";
import { request } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { PREF_KEYS as SERVER_PREF_KEYS } from "@/lib/prefs/schema";
import { s256 as serverS256 } from "@/lib/cli-login";
import * as cliMod from "../packages/lianki-cli/cli.mjs";
import * as authMod from "../packages/lianki-cli/auth.mjs";

// Plain ESM with inferred types: the suite drives it with fakes, so loosely typed.
const cli: any = cliMod;
const auth: any = authMod;

const TOKEN = `lk_${"9f".repeat(32)}`;
const OTHER = `lk_${"0e".repeat(32)}`;
const printed: string[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "lianki-cli-"));
  dirs.push(d);
  return d;
};

/** The simulated browser's GET (not global fetch: other suites replace it). */
function browserGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    })
      .on("error", reject)
      .end();
  });
}

type Call = { method: string; path: string; query: string; auth: string | null; body: any };
type Handler = (c: Call) => Response | Promise<Response>;
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function harness(
  opts: {
    env?: Record<string, string>;
    server?: Record<string, Handler>;
    tty?: boolean;
    stdin?: string;
    ask?: string;
  } = {},
) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const vault = new Map<string, string>();
  const home = tmp();
  const env: Record<string, string | undefined> = {
    XDG_CONFIG_HOME: home,
    LIANKI_NO_KEYCHAIN: "1",
    ...opts.env,
  };
  const prefs: Record<string, { value: unknown; hlc: any }> = {
    "words.readAloud": {
      value: false,
      hlc: { timestamp: 5e12, counter: 2, deviceId: "phone0001" },
    },
  };
  const server: Record<string, Handler> = {
    "GET /api/prefs": (c) =>
      c.auth === `Bearer ${TOKEN}`
        ? json({ user: "u1", prefs, cursor: 1 })
        : json({ error: "Login required" }, 401),
    "PATCH /api/prefs": (c) => {
      const op = c.body.ops[0];
      if (op.key === "ui.paper" && !["a", "b", "c", "e"].includes(op.value))
        return json({ user: "u1", prefs: {}, rejected: [op.key] });
      prefs[op.key] = { value: op.value, hlc: op.hlc };
      return json({ user: "u1", prefs: { [op.key]: prefs[op.key] }, rejected: [] });
    },
    "POST /api/cli-login/token": () =>
      json({ token: TOKEN, id: "hash", name: "lianki CLI test-mac", email: "me@example.com" }),
    "DELETE /api/cli-login/token": () => json({ ok: true }),
    "GET /api/fsrs/due": () =>
      json({
        cards: [
          {
            _id: "1",
            url: "https://a.example/x",
            title: "X",
            card: { due: "2026-11-03T00:00:00.000Z", state: 2, reps: 3, lapses: 0 },
            log: [],
            hlc: {},
          },
        ],
      }),
    "GET /api/fsrs/next-url": () => json({ url: "https://a.example/x", title: "X" }),
    "GET /api/fsrs/get": (c) =>
      c.query.includes("missing")
        ? json({ error: "note not found" }, 404)
        : json({ _id: "1", url: "https://a.example/x", title: null }),
    "POST /api/fsrs/add": (c) =>
      json({
        url: c.body.url,
        title: c.body.title ?? null,
        card: { due: "2026-11-03T00:00:00.000Z" },
        options: [
          { rating: 1, label: "Again", due: "1m" },
          { rating: 3, label: "Good", due: "10m" },
        ],
      }),
    "POST /api/fsrs/review/3": () =>
      json({
        ok: true,
        due: "3d",
        card: { due: "2026-11-06T00:00:00.000Z" },
        nextUrl: "https://a.example/y",
        nextTitle: "Y",
      }),
    "POST /api/fsrs/review/1": () =>
      new Response("Error: note not found; <a href='/'>Home</a>", {
        status: 500,
        headers: { "content-type": "text/html" },
      }),
    "GET /api/fsrs/delete": () => json({ ok: true, nextUrl: null, nextTitle: null }),
    "PATCH /api/fsrs/update-url": (c) => json({ ok: c.body.oldUrl !== "https://none.example/" }),
    "GET /api/fsrs/stats": () => json({ backend: "d1", notes: 12, due: 3, goals: 0 }),
    ...opts.server,
  };
  const fetchFake = async (input: URL, init: any = {}) => {
    const u = new URL(String(input));
    const method = init.method ?? "GET";
    const call: Call = {
      method,
      path: u.pathname,
      query: u.search,
      auth: init.headers?.authorization ?? null,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const h = server[`${method} ${u.pathname}`];
    if (!h) return new Response("404", { status: 404 });
    if (u.pathname.startsWith("/api/fsrs") && call.auth !== `Bearer ${TOKEN}`)
      return json({ error: "Login required" }, 401);
    return h(call);
  };
  const config = auth.fileConfig(env);
  const deps = {
    env,
    version: "0.2.0",
    fetch: fetchFake,
    out: (s: string) => (out.push(s), printed.push(s)),
    err: (s: string) => (err.push(s), printed.push(s)),
    store: {
      set: async (site: string, t: string) => (vault.set(site, t), "keychain"),
      get: async (site: string) => vault.get(site) ?? null,
      delete: async (site: string) => void vault.delete(site),
    },
    config,
    listen: auth.listen,
    opened: [] as string[],
    openUrl: (u: string) => void deps.opened.push(u),
    hostname: "test-mac",
    readStdin: async () => opts.stdin ?? "",
    ask: async () => opts.ask ?? "n",
    stdinIsTTY: opts.tty ?? false,
    columns: 100,
    timeoutMs: 5_000,
    now: () => 1e12,
  };
  const run = async (...args: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await cli.run(args, deps);
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { run, deps, calls, vault, prefs, config, home };
}
const env = { LIANKI_TOKEN: TOKEN };
const envelope = (s: string) => JSON.parse(s);

describe("help: progressive disclosure", () => {
  test("top level is a short command list with examples", async () => {
    const h = harness();
    const r = await h.run("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("lianki auth");
    expect(r.out).toContain("Examples:");
    expect(r.out).toContain("Exit codes:");
    expect(r.out).not.toContain("--exclude-domains");
    expect(r.out.split("\n").length).toBeLessThan(35);
  });
  test("details live under the command", async () => {
    const h = harness();
    expect((await h.run("due", "--help")).out).toContain("--exclude-domains");
    expect((await h.run("auth", "login", "--help")).out).toContain("LIANKI_TOKEN");
    expect((await h.run("settings", "set", "--help")).out).toContain("chat-voice.rate");
  });
  test("no command prints help and exits 1; unknown is a usage error", async () => {
    const h = harness();
    const r = await h.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("Commands:");
    const u = await h.run("nope", "--json");
    expect(u.code).toBe(1);
    expect(envelope(u.err)).toMatchObject({ v: 1, ok: false, error: { code: "usage" }, exit: 1 });
    expect((await h.run("--version")).out).toBe("0.2.0");
  });
});

describe("cards", () => {
  test("next, due, get, stats: JSON envelope and terse text", async () => {
    const h = harness({ env });
    const n = await h.run("next", "--json", "--exclude-domains", "b.example");
    expect(envelope(n.out)).toEqual({
      v: 1,
      ok: true,
      command: "next",
      data: { card: { url: "https://a.example/x", title: "X" } },
    });
    expect(h.calls.at(-1)!.query).toContain("excludeDomains=b.example");
    expect((await h.run("next")).out).toBe("https://a.example/x  X");
    const d = await h.run("due", "--limit", "5", "--json");
    expect(envelope(d.out).data.cards[0]).toEqual({
      url: "https://a.example/x",
      title: "X",
      due: "2026-11-03T00:00:00.000Z",
      state: 2,
      reps: 3,
      lapses: 0,
    });
    expect(h.calls.at(-1)!.query).toContain("limit=5");
    expect((await h.run("get", "https://a.example/x")).out).toBe("https://a.example/x");
    expect((await h.run("stats")).out).toBe("12 cards, 3 due");
  });
  test("add and review", async () => {
    const h = harness({ env });
    const a = await h.run("add", "https://a.example/z", "--title", "Z", "--json");
    expect(envelope(a.out).data).toEqual({
      url: "https://a.example/z",
      title: "Z",
      due: "2026-11-03T00:00:00.000Z",
      options: [
        { rating: "again", interval: "1m" },
        { rating: "good", interval: "10m" },
      ],
    });
    expect(h.calls.at(-1)!.body).toEqual({ url: "https://a.example/z", title: "Z" });
    const r = await h.run("review", "https://a.example/x", "good");
    expect(r.code).toBe(0);
    expect(r.out).toBe("good: next review in 3d\nnext: https://a.example/y  Y");
    expect(h.calls.at(-1)!.query).toBe("?url=https%3A%2F%2Fa.example%2Fx");
    expect(
      envelope((await h.run("review", "https://a.example/x", "3", "--json")).out).data.next,
    ).toEqual({ url: "https://a.example/y", title: "Y" });
    expect((await h.run("review", "https://a.example/x", "meh")).code).toBe(1);
  });
  test("not found is exit 3, whether 404 or the router's 500", async () => {
    const h = harness({ env });
    expect((await h.run("get", "https://missing.example/")).code).toBe(3);
    const r = await h.run("review", "https://missing.example/", "again", "--json");
    expect(r.code).toBe(3);
    expect(envelope(r.err).error.code).toBe("not_found");
    expect((await h.run("move", "https://none.example/", "https://b.example/")).code).toBe(3);
    expect((await h.run("move", "https://a.example/x", "https://b.example/x")).out).toContain(
      "moved",
    );
  });
  test("delete asks; without a terminal it needs --yes", async () => {
    const h = harness({ env });
    const r = await h.run("delete", "https://a.example/x");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--yes");
    expect(h.calls.length).toBe(0);
    expect((await h.run("delete", "https://a.example/x", "--yes")).out).toBe(
      "deleted https://a.example/x",
    );
    const no = harness({ env, tty: true, ask: "n" });
    expect((await no.run("delete", "https://a.example/x")).code).toBe(1);
    expect(no.calls.length).toBe(0);
    const yes = harness({ env, tty: true, ask: "y" });
    expect((await yes.run("delete", "https://a.example/x")).code).toBe(0);
  });
  test("exit codes: auth 2, server 4, refused 5, network 4", async () => {
    expect((await harness().run("next")).code).toBe(2);
    expect((await harness({ env: { LIANKI_TOKEN: OTHER } }).run("next")).code).toBe(2);
    expect((await harness({ env: { LIANKI_TOKEN: "nope" } }).run("next")).code).toBe(2);
    expect(
      (
        await harness({
          env,
          server: { "GET /api/fsrs/stats": () => json({ error: "x" }, 503) },
        }).run("stats")
      ).code,
    ).toBe(4);
    expect(
      (
        await harness({
          env,
          server: { "GET /api/fsrs/stats": () => json({ error: "slow down" }, 429) },
        }).run("stats")
      ).code,
    ).toBe(5);
    expect(
      (
        await harness({
          env,
          server: { "GET /api/fsrs/stats": () => new Response("", { status: 308 }) },
        }).run("stats")
      ).code,
    ).toBe(4);
    expect(
      (
        await harness({
          env,
          server: { "GET /api/fsrs/stats": () => new Response("<html>", { status: 200 }) },
        }).run("stats")
      ).code,
    ).toBe(4);
    const h = harness({ env });
    h.deps.fetch = async () => {
      throw new Error("offline");
    };
    const r = await h.run("stats", "--json");
    expect(r.code).toBe(4);
    expect(envelope(r.err).error.code).toBe("network");
    h.deps.fetch = async () => {
      throw "weird";
    };
    expect((await h.run("stats")).code).toBe(4);
  });
  test("--api and LIANKI_URL pick the site; http is refused except loopback", async () => {
    const h = harness({ env: { ...env, LIANKI_URL: "https://staging.example/" } });
    await h.run("stats");
    expect(h.calls.at(-1)!.path).toBe("/api/fsrs/stats");
    expect((await h.run("stats", "--api", "http://evil.example")).code).toBe(1);
    expect((await h.run("stats", "--api", "http://127.0.0.1:3000")).code).toBe(0);
  });
  test("--token: flag, stdin, and a bad one", async () => {
    const h = harness({ stdin: `${TOKEN}\n` });
    expect((await h.run("stats", "--token", TOKEN)).code).toBe(0);
    expect((await h.run("stats", "--token", "-")).code).toBe(0);
    expect((await h.run("stats", "--token", "lk_short")).code).toBe(1);
    const tty = harness({ tty: true });
    expect((await tty.run("stats", "--token", "-")).code).toBe(1);
    const bad = harness({ stdin: "nope" });
    expect((await bad.run("stats", "--token", "-")).code).toBe(1);
  });
  test("a 0.1.x config.json token still works, and logout removes it", async () => {
    const h = harness();
    mkdirSync(join(h.home, "lianki"), { recursive: true });
    writeFileSync(join(h.home, "lianki", "config.json"), JSON.stringify({ token: TOKEN }));
    expect((await h.run("stats")).code).toBe(0);
    expect((await h.run("auth", "logout")).out).toContain("revoked");
    expect((await h.run("stats")).code).toBe(2);
  });
  test("a 0.1.x token is only sent to the site it was saved for", async () => {
    const h = harness();
    mkdirSync(join(h.home, "lianki"), { recursive: true });
    writeFileSync(
      join(h.home, "lianki", "config.json"),
      JSON.stringify({ token: TOKEN, api: "https://www.lianki.com" }),
    );
    expect((await h.run("stats", "--api", "https://evil.example")).code).toBe(2);
    expect(h.calls.length).toBe(0);
    expect((await h.run("auth", "logout", "--api", "https://evil.example")).out).toBe(
      "not signed in",
    );
    expect((await h.run("stats")).code).toBe(0);
    writeFileSync(
      join(h.home, "lianki", "config.json"),
      JSON.stringify({ token: TOKEN, api: "https://staging.example" }),
    );
    expect((await h.run("stats")).code).toBe(2);
    expect((await h.run("stats", "--api", "https://staging.example")).code).toBe(0);
  });
});

describe("auth", () => {
  test("browser login: loopback, state, PKCE; the token is stored, never printed", async () => {
    const h = harness({ tty: true });
    h.deps.openUrl = (u: string) => {
      const url = new URL(u);
      expect(url.pathname).toBe("/cli-login");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("host")).toBe("test-mac");
      const cb = new URL(url.searchParams.get("redirect_uri")!);
      expect(cb.hostname).toBe("127.0.0.1");
      const state = url.searchParams.get("state")!;
      void (async () => {
        expect((await browserGet(`${cb}?state=wrong&code=x`)).status).toBe(400);
        expect((await browserGet(`${cb.origin}/other`)).status).toBe(404);
        expect((await browserGet(`${cb}?state=${state}&code=onetime`)).body).toContain("Signed in");
      })();
    };
    const r = await h.run("auth", "login", "--json");
    expect(r.code).toBe(0);
    expect(envelope(r.out).data).toEqual({
      site: "lianki.com",
      email: "me@example.com",
      tokenName: "lianki CLI test-mac",
      storage: "keychain",
    });
    const ex = h.calls.find((c) => c.path === "/api/cli-login/token")!;
    expect(ex.auth).toBeNull();
    expect(ex.body.code).toBe("onetime");
    expect(await serverS256(ex.body.code_verifier)).toBe(auth.s256(ex.body.code_verifier));
    expect(h.vault.get("lianki.com")).toBe(TOKEN);
    expect(h.config.read().sites["lianki.com"]).toEqual({
      storage: "keychain",
      email: "me@example.com",
      name: "lianki CLI test-mac",
      tokenId: "hash",
    });
    const s = await h.run("auth", "status");
    expect(s.out).toBe("signed in to lianki.com as me@example.com (token from keychain)");
    expect((await h.run("settings", "get", "words.readAloud")).out).toBe("false");
    const lo = await h.run("auth", "logout", "--json");
    expect(envelope(lo.out).data).toEqual({ site: "lianki.com", revoked: true, forgotten: true });
    expect(h.calls.at(-1)).toMatchObject({ method: "DELETE", auth: `Bearer ${TOKEN}` });
    expect(h.vault.size).toBe(0);
    expect((await h.run("auth", "status")).code).toBe(2);
  });
  test("browser login: denied, and a failed exchange", async () => {
    const deny = harness({ tty: true });
    deny.deps.openUrl = (u: string) => {
      const url = new URL(u);
      void browserGet(
        `${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&error=access_denied`,
      );
    };
    const d = await deny.run("auth", "login");
    expect(d.code).toBe(2);
    expect(d.err).toContain("denied");
    const fail = harness({
      tty: true,
      server: { "POST /api/cli-login/token": () => json({ error: "verifier" }, 400) },
    });
    fail.deps.openUrl = (u: string) => {
      const url = new URL(u);
      void browserGet(
        `${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=c`,
      );
    };
    expect((await fail.run("auth", "login")).code).toBe(5);
    const empty = harness({ tty: true, server: { "POST /api/cli-login/token": () => json({}) } });
    empty.deps.openUrl = fail.deps.openUrl;
    empty.deps.timeoutMs = 50;
    expect((await empty.run("auth", "login", "--no-open", "--browser")).code).toBe(2);
    expect((await empty.run("auth", "login")).code).toBe(4);
  });
  test("browser login: no code, and a timeout", async () => {
    const h = harness({ tty: true });
    h.deps.openUrl = (u: string) => {
      const url = new URL(u);
      void browserGet(
        `${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}`,
      );
    };
    expect((await h.run("auth", "login")).err).toContain("no code");
    const t = harness({ tty: true });
    t.deps.timeoutMs = 50;
    expect((await t.run("auth", "login")).err).toContain("timed out");
  });
  test("without a terminal, login refuses the browser and names the token way", async () => {
    const h = harness();
    const r = await h.run("auth", "login", "--json");
    expect(r.code).toBe(1);
    expect(envelope(r.err).error.hint).toContain("LIANKI_TOKEN");
  });
  test("paste login checks the token first; file storage is 0600", async () => {
    const h = harness({ stdin: TOKEN });
    h.deps.store = auth.tokenStore(h.deps.env);
    const r = await h.run("auth", "login", "--token", "-");
    expect(r.code).toBe(0);
    expect(r.out).toContain("(mode 0600)");
    const file = join(h.home, "lianki", "cli.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).sites["lianki.com"]).toEqual({
      storage: "file",
      user: "u1",
      token: TOKEN,
    });
    expect((await h.run("auth", "status", "--json")).out).toContain('"source":"file"');
    expect((await h.run("auth", "login", "--token", OTHER)).code).toBe(2);
    expect((await h.run("auth", "login", "--token", "lk_x")).code).toBe(1);
    const fromEnv = harness({ env });
    expect((await fromEnv.run("auth", "login")).code).toBe(0);
    expect((await fromEnv.run("auth", "status")).out).toContain("u1");
  });
  test("logout: nothing stored, and a server that cannot revoke", async () => {
    expect((await harness().run("auth", "logout")).out).toBe("not signed in");
    const envOnly = await harness({ env }).run("auth", "logout");
    expect(envOnly.code).toBe(1);
    expect(envOnly.err).toContain('--token "$LIANKI_TOKEN"');
    const explicit = harness({ env });
    const ex = await explicit.run("auth", "logout", "--token", TOKEN, "--json");
    expect(envelope(ex.out).data).toEqual({ site: "lianki.com", revoked: true, forgotten: false });
    expect(explicit.calls.at(-1)).toMatchObject({ method: "DELETE", auth: `Bearer ${TOKEN}` });
    const h = harness({
      stdin: TOKEN,
      server: { "DELETE /api/cli-login/token": () => json({ error: "x" }, 503) },
    });
    await h.run("auth", "login", "--token", "-");
    const r = await h.run("auth", "logout");
    expect(r.code).toBe(4);
    expect(r.out).toContain("could not revoke");
    expect(h.vault.size).toBe(0);
  });
  test("status --json when signed out still prints the envelope", async () => {
    const r = await harness().run("auth", "status", "--json");
    expect(r.code).toBe(2);
    expect(envelope(r.out).data.signedIn).toBe(false);
  });
});

describe("settings", () => {
  test("every key the CLI lists still exists in lib/prefs/schema.ts", () => {
    // A new server key needs no CLI release (the server checks keys); a
    // removed one would leave the published CLI listing a dead setting.
    for (const k of cli.PREF_KEYS) expect(SERVER_PREF_KEYS).toContain(k);
  });
  test("list, get, set with a newer clock under a cli device id", async () => {
    const h = harness({ env });
    const l = await h.run("settings", "list", "--json");
    expect(envelope(l.out).data.settings["words.readAloud"]).toBe(false);
    expect(envelope(l.out).data.settings["ui.paper"]).toBeNull();
    expect((await h.run("settings", "list")).out).toContain("ui.paper = (not set)");
    expect((await h.run("settings", "get", "ui.paper")).out).toBe("(not set)");
    const s = await h.run("settings", "set", "words.readAloud", "true");
    expect(s.out).toBe("words.readAloud = true");
    const op = h.calls.at(-1)!.body.ops[0];
    expect(op.hlc).toMatchObject({ timestamp: 5e12, counter: 3 });
    expect(op.hlc.deviceId).toMatch(/^cli[a-z0-9]{5,37}$/);
    await h.run("settings", "set", "ui.paper", "b");
    expect(h.calls.at(-1)!.body.ops[0].hlc.deviceId).toBe(op.hlc.deviceId);
    expect(h.calls.at(-1)!.body.ops[0].hlc).toMatchObject({ timestamp: 1e12, counter: 0 });
    const bad = await h.run("settings", "set", "ui.paper", "zz", "--json");
    expect(bad.code).toBe(5);
    expect((await h.run("settings", "get", "nope")).code).toBe(3);
    expect((await h.run("settings", "get", "../x")).code).toBe(1);
    h.prefs["future.key"] = { value: 1, hlc: { timestamp: 1, counter: 0, deviceId: "phone0001" } };
    expect(
      envelope((await h.run("settings", "list", "--json")).out).data.settings["future.key"],
    ).toBe(1);
    expect((await h.run("settings", "get", "future.key")).out).toBe("1");
  });
  test("parseValue and nextHlc", () => {
    expect(cli.parseValue("1.25")).toBe(1.25);
    expect(cli.parseValue('["/words"]')).toEqual(["/words"]);
    expect(cli.parseValue("light")).toBe("light");
    expect(cli.nextHlc(undefined, "cliabc123", 10)).toEqual({
      timestamp: 10,
      counter: 0,
      deviceId: "cliabc123",
    });
  });
});

describe("auth.mjs pieces", () => {
  test("PKCE matches the server's", async () => {
    const v = auth.randomId(48);
    expect(v).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(auth.s256(v)).toBe(await serverS256(v));
    expect(auth.sameString("a", "a")).toBe(true);
    expect(auth.sameString("a", "ab")).toBe(false);
  });
  test("config file: bad JSON reads empty; keychain off when disabled", () => {
    const d = tmp();
    mkdirSync(join(d, "lianki"));
    writeFileSync(join(d, "lianki", "cli.json"), "{nope");
    writeFileSync(join(d, "lianki", "config.json"), "{nope");
    const c = auth.fileConfig({ XDG_CONFIG_HOME: d });
    expect(c.read()).toEqual({ sites: {} });
    expect(c.legacyToken()).toBeNull();
    expect(c.dropLegacy()).toBe(true);
    expect(c.dropLegacy()).toBe(false);
    const kc = auth.keychain({ LIANKI_NO_KEYCHAIN: "1" });
    expect(kc.available()).toBe(false);
    expect(kc.get("lianki.com")).toBeNull();
    expect(kc.set("lianki.com", TOKEN)).toBe(false);
    kc.delete("lianki.com");
  });
  test("tokenStore falls back to the file and reads it back", async () => {
    const s = auth.tokenStore({ LIANKI_NO_KEYCHAIN: "1" });
    expect(await s.set("lianki.com", TOKEN)).toBe("file");
    expect(await s.get("lianki.com", { storage: "file", token: TOKEN })).toBe(TOKEN);
    expect(await s.get("lianki.com", { storage: "file", token: "x" })).toBeNull();
    expect(await s.get("lianki.com", { storage: "keychain" })).toBeNull();
    await s.delete("lianki.com");
  });
});

describe("Keychain and browser, with the Mac faked", () => {
  test("the token goes on security's stdin, never in its arguments", async () => {
    const runs: { args: string[]; input?: string }[] = [];
    let stored: string | null = null;
    const sys = {
      platform: "darwin",
      exists: () => true,
      run: (args: string[], input?: string) => {
        runs.push({ args, input });
        if (args[0] === "-i") stored = /-w "(lk_[0-9a-f]+)"/.exec(input ?? "")?.[1] ?? null;
        if (args[0] === "delete-generic-password") stored = null;
        if (args[0] === "find-generic-password")
          return { ok: stored !== null, out: stored ? `${stored}\n` : "" };
        return { ok: true, out: "" };
      },
    };
    const s = auth.tokenStore({}, sys);
    expect(await s.set("lianki.com", TOKEN)).toBe("keychain");
    expect(await s.get("lianki.com", { storage: "keychain" })).toBe(TOKEN);
    await s.delete("lianki.com");
    expect(await s.get("lianki.com", { storage: "keychain" })).toBeNull();
    expect(await s.set("bad host!", TOKEN)).toBe("file");
    for (const r of runs) expect(r.args.join(" ")).not.toContain(TOKEN);
    expect(runs[0]).toMatchObject({ args: ["-i"] });
    expect(auth.keychain({}, { ...sys, platform: "linux" }).available()).toBe(false);
  });
  test("openUrl picks the platform's opener", () => {
    const seen: string[] = [];
    const spawn = (cmd: string, args: string[]) => (
      seen.push([cmd, ...args].join(" ")), { status: 0 }
    );
    expect(auth.openUrl("https://x.example/", "darwin", spawn)).toBe(true);
    auth.openUrl("https://x.example/", "win32", spawn);
    auth.openUrl("https://x.example/", "linux", spawn);
    expect(seen).toEqual([
      "open https://x.example/",
      "rundll32 url.dll,FileProtocolHandler https://x.example/",
      "xdg-open https://x.example/",
    ]);
    expect(
      auth.openUrl("https://x.example/", "linux", () => {
        throw new Error("no xdg-open");
      }),
    ).toBe(false);
  });
});

test("no command ever printed a token", () => {
  for (const line of printed) {
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain(OTHER);
    expect(line).not.toMatch(/lk_[0-9a-f]{64}/);
  }
  expect(printed.length).toBeGreaterThan(20);
});

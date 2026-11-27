// The npm package `lianki` (packages/lianki-cli): every command against a fake
// Lianki, the browser login against a real loopback listener, the token file,
// the JSON envelope and exit codes, and that no command ever prints the token.
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { request } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { PREF_KEYS as SERVER_PREF_KEYS } from "@/lib/prefs/schema";
import { s256 as serverS256 } from "@/lib/cli-login";
import * as cliMod from "../packages/lianki-cli/cli.mjs";
import * as authMod from "../packages/lianki-cli/auth.mjs";
import { MAX_ERROR_BYTES } from "../packages/lianki-cli/api.mjs";
import { RECORDING_MAX_BYTES } from "../packages/lianki-cli/recordings.mjs";

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

describe("chat (your own thread, with a chat token)", () => {
  const chatServer = (seen: Call[]) => ({
    "POST /api/version/chat": (c: Call) => {
      seen.push(c);
      if (c.auth !== `Bearer ${TOKEN}`) return json({ ok: false, error: "unknown" }, 401);
      if (c.body.op === "say") return json({ ok: true, id: "m1", lane: "codex" });
      if (c.body.op === "ask") return json({ ok: true, id: "m2", askId: "a1", lane: "codex" });
      if (c.body.op === "read")
        return json({
          ok: true,
          thread: "owner",
          lane: "codex",
          messages: [{ id: "m1", from: "agent", label: "codex", text: "【codex】hi", at: 0 }],
        });
      return json({ ok: false, error: "bad request" }, 400);
    },
  });

  /** A WebSocket that plays the hub: ready after the token, then asked and answered. */
  function fakeWs(sent: unknown[], opts: { refuse?: string } = {}) {
    return class {
      onopen?: () => void;
      onmessage?: (e: { data: string }) => void;
      onclose?: (e: { code: number; reason: string }) => void;
      onerror?: () => void;
      constructor(public url: string) {
        queueMicrotask(() => this.onopen?.());
      }
      send(s: string) {
        const m = JSON.parse(s);
        sent.push(m);
        const reply = (x: unknown) =>
          queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(x) }));
        if (m.type === "auth") {
          if (opts.refuse) return reply({ type: "error", error: opts.refuse });
          reply({ type: "ready", lane: "codex", thread: "owner" });
          reply({
            type: "chat",
            message: { id: "x", from: "owner", label: "", text: "live", at: 0 },
          });
        }
        if (m.type === "ask") {
          reply({ type: "asked", id: "m2", askId: "a9" });
          reply({
            type: "answered",
            askId: "other",
            labels: { q1: ["No"] },
            answer: { choices: {} },
          });
          reply({
            type: "answered",
            askId: "a9",
            labels: { q1: ["Yes"] },
            answer: { choices: { q1: ["o1"] }, at: 5 },
          });
        }
      }
      close() {}
    };
  }

  test("say posts to the chat endpoint with the token, never in the URL", async () => {
    const seen: Call[] = [];
    const h = harness({ env, server: chatServer(seen) });
    const r = await h.run("chat", "say", "PR", "#12", "is", "green", "--json");
    expect(r.code).toBe(0);
    expect(envelope(r.out)).toMatchObject({
      ok: true,
      command: "chat say",
      data: { id: "m1", lane: "codex" },
    });
    expect(seen[0]!.body).toEqual({ op: "say", text: "PR #12 is green" });
    expect(seen[0]!.query).toBe("");
    expect((await h.run("chat", "say", "fyi", "--quiet")).out).toBe("sent m1 as 【codex】");
    expect(seen[1]!.body.quiet).toBe(true);
  });

  test("say --supersede / --interject send cut; both at once is a usage error, nothing sent", async () => {
    const seen: Call[] = [];
    const h = harness({ env, server: chatServer(seen), stdin: "moot\n" });
    expect((await h.run("chat", "say", "--supersede", "-")).code).toBe(0);
    expect(seen[0]!.body).toEqual({ op: "say", text: "moot", cut: "supersede" });
    expect((await h.run("chat", "say", "urgent", "--interject")).code).toBe(0);
    expect(seen[1]!.body).toEqual({ op: "say", text: "urgent", cut: "interject" });
    expect((await h.run("chat", "say", "x", "--supersede", "--interject")).code).not.toBe(0);
    expect(seen).toHaveLength(2);
  });

  test("say --play sends the audio with the line; a bad src is a usage error before any call", async () => {
    const seen: Call[] = [];
    const h = harness({ env, server: chatServer(seen) });
    const r = await h.run(
      "chat",
      "say",
      "--play",
      "https://cdn.example.com/a.mp3",
      "--title",
      "L3",
      "listen",
    );
    expect(r.code).toBe(0);
    expect(seen[0]!.body).toEqual({
      op: "say",
      text: "listen",
      play: { src: "https://cdn.example.com/a.mp3", title: "L3" },
    });
    const bad = await h.run("chat", "say", "--play", "http://cdn.example.com/a.mp3", "x");
    expect(bad.code).toBe(1);
    expect(seen.length).toBe(1);
  });

  test("say - reads the line from stdin (yargs alone drops a bare -)", async () => {
    const seen: Call[] = [];
    const h = harness({ env, server: chatServer(seen), stdin: "  -starts with a dash\n" });
    expect((await h.run("chat", "say", "-")).code).toBe(0);
    expect(seen[0]!.body).toEqual({ op: "say", text: "-starts with a dash" });
    expect((await h.run("chat", "say", "--quiet", "-")).code).toBe(0);
    expect((await h.run("chat", "send", "-")).code).toBe(0);
    expect(seen.at(-1)!.body).toMatchObject({ op: "say", text: "-starts with a dash" });
    expect(seen[1]!.body).toMatchObject({ text: "-starts with a dash", quiet: true });
    const both = await h.run("chat", "say", "-", "extra");
    expect(both.code).not.toBe(0);
    expect(seen).toHaveLength(3);
  });

  test("read and ask without --wait", async () => {
    const seen: Call[] = [];
    const h = harness({ env, server: chatServer(seen) });
    const r = await h.run("chat", "read", "--limit", "5", "--json");
    expect(envelope(r.out).data.messages[0].text).toBe("【codex】hi");
    expect(seen[0]!.body).toEqual({ op: "read", limit: 5 });
    const a = await h.run(
      "chat",
      "ask",
      "--q",
      "Ship it?",
      "--opt",
      "Yes",
      "--opt",
      "No",
      "--recommend",
      "1",
      "--json",
    );
    expect(envelope(a.out).data).toMatchObject({ askId: "a1", answer: null });
    expect(seen[1]!.body).toEqual({
      op: "ask",
      question: "Ship it?",
      options: [{ label: "Yes", recommended: true }, { label: "No" }],
    });
    expect((await h.run("chat", "ask", "--opt", "Yes")).code).toBe(1);
  });

  test("ask --wait: the token goes in the socket's first message; prints the tapped answer", async () => {
    const sent: any[] = [];
    const h = harness({ env });
    (h.deps as any).WebSocket = fakeWs(sent);
    const r = await h.run(
      "chat",
      "ask",
      "--q",
      "Ship it?",
      "--opt",
      "Yes",
      "--opt",
      "No",
      "--wait",
    );
    expect(r.code).toBe(0);
    expect(r.out).toBe("Yes");
    // An ask's wait is a reader in the hub's lane registry, never a resident listener.
    expect(sent[0]).toEqual({ type: "auth", token: TOKEN, mode: "reader" });
    expect(sent[1]).toMatchObject({ type: "ask", question: "Ship it?" });
  });

  test("listen streams lines; a refused token exits 2 with the reason", async () => {
    const sent: any[] = [];
    const h = harness({ env });
    (h.deps as any).WebSocket = fakeWs(sent, { refuse: "scope" });
    const r = await h.run("chat", "listen", "--json");
    expect(r.code).toBe(2);
    expect(envelope(r.err).error.code).toBe("auth_refused");
    expect(envelope(r.err).error.message).toContain("scope");
  });

  test("a 403 scope refusal over HTTP names the permission problem", async () => {
    const h = harness({
      env,
      server: { "POST /api/version/chat": () => json({ ok: false, error: "scope" }, 403) },
    });
    const r = await h.run("chat", "say", "x", "--json");
    expect(r.code).toBe(2);
    expect(envelope(r.err).error).toMatchObject({ code: "auth_refused" });
    expect(envelope(r.err).error.hint).toContain("permission");
  });

  test("prepare uses the account token without posting, and validates its text", async () => {
    const seen: Call[] = [];
    const verdict = { v: 1, action: "forward", turn: "complete", polished: "不要删除按钮。" };
    const h = harness({
      env,
      server: {
        "POST /api/version/chat": (c) => {
          seen.push(c);
          return json({ ok: true, verdict, charged: 0 });
        },
      },
    });
    const r = await h.run(
      "chat",
      "prepare",
      "不要删除按钮",
      "--context",
      "请修改按钮颜色",
      "--json",
    );
    expect(r.code).toBe(0);
    expect(envelope(r.out)).toMatchObject({
      command: "chat prepare",
      data: { verdict, charged: 0 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      auth: `Bearer ${TOKEN}`,
      query: "",
      body: {
        op: "prepare",
        input: { v: 1, text: "不要删除按钮", context: [{ from: "user", text: "请修改按钮颜色" }] },
      },
    });
    expect(seen[0]!.body.input.requestId).toBeString();
    expect((await h.run("chat", "prepare", "", "--json")).code).toBe(1);
    expect((await h.run("chat", "prepare", "x".repeat(6001), "--json")).code).toBe(1);
    expect(seen).toHaveLength(1);
  });

  test("read formats its human output with the lane and time", async () => {
    const h = harness({ env, server: chatServer([]) });
    expect((await h.run("chat", "read")).out).toBe("1970-01-01 00:00:00  codex: 【codex】hi");
  });

  test("listen streams history, live lines and card answers until its token is revoked", async () => {
    const old = { id: "old", from: "agent", label: "codex", text: "earlier", at: 0 };
    const live = { id: "new", from: "owner", text: "please continue", at: 1000 };
    const answered = { type: "answered", askId: "a1", answer: { choices: { q1: ["o1"] } } };
    for (const machine of [false, true]) {
      const h = harness({ env });
      const sent: any[] = [];
      let closed = false;
      (h.deps as any).WebSocket = class {
        onopen?: () => void;
        onmessage?: (e: { data: string }) => void;
        constructor() {
          queueMicrotask(() => this.onopen?.());
        }
        send(raw: string) {
          sent.push(JSON.parse(raw));
          for (const event of [
            "malformed frame",
            JSON.stringify({ type: "ready", thread: "owner" }),
            JSON.stringify({ type: "history", messages: [old] }),
            JSON.stringify({ type: "chat", message: live }),
            JSON.stringify(answered),
            JSON.stringify({ type: "revoked" }),
          ])
            queueMicrotask(() => this.onmessage?.({ data: event }));
        }
        close() {
          closed = true;
        }
      };
      const r = await h.run("chat", "listen", "--history", "2", ...(machine ? ["--json"] : []));
      expect(r.code).toBe(2);
      expect(closed).toBe(true);
      // `chat listen` is a resident listener (lane-registry.ts).
      expect(sent).toEqual([{ type: "auth", token: TOKEN, history: 2, mode: "listener" }]);
      if (machine) {
        const events = r.out.split("\n").map((x) => JSON.parse(x));
        expect(events).toContainEqual({ type: "chat", message: old, history: true });
        expect(events).toContainEqual({ type: "chat", message: live });
        expect(events).toContainEqual(answered);
        expect(envelope(r.err).error.code).toBe("auth_refused");
      } else {
        expect(r.out).toContain("1970-01-01 00:00:00  codex: earlier");
        expect(r.out).toContain("1970-01-01 00:00:01  owner: please continue");
        expect(r.out).toContain(JSON.stringify(answered));
        expect(r.err).toContain("revoked");
      }
      expect(r.out).not.toContain("malformed frame");
    }
  });

  test("listen --everyone tells the hub its agent hears every line (scope all); --reader never", async () => {
    for (const [args, want] of [
      [["--everyone"], { type: "auth", token: TOKEN, mode: "listener", scope: "all" }],
      [["--everyone", "--reader"], { type: "auth", token: TOKEN, mode: "reader" }],
      // Tier ⓪: the system notices too (owner, 2026-11-16 02:16 JST).
      [
        ["--everyone", "--system"],
        { type: "auth", token: TOKEN, mode: "listener", scope: "system" },
      ],
      [["--system", "--reader"], { type: "auth", token: TOKEN, mode: "reader" }],
    ] as const) {
      const h = harness({ env });
      const sent: any[] = [];
      (h.deps as any).WebSocket = class {
        onopen?: () => void;
        onmessage?: (e: { data: string }) => void;
        constructor() {
          queueMicrotask(() => this.onopen?.());
        }
        send(raw: string) {
          sent.push(JSON.parse(raw));
          queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "revoked" }) }));
        }
        close() {}
      };
      await h.run("chat", "listen", "--json", ...args);
      expect(sent).toEqual([want]);
    }
  });

  test("listen reports a closed socket as auth or network failure instead of hanging", async () => {
    for (const closeCode of [4401, 1006]) {
      const h = harness({ env });
      let closed = false;
      (h.deps as any).WebSocket = class {
        onopen?: () => void;
        onerror?: () => void;
        onclose?: (event: { code: number; reason: string }) => void;
        constructor() {
          queueMicrotask(() => this.onopen?.());
        }
        send() {
          queueMicrotask(() => {
            this.onerror?.();
            this.onclose?.({ code: closeCode, reason: "disconnected" });
          });
        }
        close() {
          closed = true;
        }
      };
      const r = await h.run("chat", "listen", "--json");
      expect(r.code).toBe(closeCode === 4401 ? 2 : 4);
      expect(envelope(r.err).error.code).toBe(closeCode === 4401 ? "auth_refused" : "network");
      expect(envelope(r.err).error.message).toContain("disconnected");
      expect(closed).toBe(true);
    }
  });

  test("listen pings; a socket that stops answering is dead (exit 4, lane-listen reconnects)", async () => {
    for (const answers of [true, false]) {
      const h = harness({ env: { ...env, LIANKI_CHAT_PING_MS: "20" } });
      const sent: unknown[] = [];
      let closed = false;
      (h.deps as any).WebSocket = class {
        onopen?: () => void;
        onmessage?: (e: { data: string }) => void;
        constructor() {
          queueMicrotask(() => this.onopen?.());
        }
        send(raw: string) {
          sent.push(raw);
          if (raw === "ping") {
            // The hub's auto-response, until the connection drops unseen; then a revoke ends it.
            if (answers && sent.filter((x) => x === "ping").length < 4)
              queueMicrotask(() => this.onmessage?.({ data: "pong" }));
            else if (answers)
              queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "revoked" }) }));
          } else
            queueMicrotask(() =>
              this.onmessage?.({ data: JSON.stringify({ type: "ready", thread: "owner" }) }),
            );
        }
        close() {
          closed = true;
        }
      };
      const r = await h.run("chat", "listen", "--json");
      expect(closed).toBe(true);
      expect(sent.filter((x) => x === "ping").length).toBeGreaterThanOrEqual(answers ? 4 : 1);
      if (answers) expect(r.code).toBe(2);
      else {
        expect(r.code).toBe(4);
        expect(envelope(r.err).error.code).toBe("network");
        expect(envelope(r.err).error.message).toContain("went silent");
      }
      // The pongs are not events.
      expect(r.out).not.toContain("pong");
    }
  });

  test("there is no eval, pair or grant command", async () => {
    const h = harness({ env });
    for (const c of ["eval", "pair", "grant", "serve"])
      expect((await h.run("chat", c)).code).toBe(1);
    expect((await h.run("eval", "1+1")).code).toBe(1);
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

describe("mini-app publishing", () => {
  test("publishes local inputs once without posting chat", async () => {
    const dir = tmp();
    const manifest = join(dir, "manifest.json"),
      html = join(dir, "app.html");
    writeFileSync(manifest, JSON.stringify({ slug: "clock", name: "Clock" }));
    writeFileSync(html, "<!doctype html><p>clock</p>");
    const h = harness({
      env,
      server: { "POST /api/my/mini-apps": () => json({ slug: "clock", url: "/m/clock" }, 201) },
    });
    const result = await h.run("app", "publish", "--manifest", manifest, "--html", html, "--json");
    expect(result.code).toBe(0);
    expect(envelope(result.out).data.url).toBe("/m/clock");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body).toEqual({
      manifest: { slug: "clock", name: "Clock" },
      html: "<!doctype html><p>clock</p>",
    });
    writeFileSync(manifest, "[]");
    expect((await h.run("app", "publish", "--manifest", manifest, "--html", html)).code).toBe(1);
    expect(h.calls).toHaveLength(1);
  });
  test("chat app reference can be sent without separate text", async () => {
    const h = harness({
      env,
      server: { "POST /api/version/chat": () => json({ id: "app-message" }) },
    });
    expect((await h.run("chat", "say", "--app", "clock")).code).toBe(0);
    expect(h.calls.at(-1)?.body).toMatchObject({
      op: "say",
      text: "/m/clock",
      attachments: [{ type: "app", slug: "clock" }],
    });
    expect((await h.run("chat", "say", "--app", "../bad")).code).toBe(1);
  });
});

test("publish scope refusals carry only a public approval link", async () => {
  const dir = tmp(),
    manifest = join(dir, "manifest.json"),
    html = join(dir, "app.html");
  writeFileSync(manifest, "{}");
  writeFileSync(html, "<p>app</p>");
  const requestUrl = `https://lianki.com/my/tokens/scopes?token=${"b".repeat(64)}&scope=apps%3Apublish`;
  for (const link of [requestUrl, `https://evil.example/?token=${TOKEN}`]) {
    const h = harness({
      env,
      server: {
        "POST /api/my/mini-apps": () =>
          json({ error: "scope", needScope: "apps:publish", requestUrl: link }, 403),
      },
    });
    const result = await h.run("app", "publish", "--manifest", manifest, "--html", html, "--json");
    expect(result.code).toBe(2);
    const error = JSON.parse(result.err).error;
    if (link === requestUrl) {
      expect(error.needScope).toBe("apps:publish");
      expect(error.requestUrl).toBe(requestUrl);
    } else {
      expect(error.requestUrl).toBeUndefined();
      expect(result.err).not.toContain(TOKEN);
    }
  }
});

describe("chat attachment get", () => {
  const ID = "0123456789abcdef0123";
  const TICKET = "ab".repeat(32);
  test("asks for a ticket, downloads with it in a header, saves under the file's own name, never prints it", async () => {
    const h = harness({
      env,
      server: {
        "POST /api/version/chat": (c) =>
          c.body.op === "attachment" && c.body.id === ID
            ? json({
                ok: true,
                item: { id: ID, name: "../photo.png", type: "image/png", size: 3 },
                ticket: TICKET,
                exp: 1,
                path: `/api/my/inbox/${ID}`,
                header: "x-inbox-ticket",
              })
            : json({ ok: false, error: "no such attachment in this chat" }, 404),
        [`GET /api/my/inbox/${ID}`]: () => new Response(new Uint8Array([1, 2, 3])),
      },
    });
    const sentHeaders: Record<string, string>[] = [];
    const inner = h.deps.fetch;
    h.deps.fetch = async (u: URL, init: any = {}) => {
      if (String(u).includes("/api/my/inbox/")) sentHeaders.push(init.headers ?? {});
      return inner(u, init);
    };
    const written: { file: string; bytes: Uint8Array }[] = [];
    (h.deps as any).writeFile = async (file: string, bytes: Uint8Array) =>
      void written.push({ file, bytes });
    const r = await h.run("chat", "attachment", "get", ID, "--out", "/tmp/li", "--json");
    expect(r.code).toBe(0);
    expect(sentHeaders).toEqual([{ "x-inbox-ticket": TICKET }]);
    // No folders from the server's name: "../photo.png" stays inside --out.
    expect(written).toEqual([
      { file: `/tmp/li/${ID}-_photo.png`, bytes: new Uint8Array([1, 2, 3]) },
    ]);
    expect(envelope(r.out).data).toMatchObject({ id: ID, type: "image/png", size: 3 });
    expect(r.out + r.err).not.toContain(TICKET);
  });

  /** A server whose file is called `name` (the sender's choice) and holds 7, 8, 9. */
  const named = (name: string) =>
    harness({
      env,
      server: {
        "POST /api/version/chat": () =>
          json({
            ok: true,
            item: { id: ID, name, type: "image/png", size: 3 },
            ticket: TICKET,
            exp: 1,
            path: `/api/my/inbox/${ID}`,
            header: "x-inbox-ticket",
          }),
        [`GET /api/my/inbox/${ID}`]: () => new Response(new Uint8Array([7, 8, 9])),
      },
    });

  test("without a writer of its own it saves to disk, making --out", async () => {
    const out = join(tmp(), "new", "dir");
    expect((await named("photo.png").run("chat", "attachment", "get", ID, "--out", out)).code).toBe(
      0,
    );
    expect([...readFileSync(join(out, `${ID}-photo.png`))]).toEqual([7, 8, 9]);
  });

  test("a sender's name never overwrites a file: an existing same-name file keeps its bytes", async () => {
    const out = tmp();
    // The plain name (package.json in the cwd) is untouched: the download is id-prefixed.
    writeFileSync(join(out, "package.json"), "SENTINEL");
    expect(
      (await named("package.json").run("chat", "attachment", "get", ID, "--out", out)).code,
    ).toBe(0);
    expect(readFileSync(join(out, "package.json"), "utf8")).toBe("SENTINEL");
    expect([...readFileSync(join(out, `${ID}-package.json`))]).toEqual([7, 8, 9]);
    // Even the prefixed name is never clobbered: a second download fails and keeps the file.
    writeFileSync(join(out, `${ID}-package.json`), "SENTINEL2");
    const again = await named("package.json").run("chat", "attachment", "get", ID, "--out", out);
    expect(again.code).not.toBe(0);
    expect(again.err).toContain("already exists");
    expect(readFileSync(join(out, `${ID}-package.json`), "utf8")).toBe("SENTINEL2");
  });

  test("nothing is written outside --out, whatever the name", async () => {
    const root = tmp();
    const out = join(root, "out");
    mkdirSync(out);
    for (const name of ["../../evil.sh", "..", "/etc/passwd", "a\\..\\..\\b", ".env"]) {
      const r = await named(name).run("chat", "attachment", "get", ID, "--out", out);
      expect(r.code).toBe(0);
      const saved = readdirSync(out);
      expect(saved).toHaveLength(1);
      expect(saved[0].startsWith(`${ID}-`)).toBe(true);
      expect(readdirSync(root)).toEqual(["out"]);
      rmSync(join(out, saved[0]));
    }
  });

  test("a bad id never reaches the server; a refusal is an error", async () => {
    const h = harness({
      env,
      server: {
        "POST /api/version/chat": () =>
          json({ ok: false, error: "no such attachment in this chat" }, 404),
      },
    });
    expect((await h.run("chat", "attachment", "get", "../x")).code).not.toBe(0);
    expect(h.calls).toHaveLength(0);
    expect((await h.run("chat", "attachment", "get", ID)).code).not.toBe(0);
  });
});

describe("recordings", () => {
  const CLIP_ID = "rec_clip_0123456789ab";
  // Synthetic 48-byte RIFF/WAVE header + 4 zero PCM bytes (no mic, no playback).
  const SYNTH_WAV = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x28, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const SAMPLE_CLIP = {
    id: CLIP_ID,
    day: "2026-11-27",
    at: Date.parse("2026-11-27T12:00:00Z"),
    durationMs: 2400,
    bytes: SYNTH_WAV.length,
    mode: "active",
    source: "local",
    device: "mac",
    speaker: "me",
    text: "synthetic test transcript",
    extraServerField: "dropped",
  };

  test("list supports default limit, --limit/--before, --day and human output", async () => {
    const h = harness({
      env,
      server: {
        "GET /api/my/recordings": (c) => {
          const p = new URLSearchParams(c.query);
          if (p.has("day")) return json({ day: p.get("day"), clips: [SAMPLE_CLIP] });
          return json({ clips: [SAMPLE_CLIP], more: true });
        },
      },
    });
    const def = await h.run("recordings", "list", "--json");
    expect(def.code).toBe(0);
    expect(h.calls.at(-1)).toMatchObject({
      method: "GET",
      path: "/api/my/recordings",
      query: "?limit=20",
      auth: `Bearer ${TOKEN}`,
    });
    expect(envelope(def.out)).toEqual({
      v: 1,
      ok: true,
      command: "recordings list",
      data: {
        clips: [
          {
            id: CLIP_ID,
            day: "2026-11-27",
            at: SAMPLE_CLIP.at,
            durationMs: 2400,
            bytes: SYNTH_WAV.length,
            mode: "active",
            source: "local",
            device: "mac",
            speaker: "me",
            text: "synthetic test transcript",
          },
        ],
        more: true,
      },
    });

    const paged = await h.run(
      "recordings",
      "list",
      "--limit",
      "5",
      "--before",
      "1700000000000",
      "--json",
    );
    expect(paged.code).toBe(0);
    expect(h.calls.at(-1)?.query).toBe("?before=1700000000000&limit=5");

    const byDay = await h.run("recordings", "list", "--day", "2026-11-27", "--json");
    expect(byDay.code).toBe(0);
    expect(h.calls.at(-1)?.query).toBe("?day=2026-11-27");
    expect(envelope(byDay.out).data).toMatchObject({ day: "2026-11-27" });
    expect(envelope(byDay.out).data.more).toBeUndefined();

    const human = await h.run("recordings", "list");
    expect(human.code).toBe(0);
    expect(human.out).toContain(CLIP_ID);
    expect(human.out).toContain("[me]");
    expect(human.out).toContain("synthetic test transcript");
    expect(def.out + paged.out + byDay.out + human.out).not.toContain(TOKEN);
  });

  test("list rejects invalid --day or combining --day with --limit/--before (exit 1, no request)", async () => {
    const h = harness({
      env,
      server: { "GET /api/my/recordings": () => json({ clips: [], more: false }) },
    });
    for (const args of [
      ["recordings", "list", "--day", "2026-02-30", "--json"],
      ["recordings", "list", "--day", "not-a-day", "--json"],
      ["recordings", "list", "--day", "2026-11-27", "--limit", "5", "--json"],
      ["recordings", "list", "--day", "2026-11-27", "--before", "1000", "--json"],
      ["recordings", "list", "--limit", "0", "--json"],
      ["recordings", "list", "--limit", "201", "--json"],
      ["recordings", "list", "--before", "-1", "--json"],
    ]) {
      const r = await h.run(...args);
      expect(r.code).toBe(1);
      expect(envelope(r.err).error.code).toBe("usage");
    }
    expect(h.calls).toHaveLength(0);
  });

  test("get fetches synthetic WAV with accept: audio/wav, writes with wx, refuses EEXIST (exit 5), never leaks token", async () => {
    const sentHeaders: Record<string, string>[] = [];
    const h = harness({
      env,
      server: {
        "GET /api/my/recordings": (c) => {
          const p = new URLSearchParams(c.query);
          if (p.get("clip") !== CLIP_ID) return json({ error: "not-found" }, 404);
          return new Response(SYNTH_WAV, {
            status: 200,
            headers: {
              "content-type": "audio/wav; charset=binary",
              "content-length": String(SYNTH_WAV.length),
            },
          });
        },
      },
    });
    const inner = h.deps.fetch;
    h.deps.fetch = async (u: URL, init: any = {}) => {
      sentHeaders.push(init.headers ?? {});
      return inner(u, init);
    };

    const out = join(tmp(), "recs");
    const first = await h.run("recordings", "get", CLIP_ID, "--out", out, "--json");
    expect(first.code).toBe(0);
    expect(sentHeaders[0]).toMatchObject({
      accept: "audio/wav",
      authorization: `Bearer ${TOKEN}`,
    });
    const file = join(out, `${CLIP_ID}.wav`);
    expect(envelope(first.out)).toEqual({
      v: 1,
      ok: true,
      command: "recordings get",
      data: { id: CLIP_ID, mimeType: "audio/wav", bytes: SYNTH_WAV.length, file },
    });
    expect(new Uint8Array(readFileSync(file))).toEqual(SYNTH_WAV);
    expect(first.out + first.err).not.toContain(TOKEN);

    // Existing file is never overwritten (flag: "wx" -> EEXIST -> exit 5).
    writeFileSync(file, "KEEP");
    const second = await h.run("recordings", "get", CLIP_ID, "--out", out, "--json");
    expect(second.code).toBe(5);
    expect(envelope(second.err).error.code).toBe("exists");
    expect(readFileSync(file, "utf8")).toBe("KEEP");
    expect(second.out + second.err).not.toContain(TOKEN);
  });

  test("get rejects bad id (exit 1) and oversized responses (> 1,300,000 bytes)", async () => {
    let bodyRead = false;
    const h = harness({
      env,
      server: {
        "GET /api/my/recordings": (c) => {
          const clip = new URLSearchParams(c.query).get("clip");
          if (clip === "header_too_large_0001") {
            return {
              status: 200,
              headers: new Headers({
                "content-type": "audio/wav",
                "content-length": "1300001",
              }),
              body: {
                cancel: async () => {
                  throw new Error("cancel failed");
                },
              },
              arrayBuffer: async () => {
                bodyRead = true;
                return new ArrayBuffer(0);
              },
            } as unknown as Response;
          }
          return new Response(new Uint8Array(1_300_001), {
            status: 200,
            headers: { "content-type": "audio/wav" },
          });
        },
      },
    });
    const bad = await h.run("recordings", "get", "../bad-id", "--json");
    expect(bad.code).toBe(1);
    expect(envelope(bad.err).error.code).toBe("usage");
    expect(h.calls).toHaveLength(0);

    const byHeader = await h.run("recordings", "get", "header_too_large_0001", "--json");
    expect(byHeader.code).toBe(4);
    expect(bodyRead).toBe(false);
    expect(byHeader.out + byHeader.err).not.toContain(TOKEN);

    const byBody = await h.run("recordings", "get", "body_too_large_000001", "--json");
    expect(byBody.code).toBe(4);
    expect(byBody.out + byBody.err).not.toContain(TOKEN);
  });

  test("get maps network errors, non-JSON HTTP errors, 404, malformed scope URLs and empty audio", async () => {
    const net = harness({ env });
    net.deps.fetch = async () => {
      throw new Error("offline");
    };
    const netRes = await net.run("recordings", "get", CLIP_ID, "--json");
    expect(netRes.code).toBe(4);
    expect(envelope(netRes.err).error.code).toBe("network");

    const http = harness({
      env,
      server: {
        "GET /api/my/recordings": (c) => {
          const clip = new URLSearchParams(c.query).get("clip");
          if (clip === "plain_502_0000000001") return new Response("bad gateway", { status: 502 });
          if (clip === "missing_clip_0000001") return json({ error: "not-found" }, 404);
          if (clip === "bad_scope_url_000001")
            return json(
              { error: "scope", needScope: "recordings:read", requestUrl: "not-a-valid-url" },
              403,
            );
          return new Response(new Uint8Array(0), {
            status: 200,
            headers: { "content-type": "audio/wav" },
          });
        },
      },
    });
    const err502 = await http.run("recordings", "get", "plain_502_0000000001", "--json");
    expect(err502.code).toBe(4);
    expect(envelope(err502.err).error.code).toBe("server");

    const err404 = await http.run("recordings", "get", "missing_clip_0000001", "--json");
    expect(err404.code).toBe(3);
    expect(envelope(err404.err).error.code).toBe("not_found");

    const errScope = await http.run("recordings", "get", "bad_scope_url_000001", "--json");
    expect(errScope.code).toBe(2);
    expect(envelope(errScope.err).error.code).toBe("auth_refused");
    expect(envelope(errScope.err).error.requestUrl).toBeUndefined();

    const empty = await http.run("recordings", "get", "empty_audio_00000001", "--json");
    expect(empty.code).toBe(4);
    expect(envelope(empty.err).error.code).toBe("server");
  });

  test("callBytes aborts an endless stream at maxBytes without buffering or writing a file", async () => {
    const CHUNK = 200_000;
    let pulls = 0;
    let canceled = false;
    let signal: AbortSignal | undefined;
    const h = harness({
      env,
      server: {
        "GET /api/my/recordings": () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulls += 1;
                controller.enqueue(new Uint8Array(CHUNK));
              },
              cancel() {
                canceled = true;
              },
            }),
            { status: 200, headers: { "content-type": "audio/wav" } },
          ),
      },
    });
    const inner = h.deps.fetch;
    h.deps.fetch = async (u: URL, init: any = {}) => {
      signal = init.signal;
      return inner(u, init);
    };

    const out = join(tmp(), "endless-out");
    const r = await h.run("recordings", "get", "endless_stream_00001", "--out", out, "--json");
    expect(r.code).toBe(4);
    expect(envelope(r.err).error.code).toBe("server");
    expect(envelope(r.err).error.message).toContain(String(RECORDING_MAX_BYTES));
    expect(canceled).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(pulls).toBeLessThanOrEqual(Math.ceil(RECORDING_MAX_BYTES / CHUNK) + 1);
    expect(existsSync(join(out, "endless_stream_00001.wav"))).toBe(false);
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  test("callBytes caps and trims endless or oversized error bodies and handles multi-chunk and non-stream responses", async () => {
    const ERR_CHUNK = 5_000;
    let errPulls = 0;
    let errCanceled = false;
    let errSignal: AbortSignal | undefined;
    let fallbackSignal: AbortSignal | undefined;
    const h = harness({
      env,
      server: {
        "GET /api/my/recordings": (c) => {
          const clip = new URLSearchParams(c.query).get("clip");
          if (clip === "huge_error_body_0001") {
            return new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  errPulls += 1;
                  const text =
                    errPulls === 1
                      ? `   <html>  502 Bad Gateway   ${"x".repeat(ERR_CHUNK)}`
                      : "y".repeat(ERR_CHUNK);
                  controller.enqueue(new TextEncoder().encode(text.slice(0, ERR_CHUNK)));
                },
                cancel() {
                  errCanceled = true;
                },
              }),
              { status: 502, headers: { "content-type": "text/html" } },
            );
          }
          if (clip === "multi_chunk_wav_0001") {
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array(0));
                  controller.enqueue(SYNTH_WAV.subarray(0, 20));
                  controller.enqueue(SYNTH_WAV.subarray(20));
                  controller.close();
                },
              }),
              { status: 200, headers: { "content-type": "audio/wav" } },
            );
          }
          if (clip === "fallback_big_ok_0001") {
            return {
              status: 200,
              headers: new Headers({ "content-type": "audio/wav" }),
              body: null,
              arrayBuffer: async () => new Uint8Array(RECORDING_MAX_BYTES + 1).buffer,
            } as unknown as Response;
          }
          return {
            status: 500,
            headers: new Headers({ "content-type": "text/plain" }),
            body: null,
            arrayBuffer: async () =>
              new TextEncoder().encode(`   <err>boom</err>  ${"z".repeat(MAX_ERROR_BYTES + 200)}`)
                .buffer,
          } as unknown as Response;
        },
      },
    });
    const inner = h.deps.fetch;
    h.deps.fetch = async (u: URL, init: any = {}) => {
      const clip = new URL(String(u)).searchParams.get("clip");
      if (clip === "huge_error_body_0001") errSignal = init.signal;
      if (clip === "fallback_big_ok_0001") fallbackSignal = init.signal;
      return inner(u, init);
    };

    const bigErr = await h.run("recordings", "get", "huge_error_body_0001", "--json");
    expect(bigErr.code).toBe(4);
    expect(envelope(bigErr.err).error.code).toBe("server");
    const errMsg: string = envelope(bigErr.err).error.message;
    expect(errMsg).toContain("502 Bad Gateway");
    expect(errMsg).not.toMatch(/[<>]/);
    expect(errMsg.length).toBeLessThanOrEqual(240);
    expect(errCanceled).toBe(true);
    expect(errSignal?.aborted).toBe(true);
    expect(errPulls).toBeLessThanOrEqual(Math.ceil(MAX_ERROR_BYTES / ERR_CHUNK) + 2);
    expect(bigErr.out + bigErr.err).not.toContain(TOKEN);

    const out = join(tmp(), "chunked-out");
    const okChunked = await h.run(
      "recordings",
      "get",
      "multi_chunk_wav_0001",
      "--out",
      out,
      "--json",
    );
    expect(okChunked.code).toBe(0);
    expect(new Uint8Array(readFileSync(join(out, "multi_chunk_wav_0001.wav")))).toEqual(SYNTH_WAV);

    const fbBig = await h.run("recordings", "get", "fallback_big_ok_0001", "--json");
    expect(fbBig.code).toBe(4);
    expect(envelope(fbBig.err).error.message).toContain(String(RECORDING_MAX_BYTES));
    expect(fallbackSignal?.aborted).toBe(true);

    const fbErr = await h.run("recordings", "get", "fallback_big_err_001", "--json");
    expect(fbErr.code).toBe(4);
    const fbErrMsg: string = envelope(fbErr.err).error.message;
    expect(fbErrMsg).toContain("boom");
    expect(fbErrMsg).not.toMatch(/[<>]/);
    expect(fbErrMsg.length).toBeLessThanOrEqual(240);
  });
});

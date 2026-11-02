/**
 * scripts/ops/cf-tunnel.ts against a fake Cloudflare API: the remotely
 * managed tunnel, its ingress, the DNS record, the shared rate rule, the run
 * token file, and the rollback. Nothing reaches the network.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST,
  ORIGIN,
  RULE_REF,
  TUNNEL_NAME,
  apiToken,
  down,
  ingress,
  main,
  makeCf,
  ownedFileProblem,
  secretDirProblem,
  secretFileProblem,
  up,
  writeSecretFile,
  type Cf,
} from "../scripts/ops/cf-tunnel";

const RUN_TOKEN = "eyJhIjoiUlVOLVRPS0VOLVNFQ1JFVCJ9";

type World = {
  tunnels: { id: string; name: string; config_src: string }[];
  records: { id: string; type: string; name: string; content: string; proxied?: boolean }[];
  ruleset?: { id: string; rules: { id: string; ref?: string }[] };
};

function fakeCf(w: World) {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  const cf: Cf = async <T>(method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path}`);
    if (body !== undefined) bodies[`${method} ${path}`] = body;
    const r = (x: unknown) => x as T;
    if (method === "GET" && path.startsWith("/zones?name="))
      return r([{ id: "z1", account: { id: "a1" } }]);
    if (method === "GET" && path.startsWith("/accounts/a1/cfd_tunnel?")) return r(w.tunnels);
    if (method === "POST" && path === "/accounts/a1/cfd_tunnel") {
      const t = { id: "t-new", name: TUNNEL_NAME, config_src: "cloudflare" };
      w.tunnels.push(t);
      return r(t);
    }
    if (method === "GET" && path.endsWith("/token")) return r(RUN_TOKEN);
    if (method === "GET" && path.startsWith("/zones/z1/dns_records?")) return r(w.records);
    if (method === "GET" && path.endsWith("/phases/http_ratelimit/entrypoint")) return r(w.ruleset);
    return r({});
  };
  return { cf, calls, bodies };
}

const empty = (): World => ({ tunnels: [], records: [] });

describe("up", () => {
  test("from nothing: a remotely managed tunnel, ingress to the gate only, a proxied CNAME, the rule, the token", async () => {
    const f = fakeCf(empty());
    const r = await up(f.cf);
    expect(f.bodies["POST /accounts/a1/cfd_tunnel"]).toEqual({
      name: TUNNEL_NAME,
      config_src: "cloudflare",
    });
    expect(f.bodies["PUT /accounts/a1/cfd_tunnel/t-new/configurations"]).toEqual(ingress());
    expect(ingress().config.ingress).toEqual([
      { hostname: HOST, service: ORIGIN },
      { service: "http_status:404" },
    ]);
    expect(ORIGIN).toBe("http://127.0.0.1:3104");
    expect(f.bodies["POST /zones/z1/dns_records"]).toMatchObject({
      type: "CNAME",
      name: HOST,
      content: "t-new.cfargotunnel.com",
      proxied: true,
    });
    expect(f.bodies["PUT /zones/z1/rulesets/phases/http_ratelimit/entrypoint"]).toMatchObject({
      rules: [{ ref: RULE_REF, action: "block" }],
    });
    expect(r.token).toBe(RUN_TOKEN);
  });

  test("the rule covers the STT host and only the dev server's /_lk/ handshakes", async () => {
    const f = fakeCf(empty());
    await up(f.cf);
    const rule = (
      f.bodies["PUT /zones/z1/rulesets/phases/http_ratelimit/entrypoint"] as {
        rules: { expression: string }[];
      }
    ).rules[0];
    expect(rule.expression).toContain('http.host eq "stt.lianki.com"');
    expect(rule.expression).toContain(
      'http.host eq "preview.lianki.com" and starts_with(http.request.uri.path, "/_lk/")',
    );
  });

  test("twice: reuses the tunnel and record, updates the rule in place", async () => {
    const w: World = {
      tunnels: [{ id: "t1", name: TUNNEL_NAME, config_src: "cloudflare" }],
      records: [
        { id: "r1", type: "CNAME", name: HOST, content: "t1.cfargotunnel.com", proxied: true },
      ],
      ruleset: { id: "rs1", rules: [{ id: "ru1", ref: RULE_REF }] },
    };
    const f = fakeCf(w);
    await up(f.cf);
    expect(f.calls).not.toContain("POST /accounts/a1/cfd_tunnel");
    expect(
      f.calls.some(
        (c) =>
          c.startsWith("POST /zones/z1/dns_records") || c.startsWith("PATCH /zones/z1/dns_records"),
      ),
    ).toBe(false);
    expect(f.calls).toContain("PATCH /zones/z1/rulesets/rs1/rules/ru1");
  });

  test("another rule set: the rule is added, not the set replaced", async () => {
    const f = fakeCf({
      ...empty(),
      ruleset: { id: "rs1", rules: [{ id: "x", ref: "someone-else" }] },
    });
    await up(f.cf);
    expect(f.calls).toContain("POST /zones/z1/rulesets/rs1/rules");
    expect(f.calls).not.toContain("PUT /zones/z1/rulesets/phases/http_ratelimit/entrypoint");
  });

  test("a CNAME to an old tunnel is re-pointed; a record that is not a tunnel is never touched", async () => {
    const f = fakeCf({
      ...empty(),
      records: [{ id: "r1", type: "CNAME", name: HOST, content: "old.cfargotunnel.com" }],
    });
    await up(f.cf);
    expect(f.calls).toContain("PATCH /zones/z1/dns_records/r1");
    const g = fakeCf({
      ...empty(),
      records: [{ id: "r2", type: "A", name: HOST, content: "192.0.2.1" }],
    });
    await expect(up(g.cf)).rejects.toThrow("not a tunnel");
    expect(g.calls.some((c) => !c.startsWith("GET"))).toBe(false); // nothing created
  });

  test("a locally managed tunnel of that name: refused", async () => {
    const f = fakeCf({
      ...empty(),
      tunnels: [{ id: "t1", name: TUNNEL_NAME, config_src: "local" }],
    });
    await expect(up(f.cf)).rejects.toThrow("locally managed");
  });

  test("dry run: reads only", async () => {
    const f = fakeCf(empty());
    const r = await up(f.cf, { dryRun: true });
    expect(f.calls.every((c) => c.startsWith("GET"))).toBe(true);
    expect(r.token).toBeUndefined();
  });
});

describe("down (the rollback)", () => {
  test("connections first, then the tunnel, then its DNS record; the shared rule stays", async () => {
    const w: World = {
      tunnels: [{ id: "t1", name: TUNNEL_NAME, config_src: "cloudflare" }],
      records: [
        { id: "r1", type: "CNAME", name: HOST, content: "t1.cfargotunnel.com" },
        { id: "r2", type: "TXT", name: HOST, content: "keep me" },
      ],
      ruleset: { id: "rs1", rules: [{ id: "ru1", ref: RULE_REF }] },
    };
    const f = fakeCf(w);
    await down(f.cf);
    const writes = f.calls.filter((c) => !c.startsWith("GET"));
    expect(writes).toEqual([
      "DELETE /accounts/a1/cfd_tunnel/t1/connections",
      "DELETE /accounts/a1/cfd_tunnel/t1",
      "DELETE /zones/z1/dns_records/r1",
    ]);
  });

  test("nothing there: nothing deleted", async () => {
    const f = fakeCf(empty());
    await down(f.cf);
    expect(f.calls.every((c) => c.startsWith("GET"))).toBe(true);
  });
});

describe("token files", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "cf-tunnel-"));

  test("main up writes the run token 0600 and never prints it", async () => {
    const d = dir();
    const out = join(d, "sub", "token");
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      expect(await main(["up", "--token-out", out], { cf: fakeCf(empty()).cf, env: {} })).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(readFileSync(out, "utf8").trim()).toBe(RUN_TOKEN);
    expect(lstatSync(out).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).not.toContain(RUN_TOKEN);
  });

  test("an existing symlink at the path is replaced, never written through", () => {
    const d = dir();
    const target = join(d, "elsewhere");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(d, "token"));
    writeSecretFile(join(d, "token"), "secret");
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(lstatSync(join(d, "token")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(d, "token")).mode & 0o777).toBe(0o600);
  });

  test("secretFileProblem: symlink, not ours, readable by others, missing", () => {
    const d = dir();
    const f = join(d, "t");
    writeFileSync(f, "x", { mode: 0o600 });
    expect(secretFileProblem(f)).toBeNull();
    chmodSync(f, 0o640);
    expect(secretFileProblem(f)).toContain("group or others");
    chmodSync(f, 0o604);
    expect(secretFileProblem(f)).toContain("group or others");
    chmodSync(f, 0o600);
    expect(secretFileProblem(f, (process.getuid?.() ?? 0) + 1)).toBe("is not owned by this user");
    symlinkSync(f, join(d, "l"));
    expect(secretFileProblem(join(d, "l"))).toBe("is a symlink");
    expect(secretFileProblem(join(d, "missing"))).toContain("cannot read");
    expect(secretFileProblem(d)).toBe("is not a regular file");
  });

  test("ownedFileProblem ignores the mode only; secretDirProblem wants our own unwritable directory", () => {
    const d = dir();
    const f = join(d, "f");
    writeFileSync(f, "x", { mode: 0o644 });
    expect(ownedFileProblem(f)).toBeNull();
    symlinkSync(f, join(d, "l"));
    expect(ownedFileProblem(join(d, "l"))).toBe("is a symlink");
    expect(ownedFileProblem(f, (process.getuid?.() ?? 0) + 1)).toBe("is not owned by this user");
    chmodSync(d, 0o700);
    expect(secretDirProblem(d)).toBeNull();
    chmodSync(d, 0o770);
    expect(secretDirProblem(d)).toBe("is writable by group or others");
    chmodSync(d, 0o757);
    expect(secretDirProblem(d)).toBe("is writable by group or others");
    chmodSync(d, 0o700);
    expect(secretDirProblem(d, (process.getuid?.() ?? 0) + 1)).toBe("is not owned by this user");
    expect(secretDirProblem(f)).toBe("is not a directory");
    const ld = join(mkdtempSync(join(tmpdir(), "cf-tunnel-")), "ld");
    symlinkSync(d, ld);
    expect(secretDirProblem(ld)).toBe("is a symlink");
    expect(secretDirProblem(join(d, "missing"))).toContain("cannot read");
  });

  test("check-dir and check-owned need no API token", async () => {
    const d = dir();
    chmodSync(d, 0o700);
    const f = join(d, "f");
    writeFileSync(f, "x", { mode: 0o644 });
    const err = console.error;
    console.error = () => {};
    try {
      expect(await main(["check-dir", d], { env: {} })).toBe(0);
      expect(await main(["check-owned", f], { env: {} })).toBe(0);
      expect(await main(["check-secret", f], { env: {} })).toBe(1);
      chmodSync(d, 0o777);
      expect(await main(["check-dir", d], { env: {} })).toBe(1);
      expect(await main(["check-dir"], { env: {} })).toBe(1);
    } finally {
      console.error = err;
      chmodSync(d, 0o700);
    }
  });

  test("the API token: env first, else a checked file", () => {
    const d = dir();
    const f = join(d, "api");
    writeFileSync(f, "file-token\n", { mode: 0o600 });
    expect(apiToken({ CLOUDFLARE_API_TOKEN: "env-token", CF_API_TOKEN_FILE: f })).toBe("env-token");
    expect(apiToken({ CF_API_TOKEN_FILE: f })).toBe("file-token");
    chmodSync(f, 0o644);
    expect(() => apiToken({ CF_API_TOKEN_FILE: f })).toThrow("group or others");
    expect(existsSync(f)).toBe(true);
  });

  test("check-secret needs no API token", async () => {
    const d = dir();
    const f = join(d, "t");
    writeFileSync(f, "x", { mode: 0o600 });
    expect(await main(["check-secret", f], { env: {} })).toBe(0);
    chmodSync(f, 0o644);
    const err = console.error;
    console.error = () => {};
    try {
      expect(await main(["check-secret", f], { env: {} })).toBe(1);
    } finally {
      console.error = err;
    }
  });

  test("an API error names the call and the reason, never the token", async () => {
    const cf = makeCf(
      "API-SECRET-123",
      (async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          }),
          {
            status: 403,
          },
        )) as unknown as typeof fetch,
    );
    const e = await cf("POST", "/x").catch((x: Error) => x);
    expect(String(e)).toContain("403 10000 Authentication error");
    expect(String(e)).not.toContain("API-SECRET-123");
  });
});

describe("main", () => {
  const quiet = async <T>(f: () => Promise<T>) => {
    const [l, e] = [console.log, console.error];
    const out: string[] = [];
    console.log = (...a: unknown[]) => out.push(a.join(" "));
    console.error = (...a: unknown[]) => out.push(a.join(" "));
    try {
      return { r: await f(), out: out.join("\n") };
    } finally {
      console.log = l;
      console.error = e;
    }
  };
  const world = (): World => ({
    tunnels: [{ id: "t1", name: TUNNEL_NAME, config_src: "cloudflare" }],
    records: [
      { id: "r1", type: "CNAME", name: HOST, content: "t1.cfargotunnel.com", proxied: true },
    ],
    ruleset: { id: "rs1", rules: [{ id: "ru1", ref: RULE_REF }] },
  });

  test("down and status", async () => {
    const d = await quiet(() => main(["down"], { cf: fakeCf(world()).cf, env: {} }));
    expect(d.r).toBe(0);
    expect(d.out).toContain("done: delete tunnel t1");
    const s = await quiet(() => main(["status"], { cf: fakeCf(world()).cf, env: {} }));
    expect(s.out).toContain("tunnel:       t1 (cloudflare)");
    expect(s.out).toContain("a tunnel, proxied");
    expect(s.out).toContain("rate limit:   on");
  });

  test("dry runs, a missing --token-out, and an unknown command", async () => {
    const p = await quiet(() => main(["up", "--dry-run"], { cf: fakeCf(empty()).cf, env: {} }));
    expect(p.out).toContain("plan: create tunnel");
    const q = await quiet(() => main(["down", "--dry-run"], { cf: fakeCf(world()).cf, env: {} }));
    expect(q.out).toContain("plan: delete tunnel t1");
    await expect(main(["up"], { cf: fakeCf(empty()).cf, env: {} })).rejects.toThrow("--token-out");
    expect((await quiet(() => main(["nope"], { cf: fakeCf(empty()).cf, env: {} }))).r).toBe(2);
  });

  test("the real client: success, a 404 GET, and no token", async () => {
    const ok = makeCf("t", (async () =>
      Response.json({ success: true, result: [1] })) as unknown as typeof fetch);
    expect(await ok<number[]>("GET", "/x")).toEqual([1]);
    const nf = makeCf(
      "t",
      (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
    );
    expect(await nf("GET", "/x")).toBeUndefined();
    expect(() => apiToken({ CF_API_TOKEN_FILE: "/nonexistent/x" })).toThrow("no API token");
  });
});

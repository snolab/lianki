/**
 * scripts/dev/dev-host-switch.ts against an in-memory Cloudflare API: the plan
 * changes nothing, `up --yes` keeps the old records (0600) before touching
 * DNS, a second `up` never overwrites them, and `down` puts them back exactly.
 * Nothing reaches Cloudflare; no token is printed.
 */
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "dev-host-"));
process.env.DEV_HOST_PREV_FILE = join(dir, "prev.json");
process.env.DEV_HOST_TUNNEL_TOKEN_FILE = join(dir, "run-token");
type M = typeof import("../scripts/dev/dev-host-switch");
let m: M;
beforeAll(async () => {
  m = await import("../scripts/dev/dev-host-switch");
});

type Rec = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  comment?: string | null;
};

/** The slice of the Cloudflare API the script uses, in memory. */
function fakeCf(initial: Rec[]) {
  const state = {
    records: [...initial],
    tunnels: [] as { id: string; name: string }[],
    config: null as unknown,
    calls: [] as string[],
    auth: [] as string[],
  };
  let n = 0;
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    state.calls.push(`${method} ${path}`);
    state.auth.push(new Headers(init?.headers).get("authorization") ?? "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (result: unknown) => Response.json({ success: true, result });
    if (path === "/zones") return ok([{ id: "z1", account: { id: "a1" } }]);
    if (path === "/zones/z1/dns_records" && method === "GET")
      return ok(state.records.filter((r) => r.name === u.searchParams.get("name")));
    if (path === "/zones/z1/dns_records" && method === "POST") {
      state.records.push({ id: `r${++n}`, ...body });
      return ok({});
    }
    if (path.startsWith("/zones/z1/dns_records/") && method === "DELETE") {
      state.records = state.records.filter((r) => r.id !== path.split("/").pop());
      return ok({});
    }
    if (path === "/accounts/a1/cfd_tunnel" && method === "GET") return ok(state.tunnels);
    if (path === "/accounts/a1/cfd_tunnel" && method === "POST") {
      const t = { id: "t-0001", name: body.name };
      state.tunnels.push(t);
      return ok(t);
    }
    if (path.endsWith("/configurations")) {
      state.config = body;
      return ok({});
    }
    if (path.endsWith("/token")) return ok("RUN-TOKEN-secret");
    if (path.endsWith("/connections")) return ok({});
    if (path === "/accounts/a1/cfd_tunnel/t-0001" && method === "DELETE") {
      state.tunnels = [];
      return ok({});
    }
    return Response.json(
      { success: false, errors: [{ code: 7003, message: "no route" }] },
      { status: 400 },
    );
  }) as unknown as typeof fetch;
  return { state, f };
}

const OLD: Rec = {
  id: "old1",
  type: "CNAME",
  name: "dev.lianki.com",
  content: "aaaa-other-tunnel.cfargotunnel.com",
  proxied: true,
  ttl: 1,
  comment: "the other dev box",
};

describe("dev-host-switch", () => {
  let api: ReturnType<typeof fakeCf>;
  let cf: ReturnType<M["makeCf"]>;
  const lines: string[] = [];
  const log = (s: string) => void lines.push(s);
  beforeEach(() => {
    for (const f of [process.env.DEV_HOST_PREV_FILE!, process.env.DEV_HOST_TUNNEL_TOKEN_FILE!])
      if (existsSync(f)) Bun.spawnSync(["rm", "-f", f]);
    lines.length = 0;
    api = fakeCf([OLD]);
    cf = m.makeCf("API-TOKEN", api.f);
  });

  it("plan (and up without --yes) changes nothing and says old → new and the rollback", async () => {
    expect(await m.up(cf, { yes: false, log })).toBe(false);
    expect(api.state.calls.every((c) => c.startsWith("GET "))).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain(
      "now:  CNAME dev.lianki.com → aaaa-other-tunnel.cfargotunnel.com (proxied on, ttl 1)",
    );
    expect(text).toContain(
      "new:  CNAME dev.lianki.com → <new tunnel lianki-dev-loader-mac>.cfargotunnel.com",
    );
    expect(text).toContain("undo: bash scripts/dev/dev-host-switch.sh down");
    expect(existsSync(process.env.DEV_HOST_PREV_FILE!)).toBe(false);
    expect(text).not.toContain("API-TOKEN");
  });

  it("up --yes: old records saved 0600 first, tunnel + ingress + run token 0600, then DNS", async () => {
    expect(await m.up(cf, { yes: true, log })).toBe(true);
    const prev = JSON.parse(readFileSync(process.env.DEV_HOST_PREV_FILE!, "utf8"));
    expect(prev.records).toEqual([
      {
        type: "CNAME",
        name: "dev.lianki.com",
        content: OLD.content,
        proxied: true,
        ttl: 1,
        comment: OLD.comment,
      },
    ]);
    expect(statSync(process.env.DEV_HOST_PREV_FILE!).mode & 0o777).toBe(0o600);
    expect(statSync(process.env.DEV_HOST_TUNNEL_TOKEN_FILE!).mode & 0o777).toBe(0o600);
    expect(readFileSync(process.env.DEV_HOST_TUNNEL_TOKEN_FILE!, "utf8").trim()).toBe(
      "RUN-TOKEN-secret",
    );
    expect(api.state.config).toEqual(m.ingress());
    expect(api.state.records.map((r) => [r.type, r.content, r.proxied])).toEqual([
      ["CNAME", "t-0001.cfargotunnel.com", true],
    ]);
    // DNS is the last thing touched.
    const firstDns = api.state.calls.findIndex((c) => c.startsWith("DELETE /zones"));
    const tokenAt = api.state.calls.findIndex((c) => c.endsWith("/token"));
    expect(firstDns).toBeGreaterThan(tokenAt);
    expect(lines.join("\n")).not.toContain("RUN-TOKEN");
    expect(api.state.auth.every((a) => a === "Bearer API-TOKEN")).toBe(true);

    // A second up keeps the ORIGINAL records, and changes no DNS.
    lines.length = 0;
    const before = api.state.calls.length;
    await m.up(cf, { yes: true, log });
    expect(
      JSON.parse(readFileSync(process.env.DEV_HOST_PREV_FILE!, "utf8")).records[0].content,
    ).toBe(OLD.content);
    expect(
      api.state.calls
        .slice(before)
        .some((c) => c.includes("dns_records/") || c.startsWith("POST /zones")),
    ).toBe(false);
    expect(lines.join("\n")).toContain("rollback file already holds");

    // down: back exactly, tunnel deleted, token file gone.
    await m.down(cf, { log });
    expect(api.state.records.map(({ id: _id, ...r }) => r)).toEqual([
      {
        type: "CNAME",
        name: "dev.lianki.com",
        content: OLD.content,
        proxied: true,
        ttl: 1,
        comment: OLD.comment,
      },
    ]);
    expect(api.state.tunnels).toEqual([]);
    expect(existsSync(process.env.DEV_HOST_TUNNEL_TOKEN_FILE!)).toBe(false);
    expect(existsSync(process.env.DEV_HOST_PREV_FILE!)).toBe(false);
  });

  it("down without a rollback file leaves DNS alone", async () => {
    await m.down(cf, { log });
    expect(lines[0]).toContain("no rollback file");
    expect(api.state.records).toEqual([OLD]);
  });

  it("status says where it points", async () => {
    await m.status(cf, { log });
    expect(lines.join("\n")).toContain("points at this Mac: no");
    await m.up(cf, { yes: true, log });
    lines.length = 0;
    await m.status(cf, { log });
    expect(lines.join("\n")).toContain("points at this Mac: yes");
    expect(lines.join("\n")).toContain("rollback file: ");
  });

  it("an API error names the call, never the token; a 404 GET is undefined", async () => {
    await expect(cf("PATCH", "/nowhere")).rejects.toThrow("PATCH /nowhere: 400 7003 no route");
    const nf = m.makeCf(
      "T",
      (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
    );
    expect(await nf("GET", "/x")).toBeUndefined();
    const bad = m.makeCf(
      "T",
      (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    );
    await expect(bad("POST", "/x")).rejects.toThrow("POST /x: 500 ");
    const noZone = m.makeCf("T", (async () =>
      Response.json({ success: true, result: [] })) as unknown as typeof fetch);
    await expect(m.zoneOf(noZone)).rejects.toThrow("not visible");
  });

  it("refuses a token file that is missing, a symlink, or readable by others", () => {
    const p = join(dir, "tok");
    expect(() => m.apiToken({}, p)).toThrow("does not exist");
    writeFileSync(p, "  abc \n");
    chmodSync(p, 0o644);
    expect(() => m.apiToken({}, p)).toThrow("want 0600");
    chmodSync(p, 0o600);
    expect(m.apiToken({}, p)).toBe("abc");
    const l = join(dir, "link");
    symlinkSync(p, l);
    expect(m.secretFileProblem(l)).toBe("is a symlink");
    expect(m.secretFileProblem(dir)).toBe("is not a regular file");
    expect(m.secretFileProblem(p, -2)).toBe("is not owned by this user");
    writeFileSync(p, "");
    expect(() => m.apiToken({}, p)).toThrow("is empty");
    expect(m.apiToken({ CLOUDFLARE_API_TOKEN: " env " }, p)).toBe("env");
  });
});

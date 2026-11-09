import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  PERMISSION_CACHE_MS,
  PERMISSION_REFRESH_MS,
  clearPermissionCache,
  isAdmin,
  isDev,
  permissionHolders,
  setPermissionSnapshot,
  type Grant,
} from "@/lib/permissions";
import { refreshHolders, refreshPermissions, refreshPermissionsFrom } from "@/lib/permission-store";
import { useBackend, useD1 } from "./support/testMocks";
import {
  grantPermission,
  holderIds,
  listGrants,
  readHolders,
  readPermissionHistory,
  type HistoryPage,
  userHolds,
  readGrants,
  revokePermission,
  validPermissionEmail,
  type PermissionDb,
  type PermissionReadDb,
} from "@/lib/account-permission";
import { permissionsGet, permissionsHistoryGet, permissionsPost } from "@/lib/permission-route";
import { DEV_PAGE_PERMISSION, devPagePermission } from "@/lib/dev-page-permissions";
import { commandSql, parseArgs } from "../scripts/dev/permission-sql";

const ME = { id: "u_admin", email: "admin@example.com" };
const T0 = 1_800_000_000_000;

let d1: TestD1Database;
const read = () => d1 as unknown as PermissionReadDb;
const write = () => d1 as unknown as PermissionDb;
const audits = () =>
  d1
    .raw()
    .prepare(
      "SELECT kind, actor, detail FROM security_audit WHERE kind LIKE 'permission.%' ORDER BY id",
    )
    .all() as { kind: string; actor: string; detail: string }[];

beforeEach(() => {
  clearPermissionCache();
  d1 = createTestD1(testSchema());
});
afterEach(() => {
  clearPermissionCache();
});

describe("isAdmin / isDev", () => {
  it("fail closed: no snapshot grants nothing", () => {
    expect(isAdmin(ME.email)).toBe(false);
    expect(isDev(ME.email)).toBe(false);
    expect(isDev(null)).toBe(false);
    expect(isDev("")).toBe(false);
  });

  it("each permission is its own grant; neither implies the other", () => {
    setPermissionSnapshot([{ email: "dev@example.com", permission: "dev" }]);
    expect(isDev("dev@example.com")).toBe(true);
    expect(isAdmin("dev@example.com")).toBe(false);
    clearPermissionCache();
    setPermissionSnapshot([{ email: "a@example.com", permission: "admin" }]);
    expect(isAdmin("a@example.com")).toBe(true);
    expect(isDev("a@example.com")).toBe(false);
  });

  it("exact address: case and spaces fold, dots and +tags do not", () => {
    setPermissionSnapshot([{ email: "someone+admin@gmail.com", permission: "dev" }]);
    expect(isDev(" Someone+Admin@Gmail.com ")).toBe(true);
    expect(isDev("someone@gmail.com")).toBe(false);
    expect(isDev("some.one+admin@gmail.com")).toBe(false);
  });

  it("a snapshot older than the cache window counts for nothing", () => {
    setPermissionSnapshot([{ email: "a@example.com", permission: "dev" }], T0);
    expect(isDev("a@example.com", T0 + PERMISSION_CACHE_MS - 1)).toBe(true);
    expect(isDev("a@example.com", T0 + PERMISSION_CACHE_MS)).toBe(false);
    expect(isDev("a@example.com", T0 - 1)).toBe(false);
  });

  it("step c: an old site_role owner without a grant passes nothing", async () => {
    d1.raw().exec(
      "INSERT INTO site_role (email, role, granted_by, granted_at) VALUES ('owner@example.com', 'owner', 't', 1)",
    );
    await refreshPermissions(read);
    expect(isAdmin("owner@example.com")).toBe(false);
    expect(isDev("owner@example.com")).toBe(false);
    setPermissionSnapshot([{ email: "dev@example.com", permission: "dev" }]);
    expect(permissionHolders("dev")).toEqual(["dev@example.com"]);
    expect(permissionHolders("admin")).toEqual([]);
  });
});

describe("account_permission", () => {
  it("grants, lists oldest first, revokes, and audits each change", async () => {
    expect(await grantPermission(write(), "a@example.com", "admin", ME, T0)).toBe("granted");
    expect(await grantPermission(write(), "a@example.com", "dev", ME, T0 + 1)).toBe("granted");
    expect(await grantPermission(write(), "b@example.com", "dev", ME, T0 + 2)).toBe("granted");
    expect(await grantPermission(write(), "b@example.com", "dev", ME, T0 + 3)).toBe(
      "already-granted",
    );
    expect(await readGrants(read())).toEqual([
      { email: "a@example.com", permission: "admin" },
      { email: "a@example.com", permission: "dev" },
      { email: "b@example.com", permission: "dev" },
    ]);
    expect(await revokePermission(write(), "b@example.com", "dev", ME, T0 + 4)).toBe("revoked");
    expect(await revokePermission(write(), "b@example.com", "dev", ME, T0 + 5)).toBe("not-granted");
    expect(audits()).toEqual([
      { kind: "permission.grant", actor: ME.id, detail: "admin a@example.com" },
      { kind: "permission.grant", actor: ME.id, detail: "dev a@example.com" },
      { kind: "permission.grant", actor: ME.id, detail: "dev b@example.com" },
      { kind: "permission.regrant", actor: ME.id, detail: "dev b@example.com" },
      { kind: "permission.revoke", actor: ME.id, detail: "dev b@example.com" },
    ]);
  });

  it("the last admin cannot be revoked; the last dev can", async () => {
    await grantPermission(write(), "a@example.com", "admin", ME, T0);
    await grantPermission(write(), "a@example.com", "dev", ME, T0 + 1);
    expect(await revokePermission(write(), "a@example.com", "admin", ME, T0 + 2)).toBe(
      "last-admin",
    );
    expect(await revokePermission(write(), "a@example.com", "dev", ME, T0 + 3)).toBe("revoked");
    await grantPermission(write(), "b@example.com", "admin", ME, T0 + 4);
    expect(await revokePermission(write(), "a@example.com", "admin", ME, T0 + 5)).toBe("revoked");
    expect(await revokePermission(write(), "b@example.com", "admin", ME, T0 + 6)).toBe(
      "last-admin",
    );
  });

  it("a re-grant keeps the original granted_by and granted_at, and is audited", async () => {
    const OTHER = { id: "u_other", email: "other@example.com" };
    await grantPermission(write(), "a@example.com", "dev", ME, T0);
    expect(await grantPermission(write(), "a@example.com", "dev", OTHER, T0 + 9)).toBe(
      "already-granted",
    );
    expect(await listGrants(read())).toEqual([
      { email: "a@example.com", permission: "dev", granted_by: ME.email, granted_at: T0 },
    ]);
    expect(audits()).toEqual([
      { kind: "permission.grant", actor: ME.id, detail: "dev a@example.com" },
      { kind: "permission.regrant", actor: OTHER.id, detail: "dev a@example.com" },
    ]);
  });

  it("a revoked grant can be given again", async () => {
    await grantPermission(write(), "a@example.com", "dev", ME, T0);
    await revokePermission(write(), "a@example.com", "dev", ME, T0 + 1);
    expect(await grantPermission(write(), "a@example.com", "dev", ME, T0 + 2)).toBe("granted");
    expect((await listGrants(read())).map((g) => g.email)).toEqual(["a@example.com"]);
  });

  it("refuses bad input", async () => {
    expect(await grantPermission(write(), "not an address", "dev", ME)).toBe("bad-email");
    expect(await grantPermission(write(), "a@example.com", "owner", ME)).toBe("bad-permission");
    expect(await revokePermission(write(), "a@example.com", "root", ME)).toBe("bad-permission");
    expect(validPermissionEmail("x'@example.com")).toBe(null);
    expect(validPermissionEmail(" A+b@Example.com ")).toBe("a+b@example.com");
  });

  it("the table has no seed: grants are data, added on approval", async () => {
    expect(await listGrants(read())).toEqual([]);
    const sql = readFileSync("db/migrations/0058_account_permission.sql", "utf8");
    expect(sql).not.toMatch(/INSERT/i);
    expect(sql).not.toMatch(/@gmail\.com/);
  });
});

describe("refreshPermissions", () => {
  it("reads D1 into the snapshot, and caches for the refresh window", async () => {
    await grantPermission(write(), "a@example.com", "dev", ME, T0);
    let reads = 0;
    const db = () => {
      reads++;
      return read();
    };
    let t = T0;
    expect(await refreshPermissions(db, () => t)).toEqual([
      { email: "a@example.com", permission: "dev" },
    ]);
    expect(isDev("a@example.com", t)).toBe(true);
    t += PERMISSION_REFRESH_MS - 1;
    await refreshPermissions(db, () => t);
    expect(reads).toBe(1);
    t += 1;
    await refreshPermissions(db, () => t);
    expect(reads).toBe(2);
  });

  it("fail closed: a D1 error or no D1 grants nothing, and is not remembered", async () => {
    setPermissionSnapshot(
      [{ email: "a@example.com", permission: "dev" }],
      T0 - PERMISSION_REFRESH_MS,
    );
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const broken = () =>
        ({
          prepare() {
            throw new Error("D1 down");
          },
        }) as unknown as PermissionReadDb;
      expect(await refreshPermissions(broken, () => T0)).toEqual([]);
      expect(isDev("a@example.com", T0)).toBe(false);
      expect(
        await refreshPermissions(
          () => null,
          () => T0,
        ),
      ).toEqual([]);
    } finally {
      err.mockRestore();
    }
  });
});

describe("refreshPermissions: databases", () => {
  it("the default database is the request's D1; a webhook passes its own; off D1 nothing", async () => {
    await grantPermission(write(), "a@example.com", "dev", ME, T0);
    const want: Grant[] = [{ email: "a@example.com", permission: "dev" }];
    useBackend("d1");
    useD1(d1);
    try {
      expect(await refreshPermissions()).toEqual(want);
      clearPermissionCache();
      expect(await refreshPermissionsFrom(d1)).toEqual(want);
      clearPermissionCache();
      useBackend("mongodb");
      expect(await refreshPermissions()).toEqual([]);
    } finally {
      useBackend("mongodb");
    }
  });

  it("an answer that arrives after the cache window is dropped", async () => {
    await grantPermission(write(), "a@example.com", "dev", ME, T0);
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      let calls = 0;
      const clock = () => (calls++ === 0 ? T0 : T0 + PERMISSION_CACHE_MS);
      expect(await refreshPermissions(read, clock)).toEqual([]);
      expect(isDev("a@example.com", T0)).toBe(false);
      expect(String(err.mock.calls[0]?.[0])).toContain("permissions.read-stale");
    } finally {
      err.mockRestore();
    }
  });
});

describe("/api/dev/permissions", () => {
  const post = (body: unknown) =>
    new Request("https://lianki.com/api/dev/permissions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://lianki.com",
        host: "lianki.com",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify(body),
    });

  it("a non-admin gets an empty 404 and changes nothing", async () => {
    const g = await permissionsGet(null, write);
    expect(g.status).toBe(404);
    expect(await g.text()).toBe("");
    const p = await permissionsPost(
      post({ op: "grant", email: "evil@example.com", permission: "admin" }),
      null,
      write,
    );
    expect(p.status).toBe(404);
    expect(await listGrants(read())).toEqual([]);
    expect((await permissionsGet(ME, () => null)).status).toBe(404);
  });

  it("refuses a cross-site post", async () => {
    const r = new Request("https://lianki.com/api/dev/permissions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ op: "grant", email: "evil@example.com", permission: "admin" }),
    });
    expect((await permissionsPost(r, ME, write)).status).toBe(403);
    expect(await listGrants(read())).toEqual([]);
  });

  it("grants and revokes, with codes for refusals", async () => {
    const g = await permissionsPost(
      post({ op: "grant", email: "a@example.com", permission: "admin" }),
      ME,
      write,
    );
    expect(g.status).toBe(200);
    const r = await permissionsPost(
      post({ op: "revoke", email: "a@example.com", permission: "admin" }),
      ME,
      write,
    );
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("last-admin");
    const bad = await permissionsPost(
      post({ op: "grant", email: "x", permission: "dev" }),
      ME,
      write,
    );
    expect(bad.status).toBe(400);
    const badRevoke = await permissionsPost(
      post({ op: "revoke", email: "x", permission: "dev" }),
      ME,
      write,
    );
    expect(badRevoke.status).toBe(400);
    const garbled = post({});
    const notJson = new Request(garbled.url, {
      method: "POST",
      headers: garbled.headers,
      body: "{not json",
    });
    expect((await permissionsPost(notJson, ME, write)).status).toBe(400);
    const op = await permissionsPost(post({ op: "delete" }), ME, write);
    expect(op.status).toBe(400);
    expect(((await op.json()) as { error: string }).error).toBe("bad-op");
    const none = await permissionsPost(
      post({ op: "revoke", email: "b@example.com", permission: "dev" }),
      ME,
      write,
    );
    expect(none.status).toBe(409);
    await permissionsPost(
      post({ op: "grant", email: "b@example.com", permission: "dev" }),
      ME,
      write,
    );
    const ok = await permissionsPost(
      post({ op: "revoke", email: "b@example.com", permission: "dev" }),
      ME,
      write,
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { result: string }).result).toBe("revoked");
    const list = (await (await permissionsGet(ME, write)).json()) as { grants: unknown[] };
    expect(list.grants).toHaveLength(1);
  });

  it("the route and page gate on isAdmin", () => {
    const src = readFileSync("app/api/dev/permissions/route.ts", "utf8");
    expect(src).toContain("isAdmin(user?.email)");
    expect(src).toContain("permissionsGet(await admin(), db)");
    expect(src).toContain("permissionsPost(req, await admin(), db)");
    expect(readFileSync("app/(app)/dev/permissions/page.tsx", "utf8")).toContain(
      "if (!isAdmin(user?.email)) notFound();",
    );
  });
});

describe("/dev pages", () => {
  const pages = readdirSync("app/(app)/dev", { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => {
      try {
        return !!readFileSync(`app/(app)/dev/${n}/page.tsx`, "utf8");
      } catch {
        return false;
      }
    });

  it("every page is listed, and its gate matches the 'who can see' table", () => {
    expect(pages.sort()).toEqual(Object.keys(DEV_PAGE_PERMISSION).sort());
    for (const n of pages) {
      const src = readFileSync(`app/(app)/dev/${n}/page.tsx`, "utf8");
      const gate = DEV_PAGE_PERMISSION[n] === "admin" ? "isAdmin(" : "isDev(";
      expect({ n, gated: src.includes(gate) }).toEqual({ n, gated: true });
    }
    expect(devPagePermission("/dev/permissions")).toBe("admin");
    expect(devPagePermission("/dev/roadmap?x=1")).toBe("dev");
    expect(devPagePermission("/dev/nope")).toBe(null);
  });
});

describe("scripts/dev/permission.ts", () => {
  it("parses grant and builds one audited statement pair per permission", () => {
    const p = parseArgs(["grant", "A@Example.com", "admin,dev"]);
    expect(p).toEqual({
      cmd: "grant",
      email: "a@example.com",
      permissions: ["admin", "dev"],
      local: false,
    });
    const sql = commandSql(p, T0);
    expect(sql.match(/INSERT INTO account_permission/g)).toHaveLength(2);
    expect(sql.match(/INSERT INTO security_audit/g)).toHaveLength(4);
    expect(sql).toContain("'cli'");
    expect(() => parseArgs(["grant", "a@example.com", "owner"])).toThrow();
    expect(() => parseArgs(["grant", "a@example.com"])).toThrow();
    expect(parseArgs(["list", "--local"])).toEqual({ cmd: "list", local: true });
    expect(commandSql({ cmd: "list", local: false }, T0)).toContain("FROM account_permission");
    const revoke = commandSql(parseArgs(["revoke", "a@example.com", "dev"]), T0);
    expect(revoke).toContain("UPDATE account_permission");
    expect(revoke).toContain("'permission.revoke'");
    expect(() => parseArgs(["frob", "a@example.com", "dev"])).toThrow();
    expect(() => parseArgs(["grant", "nope", "dev"])).toThrow();
    expect(() => parseArgs(["grant", "a@example.com", "dev", "extra"])).toThrow();
  });

  it("its statements run against the real schema", async () => {
    d1.raw().exec(commandSql(parseArgs(["grant", "a@example.com", "admin,dev"]), T0));
    expect(await readGrants(read())).toEqual([
      { email: "a@example.com", permission: "admin" },
      { email: "a@example.com", permission: "dev" },
    ]);
    expect(audits().map((a) => a.actor)).toEqual(["cli", "cli"]);
    // Again: the rows keep their first grant; only the audit says it happened.
    d1.raw().exec(commandSql(parseArgs(["grant", "a@example.com", "dev"]), T0 + 50));
    expect((await listGrants(read())).map((g) => g.granted_at)).toEqual([T0, T0 + 1]);
    expect(audits().map((a) => a.kind)).toEqual([
      "permission.grant",
      "permission.grant",
      "permission.regrant",
    ]);
  });
});

describe("permission history", () => {
  const addUser = (id: string, email: string) =>
    d1
      .raw()
      .prepare(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'x', ?, 1, 1, 1)",
      )
      .run(id, email);

  it("newest first, actor by address, source cli or ui, paged by id", async () => {
    addUser(ME.id, "Admin@Example.com");
    d1.raw()
      .prepare("INSERT INTO security_audit (at_ms, kind, actor, detail) VALUES (?, ?, ?, ?)")
      .run(T0 - 1, "live.on", ME.id, "unrelated");
    await grantPermission(write(), "a@example.com", "admin", ME, T0);
    d1.raw().exec(commandSql(parseArgs(["grant", "b@example.com", "dev"]), T0 + 1));
    await grantPermission(write(), "a@example.com", "admin", ME, T0 + 2);
    await revokePermission(write(), "b@example.com", "dev", { id: "u_gone" }, T0 + 3);

    const all = await readPermissionHistory(read());
    expect(all.next).toBe(null);
    expect(all.rows.map(({ id: _, ...r }) => r)).toEqual([
      {
        at: T0 + 3,
        action: "revoke",
        permission: "dev",
        email: "b@example.com",
        by: "u_gone",
        source: "ui",
      },
      {
        at: T0 + 2,
        action: "regrant",
        permission: "admin",
        email: "a@example.com",
        by: "admin@example.com",
        source: "ui",
      },
      {
        at: T0 + 1,
        action: "grant",
        permission: "dev",
        email: "b@example.com",
        by: "cli",
        source: "cli",
      },
      {
        at: T0,
        action: "grant",
        permission: "admin",
        email: "a@example.com",
        by: "admin@example.com",
        source: "ui",
      },
    ]);

    const p1 = await readPermissionHistory(read(), null, 3);
    expect(p1.rows.map((r) => r.at)).toEqual([T0 + 3, T0 + 2, T0 + 1]);
    expect(p1.next).toBe(p1.rows[2].id);
    const p2 = await readPermissionHistory(read(), p1.next, 3);
    expect(p2.rows.map((r) => r.at)).toEqual([T0]);
    expect(p2.next).toBe(null);
    expect((await readPermissionHistory(read(), Number.NaN, 0)).rows).toHaveLength(4);
  });

  it("an audit row without detail still reads", async () => {
    d1.raw()
      .prepare("INSERT INTO security_audit (at_ms, kind, actor, detail) VALUES (?, ?, ?, NULL)")
      .run(T0, "permission.grant", "cli");
    expect((await readPermissionHistory(read())).rows[0]).toMatchObject({
      permission: "",
      email: "",
      source: "cli",
    });
  });

  it("GET /api/dev/permissions/history: admin only, pages with ?before", async () => {
    const url = (q = "") => new Request(`https://lianki.com/api/dev/permissions/history${q}`);
    expect((await permissionsHistoryGet(url(), null, read)).status).toBe(404);
    expect((await permissionsHistoryGet(url(), ME, () => null)).status).toBe(404);
    for (let i = 0; i < 3; i++)
      await grantPermission(write(), `u${i}@example.com`, "dev", ME, T0 + i);
    const r = await permissionsHistoryGet(url(), ME, read);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const page = (await r.json()) as HistoryPage;
    expect(page.rows.map((x) => x.email)).toEqual([
      "u2@example.com",
      "u1@example.com",
      "u0@example.com",
    ]);
    const older = (await (
      await permissionsHistoryGet(url(`?before=${page.rows[0].id}`), ME, read)
    ).json()) as HistoryPage;
    expect(older.rows).toHaveLength(2);
    const junk = (await (
      await permissionsHistoryGet(url("?before=abc"), ME, read)
    ).json()) as HistoryPage;
    expect(junk.rows).toHaveLength(3);
    expect(readFileSync("app/api/dev/permissions/history/route.ts", "utf8")).toContain(
      "isAdmin(user?.email)",
    );
  });
});

describe("live reads from D1 (no snapshot)", () => {
  const addUser = (id: string, email: string) =>
    d1
      .raw()
      .prepare(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'x', ?, 1, 1, 1)",
      )
      .run(id, email);

  it("readHolders, holderIds, userHolds: only an active grant, by exact address", async () => {
    addUser("u_dev", "Dev@Example.com");
    addUser("u_none", "none@example.com");
    addUser("u_old", "snomiao@gmail.com"); // in site_role (migration 0047): no grant
    await grantPermission(write(), "dev@example.com", "dev", ME, T0);
    await grantPermission(write(), "admin@example.com", "admin", ME, T0 + 1);
    expect(await readHolders(read(), "dev")).toEqual(["dev@example.com"]);
    expect(await readHolders(read(), "admin")).toEqual(["admin@example.com"]);
    expect(await holderIds(read(), "dev")).toEqual(["u_dev"]);
    const first = d1 as unknown as Parameters<typeof userHolds>[0];
    expect(await userHolds(first, "u_dev", "dev")).toBe(true);
    expect(await userHolds(first, "u_dev", "admin")).toBe(false);
    expect(await userHolds(first, "u_none", "dev")).toBe(false);
    expect(await userHolds(first, "u_old", "dev")).toBe(false);
    await revokePermission(write(), "dev@example.com", "dev", ME, T0 + 2);
    expect(await userHolds(first, "u_dev", "dev")).toBe(false);
    expect(await holderIds(read(), "dev")).toEqual([]);
  });

  it("refreshHolders: oldest grant first, [] when unreadable", async () => {
    await grantPermission(write(), "b@example.com", "dev", ME, T0 + 5);
    await grantPermission(write(), "a@example.com", "dev", ME, T0 + 9);
    await grantPermission(write(), "c@example.com", "admin", ME, T0);
    expect(await refreshHolders("dev", read)).toEqual(["b@example.com", "a@example.com"]);
    clearPermissionCache();
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await refreshHolders("dev", () => ({}) as unknown as PermissionReadDb)).toEqual([]);
    } finally {
      err.mockRestore();
    }
  });
});

describe("step c: the old owner role is gone", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((d) => d.isFile() && /\.(ts|tsx|mjs)$/.test(d.name))
      .map((d) => `${d.parentPath}/${d.name}`)
      .filter((f) => !f.includes("node_modules"));

  it("no gate reads site_role, lib/owner, OWNER_EMAILS or isOwner(email)", () => {
    const hits: string[] = [];
    for (const f of [...files("app"), ...files("lib"), ...files("workers"), "auth.ts", "worker.ts"])
      if (
        /FROM site_role|JOIN site_role|@\/lib\/owner\b|lib\/owner-store|lib\/site-role|OWNER_EMAILS|\bisOwner\(\w*\.?email/.test(
          readFileSync(f, "utf8"),
        )
      )
        hits.push(f);
    expect(hits).toEqual([]);
    expect(readFileSync("wrangler.jsonc", "utf8")).not.toContain("OWNER_EMAILS");
  });
});

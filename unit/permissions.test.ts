import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { clearOwnerCache, setOwnerSnapshot } from "@/lib/owner";
import {
  PERMISSION_CACHE_MS,
  PERMISSION_REFRESH_MS,
  clearPermissionCache,
  isAdmin,
  isDev,
  permissionHolders,
  setPermissionSnapshot,
} from "@/lib/permissions";
import { refreshPermissions } from "@/lib/permission-store";
import {
  grantPermission,
  listGrants,
  readGrants,
  revokePermission,
  validPermissionEmail,
  type PermissionDb,
  type PermissionReadDb,
} from "@/lib/account-permission";
import { permissionsGet, permissionsPost } from "@/lib/permission-route";
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
  // No old owners: these tests are about the grants alone.
  setOwnerSnapshot([]);
  d1 = createTestD1(testSchema());
});
afterEach(() => {
  clearPermissionCache();
  clearOwnerCache();
});

describe("isAdmin / isDev", () => {
  it("fail closed: no snapshot grants nothing", () => {
    clearOwnerCache();
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

  it("step a: an old site_role owner still passes both, and is listed as a holder", () => {
    setOwnerSnapshot(["owner@example.com"]);
    expect(isAdmin("owner@example.com")).toBe(true);
    expect(isDev("owner@example.com")).toBe(true);
    setPermissionSnapshot([{ email: "dev@example.com", permission: "dev" }]);
    expect(permissionHolders("dev")).toEqual(["dev@example.com", "owner@example.com"]);
    expect(permissionHolders("admin")).toEqual(["owner@example.com"]);
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
    expect(sql.match(/INSERT INTO security_audit/g)).toHaveLength(2);
    expect(sql).toContain("'cli'");
    expect(() => parseArgs(["grant", "a@example.com", "owner"])).toThrow();
    expect(() => parseArgs(["grant", "a@example.com"])).toThrow();
    expect(parseArgs(["list", "--local"])).toEqual({ cmd: "list", local: true });
  });

  it("its statements run against the real schema", async () => {
    d1.raw().exec(commandSql(parseArgs(["grant", "a@example.com", "admin,dev"]), T0));
    expect(await readGrants(read())).toEqual([
      { email: "a@example.com", permission: "admin" },
      { email: "a@example.com", permission: "dev" },
    ]);
    expect(audits().map((a) => a.actor)).toEqual(["cli", "cli"]);
  });
});

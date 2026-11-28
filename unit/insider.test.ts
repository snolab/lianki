import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  PERMISSIONS,
  clearPermissionCache,
  isAdmin,
  isDev,
  isInsider,
  setPermissionSnapshot,
} from "@/lib/permissions";
import {
  grantPermission,
  readGrants,
  revokePermission,
  type PermissionDb,
  type PermissionReadDb,
} from "@/lib/account-permission";
import { refreshPermissions } from "@/lib/permission-store";
import { AUDIENCE_LABELS, FLAGS, type FlagDef, type FlagKey } from "@/lib/flags";
import { audienceAllows, flagOnFor, inFlagAudience } from "@/lib/flag-audience";
import { isShipped } from "@/app/(app)/dev/flags/flag-view";
import { parseArgs } from "../scripts/dev/permission-sql";

const ME = { id: "u_admin", email: "admin@example.com" };
const T0 = 1_800_000_000_000;
const INSIDER = "insider@example.com";
const ADMIN = "admin@example.com";
const DEV = "dev@example.com";
const NOBODY = "someone@example.com";

beforeEach(() => clearPermissionCache());
afterEach(() => clearPermissionCache());

function grants() {
  setPermissionSnapshot([
    { email: INSIDER, permission: "insider" },
    { email: ADMIN, permission: "admin" },
    { email: DEV, permission: "dev" },
  ]);
}

describe("isInsider", () => {
  it("the insider grant makes an insider, and nothing else", () => {
    grants();
    expect(isInsider(INSIDER)).toBe(true);
    expect(isAdmin(INSIDER)).toBe(false);
    expect(isDev(INSIDER)).toBe(false);
  });

  it("an admin is always an insider; dev alone is not", () => {
    grants();
    expect(isInsider(ADMIN)).toBe(true);
    expect(isInsider(DEV)).toBe(false);
  });

  it("no grant, no address or no snapshot: not an insider (fail closed)", () => {
    expect(isInsider(INSIDER)).toBe(false);
    grants();
    expect(isInsider(NOBODY)).toBe(false);
    expect(isInsider(null)).toBe(false);
    expect(isInsider("")).toBe(false);
    expect(isInsider(" Insider@Example.com ")).toBe(true);
  });
});

describe("account_permission: insider", () => {
  let d1: TestD1Database;
  beforeEach(() => {
    d1 = createTestD1(testSchema());
  });

  it("is grantable and revocable like admin and dev, after migration 0091", async () => {
    const write = d1 as unknown as PermissionDb;
    const read = () => d1 as unknown as PermissionReadDb;
    expect(PERMISSIONS).toContain("insider");
    expect(await grantPermission(write, INSIDER, "insider", ME, T0)).toBe("granted");
    expect(await readGrants(read())).toEqual([{ email: INSIDER, permission: "insider" }]);
    await refreshPermissions(read, () => T0);
    expect(isInsider(INSIDER, T0)).toBe(true);
    expect(await revokePermission(write, INSIDER, "insider", ME, T0 + 1)).toBe("revoked");
    clearPermissionCache();
    await refreshPermissions(read, () => T0 + 2);
    expect(isInsider(INSIDER, T0 + 2)).toBe(false);
  });

  it("the table still refuses a name that is not a permission", () => {
    expect(() =>
      d1
        .raw()
        .exec(
          "INSERT INTO account_permission (email, permission, granted_by, granted_at) VALUES ('a@example.com', 'owner', 't', 1)",
        ),
    ).toThrow();
  });

  it("the break-glass CLI accepts insider", () => {
    expect(parseArgs(["grant", INSIDER, "insider"])).toMatchObject({ permissions: ["insider"] });
  });
});

describe("flag audience", () => {
  const TEST_KEY = "test.insider-only" as FlagKey;
  const registry = FLAGS as unknown as Record<string, FlagDef>;
  beforeEach(() => {
    registry[TEST_KEY] = { description: "test", default: false, audience: "insider" };
  });
  afterEach(() => {
    delete registry[TEST_KEY];
  });

  it("insider: on only for insiders (and admins), and only while switched on", () => {
    grants();
    const on = { [TEST_KEY]: true };
    expect(flagOnFor(on, TEST_KEY, INSIDER)).toBe(true);
    expect(flagOnFor(on, TEST_KEY, ADMIN)).toBe(true);
    expect(flagOnFor(on, TEST_KEY, DEV)).toBe(false);
    expect(flagOnFor(on, TEST_KEY, NOBODY)).toBe(false);
    expect(flagOnFor(on, TEST_KEY, null)).toBe(false);
    expect(flagOnFor({ [TEST_KEY]: false }, TEST_KEY, INSIDER)).toBe(false);
    expect(flagOnFor(null, TEST_KEY, INSIDER)).toBe(false);
  });

  it("insider: never counted as shipped, and badged 仅内测用户", () => {
    expect(isShipped({ key: TEST_KEY, enabled: true })).toBe(false);
    expect(AUDIENCE_LABELS.insider.zh).toBe("仅内测用户");
  });

  it("existing audiences are unchanged", () => {
    grants();
    // No audience: everyone, signed in or not, once on.
    expect(flagOnFor({ "today.goal": true }, "today.goal", NOBODY)).toBe(true);
    expect(flagOnFor({ "today.goal": true }, "today.goal", null)).toBe(true);
    expect(flagOnFor({ "today.goal": false }, "today.goal", ADMIN)).toBe(false);
    // owner: dev holders, as every such call site checks with isDev.
    expect((FLAGS["stt.merge"] as FlagDef).audience).toBe("owner");
    expect(inFlagAudience("stt.merge", DEV)).toBe(true);
    expect(inFlagAudience("stt.merge", INSIDER)).toBe(false);
    expect(inFlagAudience("stt.merge", NOBODY)).toBe(false);
    // allowlist: only the feature knows its list, so the helper fails closed.
    expect((FLAGS["stt.worker"] as FlagDef).audience).toBe("allowlist");
    expect(inFlagAudience("stt.worker", ADMIN)).toBe(false);
    expect(audienceAllows(undefined, null)).toBe(true);
  });

  it("no flag in the registry uses an unknown audience", () => {
    for (const def of Object.values(FLAGS) as FlagDef[])
      if (def.audience) expect(Object.keys(AUDIENCE_LABELS)).toContain(def.audience);
  });
});

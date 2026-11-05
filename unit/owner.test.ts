import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  OWNER_CACHE_MS,
  OWNER_REFRESH_MS,
  clearOwnerCache,
  isOwner,
  setOwnerSnapshot,
} from "@/lib/owner";
import { refreshOwners } from "@/lib/owner-store";
import {
  grantOwner,
  listOwners,
  readOwnerEmails,
  revokeOwner,
  validOwnerEmail,
  type OwnerReadDb,
  type SiteRoleDb,
} from "@/lib/site-role";
import { ownersGet, ownersPost } from "@/lib/site-role-route";
import { CLI_ACTOR, commandSql, inlineSql, parseArgs } from "../scripts/dev/owner-role";

const MAIN = "snomiao@gmail.com";
const SEEDED = "snomiao+admin@gmail.com";
const ME = { id: "u_me", email: SEEDED };
const T0 = 1_800_000_000_000;

let d1: TestD1Database;
const read = () => d1 as unknown as OwnerReadDb;
const write = () => d1 as unknown as SiteRoleDb;
const audits = () =>
  d1
    .raw()
    .prepare(
      "SELECT kind, actor, detail FROM security_audit WHERE kind LIKE 'site-role.%' ORDER BY id",
    )
    .all() as { kind: string; actor: string; detail: string }[];

beforeEach(() => {
  clearOwnerCache();
  d1 = createTestD1(testSchema());
  // Most tests want one owner, so the last-owner rules are in play at once.
  // "the migration" below checks the real seed.
  d1.raw().exec(`DELETE FROM site_role WHERE email = '${MAIN}';
    DELETE FROM security_audit WHERE detail = '${MAIN}'`);
});
afterEach(() => clearOwnerCache());

describe("isOwner", () => {
  it("nobody without a snapshot", () => {
    expect(isOwner(SEEDED)).toBe(false);
  });

  it("matches trimmed and case-insensitively", () => {
    setOwnerSnapshot(["owner@example.com", "other@example.com"]);
    expect(isOwner("Owner@Example.com")).toBe(true);
    expect(isOwner(" other@example.com ")).toBe(true);
  });

  it("refuses others and empty values", () => {
    setOwnerSnapshot(["owner@example.com"]);
    expect(isOwner("someone@example.com")).toBe(false);
    expect(isOwner("")).toBe(false);
    expect(isOwner(null)).toBe(false);
    expect(isOwner(undefined)).toBe(false);
  });

  it("compares a plus address exactly, never in its canonical form", () => {
    const admin = "someone+admin@gmail.com";
    setOwnerSnapshot([admin]);
    expect(isOwner(admin)).toBe(true);
    expect(isOwner("Someone+Admin@Gmail.com")).toBe(true);
    // One mailbox to Gmail, and one canonical form, but not the owner.
    expect(isOwner("someone@gmail.com")).toBe(false);
    expect(isOwner("some.one@gmail.com")).toBe(false);
    expect(isOwner("someone+other@gmail.com")).toBe(false);
    expect(isOwner("someone@googlemail.com")).toBe(false);
    // And the other way round: a plain owner address admits no aliases.
    setOwnerSnapshot(["someone@gmail.com"]);
    expect(isOwner(admin)).toBe(false);
    expect(isOwner("some.one@gmail.com")).toBe(false);
  });

  it("the deploy-time setting is gone: it grants nothing", () => {
    process.env.OWNER_EMAILS = "env-owner@example.com";
    try {
      expect(isOwner("env-owner@example.com")).toBe(false);
    } finally {
      delete process.env.OWNER_EMAILS;
    }
    expect(readFileSync("wrangler.jsonc", "utf8")).not.toContain("OWNER_EMAILS");
  });

  it("a snapshot past the window, or from the future, counts for nothing", () => {
    setOwnerSnapshot(["a@example.com"], T0);
    expect(isOwner("a@example.com", T0 + OWNER_CACHE_MS - 1)).toBe(true);
    expect(isOwner("a@example.com", T0 + OWNER_CACHE_MS)).toBe(false);
    expect(isOwner("a@example.com", T0 - 1)).toBe(false);
  });
});

describe("the migration", () => {
  it("seeds exactly the two owners, main account first, and audits both", async () => {
    d1 = createTestD1(testSchema());
    expect(await readOwnerEmails(read())).toEqual([MAIN, SEEDED]);
    expect(audits()).toEqual([
      { kind: "site-role.grant", actor: "migration-0046", detail: MAIN },
      { kind: "site-role.grant", actor: "migration-0046", detail: SEEDED },
    ]);
    // Both are owners, so either can revoke the other, but not both.
    await refreshOwners(read);
    expect(isOwner(MAIN)).toBe(true);
    expect(isOwner(SEEDED)).toBe(true);
    expect(isOwner("s.nomiao@gmail.com")).toBe(false);
    expect(await revokeOwner(write(), SEEDED, ME, T0)).toBe("revoked");
    expect(await revokeOwner(write(), MAIN, ME, T0 + 1)).toBe("last-owner");
  });

  it("refuses a row that is not lowercased or not an owner", () => {
    const put = (email: string, role = "owner") =>
      d1
        .raw()
        .prepare(
          "INSERT INTO site_role (email, role, granted_by, granted_at) VALUES (?, ?, 't', 1)",
        )
        .run(email, role);
    expect(() => put("Upper@example.com")).toThrow();
    expect(() => put("no-at-sign")).toThrow();
    expect(() => put("a@example.com", "admin")).toThrow();
  });
});

describe("refreshOwners", () => {
  it("a DB grant makes an owner; a revoke ends it", async () => {
    expect(await refreshOwners(read)).toEqual([SEEDED]);
    expect(isOwner(SEEDED)).toBe(true);
    expect(isOwner("new@example.com")).toBe(false);

    expect(await grantOwner(write(), "New@Example.com", ME)).toBe("granted");
    await refreshOwners(read);
    expect(isOwner("new@example.com")).toBe(true);

    expect(await revokeOwner(write(), "new@example.com", ME)).toBe("revoked");
    await refreshOwners(read);
    expect(isOwner("new@example.com")).toBe(false);
  });

  it("reads D1 at most once per refresh window, again after it", async () => {
    let reads = 0;
    const counting = () => {
      reads++;
      return read();
    };
    let t = T0;
    await refreshOwners(counting, () => t);
    t += OWNER_REFRESH_MS - 1;
    await refreshOwners(counting, () => t);
    expect(reads).toBe(1);
    t += 1;
    await refreshOwners(counting, () => t);
    expect(reads).toBe(2);
  });

  it("a revocation in another isolate holds once the cache expires", async () => {
    let t = T0;
    await refreshOwners(read, () => t);
    expect(isOwner(SEEDED, t)).toBe(true);
    // Another isolate's write: this one's cache is not cleared.
    d1.raw().exec("UPDATE site_role SET revoked_at = 1");
    t += OWNER_REFRESH_MS - 1;
    await refreshOwners(read, () => t);
    expect(isOwner(SEEDED, t)).toBe(true); // still inside the window
    t += 1;
    await refreshOwners(read, () => t);
    expect(isOwner(SEEDED, t)).toBe(false);
    // And with no refresh at all, the hard bound still ends it.
    setOwnerSnapshot([SEEDED], T0);
    expect(isOwner(SEEDED, T0 + OWNER_CACHE_MS)).toBe(false);
  });

  it("fails closed on a DB error: nobody, no throw, logged, retried next call", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await refreshOwners(read);
      expect(isOwner(SEEDED)).toBe(true);
      clearOwnerCache();
      const boom = () => ({
        prepare() {
          throw new Error("D1 down");
        },
      });
      expect(await refreshOwners(boom as unknown as () => OwnerReadDb)).toEqual([]);
      expect(isOwner(SEEDED)).toBe(false);
      expect(String(err.mock.calls[0]?.[0])).toContain("owners.read-failed");
      // A binding that cannot even be reached fails the same way.
      expect(
        await refreshOwners(() => {
          throw new Error("no context");
        }),
      ).toEqual([]);
      // Not remembered.
      expect(await refreshOwners(read)).toEqual([SEEDED]);
      expect(isOwner(SEEDED)).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  it("no database (off the D1 backend): nobody", async () => {
    expect(await refreshOwners(() => null)).toEqual([]);
    expect(isOwner(SEEDED)).toBe(false);
  });

  it("a missing table (before the migration) fails closed too", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      d1.raw().exec("DROP TABLE site_role");
      expect(await refreshOwners(read)).toEqual([]);
    } finally {
      err.mockRestore();
    }
  });

  it("a read held past the window is not acted on", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      let t = T0;
      const slow = {
        prepare: () => ({
          bind: () => ({
            all: async () => {
              t += OWNER_CACHE_MS;
              return { results: [{ email: SEEDED }] };
            },
          }),
        }),
      };
      expect(
        await refreshOwners(
          () => slow as unknown as OwnerReadDb,
          () => t,
        ),
      ).toEqual([]);
      expect(isOwner(SEEDED, t)).toBe(false);
    } finally {
      err.mockRestore();
    }
  });

  it("a read that started before a write here does not fill the snapshot", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            await gate;
            return { results: [{ email: "revoked@example.com" }] };
          },
        }),
      }),
    };
    const p = refreshOwners(() => slow as unknown as OwnerReadDb);
    clearOwnerCache(); // what a grant or revoke does
    release();
    await p;
    expect(isOwner("revoked@example.com")).toBe(false);
  });
});

describe("grant and revoke", () => {
  it("validOwnerEmail keeps the address exactly, and refuses what is not one", () => {
    expect(validOwnerEmail(" Some.One+Tag@Gmail.com ")).toBe("some.one+tag@gmail.com");
    for (const bad of [
      "",
      "a",
      "a@b",
      "@b.com",
      "a@@b.com",
      "a b@c.com",
      "a@b.com,c@d.com",
      1,
      null,
    ])
      expect(validOwnerEmail(bad)).toBeNull();
    expect(validOwnerEmail(`${"a".repeat(200)}@b.com`)).toBeNull();
  });

  it("a grant is for that exact address only: dots and +tags stay out", async () => {
    expect(await grantOwner(write(), "someone@gmail.com", ME)).toBe("granted");
    await refreshOwners(read);
    expect(isOwner("someone@gmail.com")).toBe(true);
    expect(isOwner("some.one@gmail.com")).toBe(false);
    expect(isOwner("someone+x@gmail.com")).toBe(false);
    expect(isOwner("someone@googlemail.com")).toBe(false);
  });

  it("a grant clears this isolate's cache at once", async () => {
    await refreshOwners(read);
    await grantOwner(write(), "new@example.com", ME);
    expect(isOwner(SEEDED)).toBe(false); // no snapshot until the next refresh
    await refreshOwners(read);
    expect(isOwner("new@example.com")).toBe(true);
    await revokeOwner(write(), "new@example.com", ME);
    expect(isOwner(SEEDED)).toBe(false);
  });

  it("granting an active owner changes nothing and audits nothing", async () => {
    expect(await grantOwner(write(), SEEDED, ME, T0)).toBe("already-owner");
    expect(audits()).toHaveLength(1); // the migration's
    expect((await listOwners(read()))[0].granted_by).toBe("migration-0046");
  });

  it("each change writes one audit row: who, what, which address", async () => {
    await grantOwner(write(), "new@example.com", ME, T0);
    await revokeOwner(write(), "new@example.com", ME, T0 + 1);
    expect(audits().slice(1)).toEqual([
      { kind: "site-role.grant", actor: ME.id, detail: "new@example.com" },
      { kind: "site-role.revoke", actor: ME.id, detail: "new@example.com" },
    ]);
  });

  it("a revoked address can be granted again", async () => {
    await grantOwner(write(), "new@example.com", ME, T0);
    await revokeOwner(write(), "new@example.com", ME, T0 + 1);
    expect(await grantOwner(write(), "new@example.com", ME, T0 + 2)).toBe("granted");
    expect(await readOwnerEmails(read())).toContain("new@example.com");
  });

  it("the last-owner guard: the only active owner cannot be revoked", async () => {
    expect(await revokeOwner(write(), SEEDED, ME, T0)).toBe("last-owner");
    expect(await readOwnerEmails(read())).toEqual([SEEDED]);
    expect(audits()).toHaveLength(1);
    // With a second owner it can, and then the second is the last.
    await grantOwner(write(), "second@example.com", ME, T0 + 1);
    expect(await revokeOwner(write(), SEEDED, ME, T0 + 2)).toBe("revoked");
    expect(await revokeOwner(write(), "second@example.com", ME, T0 + 3)).toBe("last-owner");
    expect(await readOwnerEmails(read())).toEqual(["second@example.com"]);
  });

  it("revoking an address that is not an owner", async () => {
    expect(await revokeOwner(write(), "nobody@example.com", ME, T0)).toBe("not-owner");
    await grantOwner(write(), "new@example.com", ME, T0 + 1);
    await revokeOwner(write(), "new@example.com", ME, T0 + 2);
    expect(await revokeOwner(write(), "new@example.com", ME, T0 + 3)).toBe("not-owner");
    expect(await revokeOwner(write(), "not an address", ME)).toBe("bad-email");
    expect(await grantOwner(write(), "not an address", ME)).toBe("bad-email");
  });

  it("the oldest grant comes first (the dev bridge's owner)", async () => {
    await grantOwner(write(), "a-later@example.com", ME, 1_900_000_000_000);
    expect((await readOwnerEmails(read()))[0]).toBe(SEEDED);
  });
});

describe("/api/dev/owners", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://lianki.com/api/dev/owners", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://lianki.com",
        host: "lianki.com",
        "sec-fetch-site": "same-origin",
        ...headers,
      },
      body: JSON.stringify(body),
    });

  it("a non-owner gets an empty 404, reads and writes alike, and changes nothing", async () => {
    const g = await ownersGet(null, write);
    expect(g.status).toBe(404);
    expect(await g.text()).toBe("");
    const p = await ownersPost(post({ op: "grant", email: "evil@example.com" }), null, write);
    expect(p.status).toBe(404);
    expect(await p.text()).toBe("");
    expect(await readOwnerEmails(read())).toEqual([SEEDED]);
    // Off D1: also 404.
    expect((await ownersGet(ME, () => null)).status).toBe(404);
    expect((await ownersPost(post({}), ME, () => null)).status).toBe(404);
  });

  it("the route's gate is isOwner, per handler", () => {
    const src = readFileSync("app/api/dev/owners/route.ts", "utf8");
    expect(src).toContain("isOwner(user?.email)");
    expect(src).toContain("ownersGet(await owner(), db)");
    expect(src).toContain("ownersPost(req, await owner(), db)");
    expect(readFileSync("app/(app)/dev/owners/page.tsx", "utf8")).toContain(
      "if (!isOwner(user?.email)) notFound();",
    );
  });

  it("lists, grants and revokes", async () => {
    const list = (await (await ownersGet(ME, write)).json()) as { owners: { email: string }[] };
    expect(list.owners.map((o) => o.email)).toEqual([SEEDED]);
    const g = await ownersPost(post({ op: "grant", email: "new@example.com" }), ME, write);
    expect(g.status).toBe(200);
    const gj = (await g.json()) as { result: string; owners: { email: string }[] };
    expect(gj.result).toBe("granted");
    expect(gj.owners.map((o) => o.email).sort()).toEqual(["new@example.com", SEEDED]);
    const r = await ownersPost(post({ op: "revoke", email: "new@example.com" }), ME, write);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { result: string }).result).toBe("revoked");
  });

  it("the answers: last owner 409, not an owner 409, bad input 400, cross-origin 403", async () => {
    const last = await ownersPost(post({ op: "revoke", email: SEEDED }), ME, write);
    expect(last.status).toBe(409);
    expect(((await last.json()) as { result: string }).result).toBe("last-owner");
    const none = await ownersPost(post({ op: "revoke", email: "no@example.com" }), ME, write);
    expect(none.status).toBe(409);
    expect((await ownersPost(post({ op: "grant", email: "nope" }), ME, write)).status).toBe(400);
    expect((await ownersPost(post({ op: "revoke", email: "nope" }), ME, write)).status).toBe(400);
    expect((await ownersPost(post({ op: "wat" }), ME, write)).status).toBe(400);
    const cross = post(
      { op: "grant", email: "evil@example.com" },
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    );
    expect((await ownersPost(cross, ME, write)).status).toBe(403);
    expect(await readOwnerEmails(read())).toEqual([SEEDED]);
  });

  it("a grant says nothing about whether the address has an account", async () => {
    const r = await ownersPost(post({ op: "grant", email: "ghost@example.com" }), ME, write);
    const j = (await r.json()) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(["cacheSeconds", "owners", "result"]);
    expect(readFileSync("lib/site-role.ts", "utf8")).not.toMatch(/FROM user\b/);
  });
});

describe("owner checks with no session to refresh the list", () => {
  it("each refreshes it before it asks", () => {
    for (const f of [
      "app/api/debug/partner-ticket/route.ts",
      "lib/payments/webhook.ts",
      "lib/payments/stripe-webhook.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect({ f, refreshed: src.indexOf("await refreshOwners(") >= 0 }).toEqual({
        f,
        refreshed: true,
      });
    }
  });
});

describe("the break-glass CLI", () => {
  it("parses its commands, and refuses anything else", () => {
    expect(parseArgs(["list"])).toEqual({ cmd: "list", local: false });
    expect(parseArgs(["grant", "A@b.com", "--local"])).toEqual({
      cmd: "grant",
      email: "a@b.com",
      local: true,
    });
    expect(() => parseArgs([])).toThrow("usage");
    expect(() => parseArgs(["list", "x"])).toThrow("usage");
    expect(() => parseArgs(["revoke"])).toThrow("not a complete address");
    expect(() => parseArgs(["grant", "a@b.com", "extra"])).toThrow("usage");
    expect(() => parseArgs(["delete", "a@b.com"])).toThrow("usage");
  });

  it("inlines values safely", () => {
    expect(inlineSql("?2 ?1", ["o'brien", 5.9])).toBe("5 'o''brien'");
    expect(inlineSql("?1", ["?1"])).toBe("'?1'");
    expect(() => inlineSql("?3", [])).toThrow();
  });

  const run = (p: Parameters<typeof commandSql>[0], now: number) =>
    d1.raw().exec(commandSql(p, now));

  it("runs the same rules: grant, audit, last-owner guard", async () => {
    run({ cmd: "revoke", email: SEEDED, local: false }, T0);
    expect(await readOwnerEmails(read())).toEqual([SEEDED]);
    expect(audits()).toHaveLength(1);

    run({ cmd: "grant", email: "new@example.com", local: false }, T0 + 1);
    expect((await readOwnerEmails(read())).sort()).toEqual(["new@example.com", SEEDED]);
    run({ cmd: "grant", email: "new@example.com", local: false }, T0 + 2); // already: no-op
    run({ cmd: "revoke", email: SEEDED, local: false }, T0 + 3);
    expect(await readOwnerEmails(read())).toEqual(["new@example.com"]);
    expect(audits().slice(1)).toEqual([
      { kind: "site-role.grant", actor: CLI_ACTOR, detail: "new@example.com" },
      { kind: "site-role.revoke", actor: CLI_ACTOR, detail: SEEDED },
    ]);
    expect(commandSql({ cmd: "list", local: false }, T0)).toContain("FROM site_role");
  });
});

/**
 * Dev access tokens (lib/dev-access.ts) against the real migration on an
 * in-memory SQLite: minting, verifying, expiry, revoking, and the profile
 * menu's single-use handoff.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import {
  HANDOFF_TTL_MS,
  MAX_LIVE_TOKENS,
  SESSION_MAX_MS,
  activeIds,
  listTokens,
  looksLikeToken,
  mintHandoff,
  mintToken,
  revokeAll,
  revokeToken,
  verifyToken,
  type DevAccessDb,
} from "../lib/dev-access";

const SCHEMA =
  "CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT);\n" +
  readFileSync(new URL("../db/migrations/0021_dev_access_token.sql", import.meta.url), "utf8");
const OWNER = { id: "u1", email: "owner@example.com" };
const OWNERS = [OWNER.email];
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

let db: DevAccessDb;
beforeEach(() => {
  const d = createTestD1(SCHEMA);
  d.raw().exec(
    "INSERT INTO user (id, email) VALUES ('u1', 'owner@example.com'), ('u2', 'friend@example.com')",
  );
  db = d as unknown as DevAccessDb;
});

describe("dev access tokens", () => {
  test("minted once, stored only as a hash, verified as its minter", async () => {
    const t = await mintToken(db, OWNER, "iPhone", 30, T0);
    expect(looksLikeToken(t.token)).toBe(true);
    expect(t.expiresMs).toBe(T0 + 30 * DAY);
    const raw = JSON.stringify(
      (db as unknown as { raw(): { prepare(q: string): { all(): unknown[] } } })
        .raw()
        .prepare("SELECT * FROM dev_access_token")
        .all(),
    );
    expect(raw).not.toContain(t.token);
    const v = await verifyToken(db, t.token, OWNERS, T0 + 1000);
    expect(v).toMatchObject({ id: t.id, email: OWNER.email, kind: "token" });
    // A session from it lasts 12 h at most, and never past the token.
    expect(v?.sessionUntilMs).toBe(T0 + 1000 + SESSION_MAX_MS);
    const late = await verifyToken(db, t.token, OWNERS, T0 + 30 * DAY - 1000);
    expect(late?.sessionUntilMs).toBe(T0 + 30 * DAY);
  });

  test("a named token works many times until it expires", async () => {
    const t = await mintToken(db, OWNER, "Mac", 1, T0);
    expect(await verifyToken(db, t.token, OWNERS, T0 + 10)).not.toBeNull();
    expect(await verifyToken(db, t.token, OWNERS, T0 + 20)).not.toBeNull();
    expect(await verifyToken(db, t.token, OWNERS, T0 + DAY + 1)).toBeNull();
    expect(await activeIds(db, [t.id], OWNERS, T0 + DAY + 1)).toEqual([]);
  });

  test("revoking ends the token and its sessions", async () => {
    const t = await mintToken(db, OWNER, "iPhone", 30, T0);
    expect(await activeIds(db, [t.id], OWNERS, T0)).toEqual([t.id]);
    expect(await revokeToken(db, OWNER.id, t.id, T0 + 5)).toBe(true);
    expect(await revokeToken(db, OWNER.id, t.id, T0 + 6)).toBe(false); // once
    expect(await verifyToken(db, t.token, OWNERS, T0 + 10)).toBeNull();
    expect(await activeIds(db, [t.id], OWNERS, T0 + 10)).toEqual([]);
  });

  test("only the minter can revoke it", async () => {
    const t = await mintToken(db, OWNER, "iPhone", 30, T0);
    expect(await revokeToken(db, "u2", t.id, T0)).toBe(false);
    expect(await activeIds(db, [t.id], OWNERS, T0)).toEqual([t.id]);
  });

  test("end all: every token and handoff session", async () => {
    const a = await mintToken(db, OWNER, "a", 7, T0);
    const h = await mintHandoff(db, OWNER, T0);
    await verifyToken(db, h.token, OWNERS, T0 + 1);
    await revokeAll(db, OWNER.id, T0 + 2);
    expect(await activeIds(db, [a.id, h.id], OWNERS, T0 + 3)).toEqual([]);
  });

  test("a token minted by someone who is no longer an owner signs no one in", async () => {
    const t = await mintToken(db, OWNER, "old", 30, T0);
    expect(await verifyToken(db, t.token, ["someone-else@example.com"], T0)).toBeNull();
    expect(await activeIds(db, [t.id], ["someone-else@example.com"], T0)).toEqual([]);
  });

  test("garbage and unknown tokens are refused without a lookup error", async () => {
    for (const x of ["", "x", "lkdev_short", 42, null, `lkdev_${"A".repeat(43)}`])
      expect(await verifyToken(db, x, OWNERS, T0)).toBeNull();
  });

  test("names, lifetimes and the live-token cap are checked", async () => {
    await expect(mintToken(db, OWNER, "  ", 7, T0)).rejects.toThrow("name");
    await expect(mintToken(db, OWNER, "x", 0, T0)).rejects.toThrow("days");
    await expect(mintToken(db, OWNER, "x", 91, T0)).rejects.toThrow("days");
    for (let i = 0; i < MAX_LIVE_TOKENS; i++) await mintToken(db, OWNER, `t${i}`, 7, T0);
    await expect(mintToken(db, OWNER, "one more", 7, T0)).rejects.toThrow("at most");
    expect(await listTokens(db, OWNER.id)).toHaveLength(MAX_LIVE_TOKENS);
  });

  test("the list never carries the token or its hash", async () => {
    const t = await mintToken(db, OWNER, "iPhone", 30, T0);
    const list = await listTokens(db, OWNER.id);
    expect(JSON.stringify(list)).not.toContain(t.token);
    expect(Object.keys(list[0])).not.toContain("token_hash");
  });
});

describe("the profile menu's handoff", () => {
  test("single use: the second try fails, even at once", async () => {
    const h = await mintHandoff(db, OWNER, T0);
    const [a, b] = await Promise.all([
      verifyToken(db, h.token, OWNERS, T0 + 1),
      verifyToken(db, h.token, OWNERS, T0 + 1),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await verifyToken(db, h.token, OWNERS, T0 + 2)).toBeNull();
  });

  test("dies 60 s after it was made, unused", async () => {
    const h = await mintHandoff(db, OWNER, T0);
    expect(await verifyToken(db, h.token, OWNERS, T0 + HANDOFF_TTL_MS + 1)).toBeNull();
  });

  test("its session lasts 12 h after use, then ends", async () => {
    const h = await mintHandoff(db, OWNER, T0);
    const v = await verifyToken(db, h.token, OWNERS, T0 + 10);
    expect(v).toMatchObject({ kind: "handoff", sessionUntilMs: T0 + 10 + SESSION_MAX_MS });
    expect(await activeIds(db, [h.id], OWNERS, T0 + SESSION_MAX_MS)).toEqual([h.id]);
    expect(await activeIds(db, [h.id], OWNERS, T0 + 10 + SESSION_MAX_MS + 1)).toEqual([]);
  });

  test("an unused handoff carries no session", async () => {
    const h = await mintHandoff(db, OWNER, T0);
    expect(await activeIds(db, [h.id], OWNERS, T0 + 1)).toEqual([]);
  });
});

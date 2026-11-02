import { describe, test, expect, beforeEach } from "bun:test";
// Must come first: registers the process-wide module mocks (lib/d1, Mongo ApiTokens).
import { useApiTokensCollection, useBackend, useD1 } from "./support/testMocks";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import type { D1Like } from "@/lib/d1/types";
import { ApiTokensD1Repo } from "@/lib/repos/d1Repos";
import { getEmailByToken, hashToken } from "@/lib/apiTokenAuth";

const SCHEMA = testSchema();
const TOKEN = "lk_" + "ab".repeat(32); // fixture, not a real token
const EMAIL = "u@example.com";

let d1: TestD1Database;
let repo: ApiTokensD1Repo;
/** hashes the Mongo ApiTokens collection was asked for */
let mongoAsked: string[];

beforeEach(async () => {
  d1 = createTestD1(SCHEMA);
  repo = new ApiTokensD1Repo(d1 as unknown as D1Like);
  mongoAsked = [];
  // The frozen Mongo copy still "knows" the token — on D1 it must never be asked.
  useApiTokensCollection({
    findOne: async ({ tokenHash }: { tokenHash: string }) => {
      mongoAsked.push(tokenHash);
      return tokenHash === hashToken(TOKEN) ? { tokenHash, email: EMAIL } : null;
    },
  });
  useD1(d1);
  useBackend("d1");
  await repo.insert({
    tokenHash: hashToken(TOKEN),
    email: EMAIL,
    name: "cli",
    createdAt: new Date(),
  });
});

describe("getEmailByToken on D1 (production)", () => {
  test("finds a token stored in D1", async () => {
    expect(await getEmailByToken(TOKEN)).toBe(EMAIL);
    expect(mongoAsked).toEqual([]);
  });

  test("refuses a token revoked in D1, though the Mongo copy still has it", async () => {
    await repo.delete(hashToken(TOKEN));
    expect(await getEmailByToken(TOKEN)).toBeNull();
    expect(mongoAsked).toEqual([]);
  });

  test("refuses an unknown token and an empty one, without asking Mongo", async () => {
    expect(await getEmailByToken("lk_unknown")).toBeNull();
    expect(await getEmailByToken("")).toBeNull();
    expect(mongoAsked).toEqual([]);
  });

  test("the lookup module does not import MongoDB statically", () => {
    const src = readFileSync(new URL("../lib/apiTokenAuth.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^import[^\n]*(app\/db|mongodb|getApiTokensCollection)/m);
  });
});

describe("getEmailByToken on MongoDB (rollback backend)", () => {
  test("asks Mongo by hash and never touches D1", async () => {
    useBackend("mongodb");
    useD1({
      prepare: () => {
        throw new Error("D1 must not be used on the mongodb backend");
      },
    });
    expect(await getEmailByToken(TOKEN)).toBe(EMAIL);
    expect(await getEmailByToken("lk_unknown")).toBeNull();
    expect(mongoAsked).toEqual([hashToken(TOKEN), hashToken("lk_unknown")]);
  });
});

describe("hash compare", () => {
  test("hashToken is SHA-256 hex of the plain token", () => {
    const h = hashToken(TOKEN);
    expect(h).toBe(createHash("sha256").update(TOKEN).digest("hex"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(TOKEN);
  });

  test("the stored hash itself is not accepted as a token", async () => {
    expect(await getEmailByToken(hashToken(TOKEN))).toBeNull();
  });

  test("a token differing in one character or in case is refused", async () => {
    expect(await getEmailByToken(TOKEN.slice(0, -1) + "c")).toBeNull();
    expect(await getEmailByToken(TOKEN.toUpperCase())).toBeNull();
  });

  test("injected deps work without the request context", async () => {
    let mongo = 0;
    const email = await getEmailByToken(TOKEN, {
      backend: () => "d1",
      d1: () => d1 as unknown as D1Like,
      mongoEmailByHash: async () => (mongo++, EMAIL),
    });
    expect(email).toBe(EMAIL);
    expect(mongo).toBe(0);
  });
});

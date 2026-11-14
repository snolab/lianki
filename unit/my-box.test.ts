import { beforeEach, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { insertBinding, type BoxDb } from "@/lib/box-oauth/store";
import { myBox, revokeMyBox } from "@/lib/box-oauth/my-box";

let db: TestD1Database;
const boxDb = () => db as unknown as BoxDb;
beforeEach(async () => {
  db = createTestD1(testSchema());
  const at = new Date().toISOString();
  for (const id of ["a", "b"]) {
    await db
      .prepare(
        "INSERT INTO user (id,email,name,emailVerified,createdAt,updatedAt) VALUES (?1,?2,?1,1,?3,?3)",
      )
      .bind(id, `${id}@test.example`, at)
      .run();
    await db
      .prepare("INSERT INTO oauthClient (id,clientId,redirectUris) VALUES (?1,?1,'[]')")
      .bind(`client-${id}`)
      .run();
    await insertBinding(
      boxDb(),
      {
        clientId: `client-${id}`,
        userId: id,
        origin: `https://my-${id}.lianki.com`,
        scopes: ["box:read", "box:write"],
      },
      "test",
    );
  }
});

it("returns only the own current box, with no other account metadata", async () => {
  expect(await myBox(boxDb(), "a")).toMatchObject({
    clientId: "client-a",
    origin: "https://my-a.lianki.com",
  });
  expect(Object.keys((await myBox(boxDb(), "a"))!).sort()).toEqual([
    "clientId",
    "createdAt",
    "origin",
    "scopes",
  ]);
  expect(await myBox(boxDb(), "missing")).toBeNull();
});

it("rejects another account box id and malformed ids without revoking or notifying", async () => {
  const notified: string[] = [];
  const d = {
    db: boxDb(),
    userId: "a",
    notify: async (id: string) => {
      notified.push(id);
    },
  };
  for (const id of ["client-b", "", null, {}, ["client-a"]])
    expect(await revokeMyBox(d, id)).toBe(false);
  expect(await myBox(boxDb(), "b")).not.toBeNull();
  expect(await myBox(boxDb(), "a")).not.toBeNull();
  expect(notified).toEqual([]);
});

it("own revocation disables the OAuth client and access/refresh tokens, audits and notifies", async () => {
  const at = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO oauthAccessToken (id,token,clientId,userId,expiresAt,createdAt,scopes) VALUES ('ta','hash','client-a','a',?1,?1,'box:read')",
    )
    .bind(at)
    .run();
  await db
    .prepare(
      "INSERT INTO oauthRefreshToken (id,token,clientId,userId,expiresAt,createdAt,scopes) VALUES ('ra','hash-r','client-a','a',?1,?1,'box:read')",
    )
    .bind(at)
    .run();
  const notified: string[] = [];
  const d = {
    db: boxDb(),
    userId: "a",
    notify: async (id: string) => {
      notified.push(id);
    },
  };
  expect(await revokeMyBox(d, "client-a")).toBe(true);
  expect(await myBox(boxDb(), "a")).toBeNull();
  expect(await myBox(boxDb(), "b")).not.toBeNull();
  expect(
    (
      await db
        .prepare("SELECT disabled FROM oauthClient WHERE clientId='client-a'")
        .first<{ disabled: number }>()
    )?.disabled,
  ).toBe(1);
  for (const table of ["oauthAccessToken", "oauthRefreshToken"])
    expect(
      (
        await db
          .prepare(`SELECT revoked FROM ${table} WHERE clientId='client-a'`)
          .first<{ revoked: string }>()
      )?.revoked,
    ).toBeTruthy();
  expect(notified).toEqual(["client-a"]);
  expect(await revokeMyBox(d, "client-a")).toBe(false);
  expect(notified).toEqual(["client-a"]);
  expect(
    await db.prepare("SELECT actor,subject FROM security_audit WHERE kind='box.revoke'").first(),
  ).toMatchObject({ actor: "a", subject: "a" });
});

it("a stale page cannot revoke the replacement binding", async () => {
  const d = { db: boxDb(), userId: "a", notify: async () => {} };
  expect(await revokeMyBox(d, "client-a")).toBe(true);
  await db
    .prepare(
      "INSERT INTO oauthClient (id,clientId,redirectUris) VALUES ('replacement','replacement','[]')",
    )
    .run();
  expect(
    await insertBinding(
      boxDb(),
      {
        clientId: "replacement",
        userId: "a",
        origin: "https://my-new.lianki.com",
        scopes: ["box:read"],
      },
      "test",
    ),
  ).toBe(true);
  expect(await revokeMyBox(d, "client-a")).toBe(false);
  expect(await myBox(boxDb(), "a")).toMatchObject({ clientId: "replacement" });
});

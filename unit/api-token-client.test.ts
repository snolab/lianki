// Which client used a token (lib/api-token-client.ts): only `lianki mcp`'s
// exact header shape reaches the audit log, card routes log a named client's
// use at most once a minute, and a token can describe itself (describeToken).
import { beforeEach, describe, expect, test } from "bun:test";
import { useBackend, useD1 } from "./support/testMocks";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { auditClientUse, clientOf } from "@/lib/api-token-client";
import { getEmailByToken } from "@/lib/apiTokenAuth";
import { describeToken } from "@/lib/api-tokens";
import { sha256Hex } from "@/lib/security/throttle";

const SCHEMA = testSchema();
const TOKEN = `lk_${"c".repeat(64)}`; // fixture, not a real token
let d1: TestD1Database;
const db = () => d1 as unknown as D1Like;
const audits = () =>
  d1
    .raw()
    .prepare(
      "SELECT kind, actor, subject, detail FROM security_audit WHERE kind LIKE 'api-token.%'",
    )
    .all() as {
    kind: string;
    actor: string;
    subject: string;
    detail: string;
  }[];

async function seed(scopes = '["study","chat:read"]', expires: string | null = null) {
  d1.raw()
    .prepare(
      "INSERT INTO api_tokens (token_hash, email, name, created_at, user_id, scopes, expires_at) VALUES (?, 'u1@example.com', 'my AI', '', 'u1', ?, ?)",
    )
    .run(await sha256Hex(TOKEN), scopes, expires);
}

beforeEach(() => {
  d1 = createTestD1(SCHEMA);
  useD1(d1);
  useBackend("d1");
  d1.raw()
    .prepare(
      "INSERT INTO user (id, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'u1@example.com', 1, '2026-11-01', '2026-11-01')",
    )
    .run();
});

describe("clientOf: only the one known shape", () => {
  test("mcp/<version> tool=<lianki tool>", () => {
    expect(clientOf("mcp/0.4.0 tool=lianki_due")).toBe("mcp/0.4.0 lianki_due");
    expect(clientOf("mcp/1.2.3-beta.1 tool=lianki_chat_say")).toBe(
      "mcp/1.2.3-beta.1 lianki_chat_say",
    );
  });
  test("anything else is dropped", () => {
    for (const v of [
      null,
      undefined,
      42,
      "",
      "mcp/0.4.0",
      "mcp/0.4.0 tool=rm_rf",
      "mcp/x tool=lianki_due",
      "mcp/0.4.0 tool=lianki_due; drop table",
      "curl/8 tool=lianki_due",
      `mcp/0.4.0 tool=lianki_${"a".repeat(200)}`,
    ])
      expect(clientOf(v)).toBeNull();
  });
});

describe("card routes: a named client's use is audited", () => {
  test("with the header: one api-token.use row, by tag, never the token", async () => {
    await seed();
    expect(await getEmailByToken(TOKEN, undefined, "mcp/0.4.0 lianki_due")).toBe("u1@example.com");
    // The same minute: last_used_at is not written again, so no second row.
    expect(await getEmailByToken(TOKEN, undefined, "mcp/0.4.0 lianki_stats")).toBe(
      "u1@example.com",
    );
    const rows = audits();
    expect(rows).toEqual([
      {
        kind: "api-token.use",
        actor: "u1",
        subject: (await sha256Hex(TOKEN)).slice(0, 16),
        detail: "study my AI via mcp/0.4.0 lianki_due",
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(TOKEN.slice(3));
  });
  test("without it: nothing logged, as before", async () => {
    await seed();
    expect(await getEmailByToken(TOKEN)).toBe("u1@example.com");
    expect(audits()).toEqual([]);
  });
  test("a refused token logs no use", async () => {
    await seed('["chat:read"]');
    expect(await getEmailByToken(TOKEN, undefined, "mcp/0.4.0 lianki_due")).toBeNull();
    expect(audits()).toEqual([]);
    await auditClientUse(db(), { ok: false, reason: "unknown" }, "mcp/0.4.0 lianki_due", "study");
    expect(audits()).toEqual([]);
  });
});

describe("describeToken: a token asks what it may do", () => {
  test("a live token: its name, permissions and expiry", async () => {
    await seed('["study","chat:ask"]', "2099-01-01T00:00:00.000Z");
    expect(await describeToken(db(), TOKEN)).toEqual({
      name: "my AI",
      scopes: ["study", "chat:ask"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    // Read-only: no last-used write.
    const r = d1.raw().prepare("SELECT last_used_at FROM api_tokens").get() as {
      last_used_at: string | null;
    };
    expect(r.last_used_at).toBeNull();
  });
  test("expired, unknown, malformed or account gone: null", async () => {
    await seed('["study"]', "2020-01-01T00:00:00.000Z");
    expect(await describeToken(db(), TOKEN)).toBeNull();
    expect(await describeToken(db(), `lk_${"d".repeat(64)}`)).toBeNull();
    expect(await describeToken(db(), "nope")).toBeNull();
    expect(await describeToken(db(), 7)).toBeNull();
    d1.raw().prepare("UPDATE api_tokens SET expires_at = NULL").run();
    d1.raw().prepare("DELETE FROM user").run();
    expect(await describeToken(db(), TOKEN)).toBeNull();
  });
});

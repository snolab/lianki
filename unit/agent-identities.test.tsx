import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mockIntlayer } from "./intlayer-mock";
mockIntlayer("en");
beforeEach(() => mockIntlayer("en"));
const { default: TokenManager } = await import("../app/(app)/my/preferences/TokenManager");
import { createTestD1, type TestD1Database } from "../lib/d1/testDb";
import { testSchema } from "../lib/d1/testSchema";
import type { D1Like } from "../lib/d1/types";
import { checkToken, renameSelfToken } from "../lib/api-tokens";
import { tokenApi, type TokenApiDeps } from "../lib/api-token-api";
import { identityApi } from "../lib/identity-api";
import { TOOLS, toolsFor, runTool } from "../packages/lianki-cli/mcp-tools.mjs";
import { call as apiCall } from "../packages/lianki-cli/api.mjs";
import { run as runCli } from "../packages/lianki-cli/cli.mjs";
import { stubGlobals } from "./support/globals";

const now = Date.parse("2026-11-27T00:00:00Z");
const owner = { userId: "u1", email: "u1@example.com" };

function makeDeps(db: TestD1Database, allowUntitled: boolean): TokenApiDeps {
  return {
    db: () => db as unknown as D1Like,
    who: async () => owner,
    revoked: async () => {},
    now: () => now,
    allowUntitled: async () => allowUntitled,
  };
}

function jsonReq(method: string, body: unknown): Request {
  return new Request("https://lianki.com/api/token", {
    method,
    headers: {
      "content-type": "application/json",
      origin: "https://lianki.com",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

describe("agent identities backend gate & naming", () => {
  let db: TestD1Database;

  beforeEach(() => {
    db = createTestD1(testSchema());
    db.raw().exec(
      "INSERT INTO user(id,email,emailVerified,createdAt,updatedAt) VALUES('u1','u1@example.com',1,'2026-11-01','2026-11-01')",
    );
  });

  test("untitled token creation requires allowUntitled and is gated until named", async () => {
    const blocked = await tokenApi(
      jsonReq("POST", { untitled: true, scopes: ["identity:self", "study"], expiry: { days: 90 } }),
      makeDeps(db, false),
    );
    expect(blocked.status).toBe(403);

    const created = await tokenApi(
      jsonReq("POST", { untitled: true, scopes: ["identity:self", "study"], expiry: { days: 90 } }),
      makeDeps(db, true),
    );
    expect(created.status).toBe(200);
    const { token, id, name } = (await created.json()) as {
      token: string;
      id: string;
      name: string;
    };
    expect(name).toBe("");

    // Normal calls are refused while untitled.
    const gated = await checkToken(db as unknown as D1Like, token, "study", now);
    expect(gated).toMatchObject({ ok: false, reason: "untitled", id, userId: "u1" });

    // Authenticated identity:self bootstrap is exempt from the name-before-use gate.
    const bootstrap = await checkToken(db as unknown as D1Like, token, "identity:self", now, {
      allowUntitled: true,
    });
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) throw new Error("expected bootstrap ok");
    expect(bootstrap.id).toBe(id);

    // Self-naming unlocks normal calls and permanently closes the bootstrap.
    expect(await renameSelfToken(db as unknown as D1Like, id, "Claude Desktop")).toBe(true);
    expect(await renameSelfToken(db as unknown as D1Like, id, "Second Name")).toBe(false);
    const unlocked = await checkToken(db as unknown as D1Like, token, "study", now);
    expect(unlocked.ok).toBe(true);
    if (unlocked.ok) expect(unlocked.name).toBe("Claude Desktop");
  });

  test("POST /api/my/identity is atomically one-shot under concurrency and rate-limited", async () => {
    const minted = await tokenApi(
      jsonReq("POST", { untitled: true, scopes: ["identity:self"], expiry: { days: 90 } }),
      makeDeps(db, true),
    );
    const { token } = (await minted.json()) as { token: string };

    const callSetName = (name: string) =>
      identityApi(
        new Request("https://lianki.com/api/my/identity", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ name }),
        }),
        { db: () => db as unknown as D1Like, allowed: async () => true, now: () => now },
      );

    // Concurrent calls: exactly one 200 and one 409; subsequent call is also 409.
    const [r1, r2] = await Promise.all([callSetName("Alpha"), callSetName("Beta")]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const r3 = await callSetName("Gamma");
    expect(r3.status).toBe(409);

    // Rate limit (default 10 calls/10min): remaining calls hit 429.
    let saw429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await callSetName(`Extra${i}`);
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });

  test("Settings PATCH /api/token renames an untitled token and unlocks it", async () => {
    const created = await tokenApi(
      jsonReq("POST", { untitled: true, scopes: ["study"], expiry: { days: 90 } }),
      makeDeps(db, true),
    );
    const { token, id } = (await created.json()) as { token: string; id: string };
    expect(await checkToken(db as unknown as D1Like, token, "study", now)).toMatchObject({
      ok: false,
      reason: "untitled",
      id,
      userId: "u1",
    });

    const renamed = await tokenApi(jsonReq("PATCH", { id, name: "My Agent" }), makeDeps(db, true));
    expect(renamed.status).toBe(200);

    const unlocked = await checkToken(db as unknown as D1Like, token, "study", now);
    expect(unlocked.ok).toBe(true);
    if (unlocked.ok) expect(unlocked.name).toBe("My Agent");
  });

  test("flag-off and non-owner get 403 on all identity issuance and mutation paths", async () => {
    // Flag off or non-owner -> allowUntitled returns false -> 403 on untitled and identity:self
    const untitled403 = await tokenApi(
      jsonReq("POST", { untitled: true, scopes: ["identity:self"], expiry: { days: 90 } }),
      makeDeps(db, false),
    );
    expect(untitled403.status).toBe(403);

    const scope403 = await tokenApi(
      jsonReq("POST", { name: "Agent", scopes: ["identity:self"], expiry: { days: 90 } }),
      makeDeps(db, false),
    );
    expect(scope403.status).toBe(403);

    // Mint while allowed, then disable flag / switch to non-owner -> PATCH and /api/my/identity return 403
    const created = await tokenApi(
      jsonReq("POST", { untitled: true, scopes: ["identity:self"], expiry: { days: 90 } }),
      makeDeps(db, true),
    );
    const { token, id } = (await created.json()) as { token: string; id: string };

    const patch403 = await tokenApi(jsonReq("PATCH", { id, name: "New" }), makeDeps(db, false));
    expect(patch403.status).toBe(403);

    const whoami403 = await identityApi(
      new Request("https://lianki.com/api/my/identity", {
        headers: { authorization: `Bearer ${token}` },
      }),
      { db: () => db as unknown as D1Like, allowed: async () => false, now: () => now },
    );
    expect(whoami403.status).toBe(403);

    const setName403 = await identityApi(
      new Request("https://lianki.com/api/my/identity", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "Arden" }),
      }),
      { db: () => db as unknown as D1Like, allowed: async () => false, now: () => now },
    );
    expect(setName403.status).toBe(403);
  });

  test("end-to-end synthetic first connect: MCP tools and CLI whoami / set-name", async () => {
    // 1. An identity:self token sees ONLY lianki_whoami and lianki_set_name in MCP tools/list.
    const selfTools = toolsFor(["identity:self"]).map((t: { name: string }) => t.name);
    expect(selfTools).toEqual(["lianki_whoami", "lianki_set_name"]);

    // 2. Mint an untitled token with identity:self + study.
    const minted = await tokenApi(
      jsonReq("POST", { untitled: true, scopes: ["identity:self", "study"], expiry: { days: 90 } }),
      makeDeps(db, true),
    );
    const { token } = (await minted.json()) as { token: string };

    // 3. Normal study call is refused until named.
    expect(await checkToken(db as unknown as D1Like, token, "study", now)).toMatchObject({
      ok: false,
      reason: "untitled",
    });

    const routeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req =
        typeof input === "string"
          ? new Request(input, init)
          : input instanceof URL
            ? new Request(input.toString(), init)
            : input;
      return identityApi(req, {
        db: () => db as unknown as D1Like,
        allowed: async () => true,
        now: () => now,
      });
    };

    // 4. CLI whoami works while untitled.
    const cliOut: string[] = [];
    const code1 = await runCli(["whoami", "--json"], {
      env: { LIANKI_TOKEN: token },
      version: "0.0.0-test",
      fetch: routeFetch,
      out: (s: string) => cliOut.push(s),
      err: () => {},
      store: { get: async () => null },
      config: { read: () => ({ sites: {} }) },
      readStdin: async () => "",
      stdinIsTTY: false,
      now: () => now,
    });
    expect(code1).toBe(0);
    expect(JSON.parse(cliOut[0]!).data).toMatchObject({
      untitled: true,
      name: "",
      account: "u1@example.com",
    });

    // 5. CLI set-name names the token.
    const cliOut2: string[] = [];
    const code2 = await runCli(["set-name", "Arden", "--json"], {
      env: { LIANKI_TOKEN: token },
      version: "0.0.0-test",
      fetch: routeFetch,
      out: (s: string) => cliOut2.push(s),
      err: () => {},
      store: { get: async () => null },
      config: { read: () => ({ sites: {} }) },
      readStdin: async () => "",
      stdinIsTTY: false,
      now: () => now,
    });
    expect(code2).toBe(0);
    expect(JSON.parse(cliOut2[0]!).data).toMatchObject({ ok: true, name: "Arden" });

    // 6. MCP lianki_whoami sees the new name, and study is now unlocked.
    const whoamiTool = TOOLS.find((t: { name: string }) => t.name === "lianki_whoami")!;
    const mcpApi = (opts: Parameters<typeof apiCall>[2]) =>
      apiCall(
        {
          site: "lianki.com",
          base: "https://lianki.com",
          deps: { fetch: routeFetch, timeoutMs: 5000 },
          client: "test",
        },
        token,
        opts,
      ).then((r: { data: unknown }) => r.data);
    const mcpRes = await runTool(whoamiTool, mcpApi, {}, {});
    expect("isError" in mcpRes ? mcpRes.isError : undefined).toBeUndefined();
    expect(mcpRes.content[0]!.text).toContain('"untitled": false');
    expect(mcpRes.content[0]!.text).toContain('"name": "Arden"');
    const unlocked = await checkToken(db as unknown as D1Like, token, "study", now);
    expect(unlocked.ok).toBe(true);
  });
});

describe("TokenManager Add My Agent UI", () => {
  test("hides Add My Agent when agentIdentities is false and shows it when true", async () => {
    const win = new Window();
    const requests: { url: string; method?: string; body?: unknown }[] = [];
    let tokens = [
      {
        id: "t1",
        name: "",
        email: "u1@example.com",
        scopes: ["identity:self"],
        createdAt: "2026-11-27T00:00:00.000Z",
        expiresAt: "2027-02-25T00:00:00.000Z",
        lastUsedAt: null,
        expired: false,
      },
    ];
    const restore = stubGlobals({
      window: win,
      document: win.document,
      location: win.location,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: (url: string, options?: RequestInit) => {
        const method = options?.method ?? "GET";
        const body = options?.body ? JSON.parse(String(options.body)) : undefined;
        requests.push({ url, method, body });
        if (method === "POST") {
          return Promise.resolve(
            Response.json(
              {
                id: "t2",
                name: "",
                token: "lk_" + "a".repeat(64),
                scopes: ["identity:self"],
                expiresAt: "2027-02-25T00:00:00.000Z",
              },
              { status: 201 },
            ),
          );
        }
        if (method === "PATCH") {
          const patch = body as { id: string; name: string };
          tokens = tokens.map((t) => (t.id === patch.id ? { ...t, name: patch.name } : t));
          return Promise.resolve(Response.json({ ok: true, id: patch.id, name: patch.name }));
        }
        return Promise.resolve(
          Response.json({
            account: "u1@example.com",
            tokens,
            scopes: [{ id: "identity:self" }, { id: "study" }],
          }),
        );
      },
    });
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const root = createRoot(host as never);

    try {
      await act(async () => root.render(<TokenManager agentIdentities={false} />));
      expect(host.querySelector('[data-testid="add-my-agent"]')).toBeNull();
      expect(host.querySelector('[data-testid="manual-token-details"]')).toBeNull();

      await act(async () => root.render(<TokenManager agentIdentities={true} />));
      const addBtn = host.querySelector('[data-testid="add-my-agent"]');
      expect(addBtn).not.toBeNull();
      expect(host.querySelector('[data-testid="manual-token-details"]')).not.toBeNull();
      expect(host.textContent).toContain("Untitled agent");

      await act(async () => {
        addBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as never);
      });
      const post = requests.find((r) => r.method === "POST");
      expect(post?.body).toEqual({
        untitled: true,
        scopes: ["identity:self"],
        expiry: { days: 90 },
      });
      const setupUrlText = host.querySelector('[data-testid="agent-setup-url"]')?.textContent ?? "";
      expect(setupUrlText).toContain("/agent-guide.");
      expect(setupUrlText).not.toContain("token=");
      expect(host.innerHTML).not.toContain("token=");
      const promptText =
        host.querySelector('[data-testid="agent-setup-prompt"]')?.textContent ?? "";
      expect(promptText).toContain("/api/my/identity");
      expect(promptText).not.toContain("lk_");
      expect(host.querySelector('[data-testid="token-share-copy"]')).toBeNull();
      expect(host.querySelector('[data-testid="agent-prompt-copy"]')).not.toBeNull();

      // Inline rename from Settings row.
      const renameBtn = host.querySelector('[data-testid="token-rename"]')!;
      await act(async () => {
        renameBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as never);
      });
      const input = host.querySelector(
        '[data-testid="token-rename-input"]',
      ) as unknown as HTMLInputElement;
      const setNativeValue = Object.getOwnPropertyDescriptor(
        win.HTMLInputElement.prototype,
        "value",
      )!.set!;
      await act(async () => {
        setNativeValue.call(input, "Codex");
        input.dispatchEvent(new win.Event("input", { bubbles: true }) as never);
      });
      const saveBtn = host.querySelector('[data-testid="token-rename-save"]')!;
      await act(async () => {
        saveBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as never);
      });
      const patch = requests.find((r) => r.method === "PATCH");
      expect(patch?.body).toEqual({ id: "t1", name: "Codex" });
      expect(host.textContent).toContain("Codex");
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });
});

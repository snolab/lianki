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

    // Self-naming unlocks normal calls.
    await renameSelfToken(db as unknown as D1Like, id, "Claude Desktop");
    const unlocked = await checkToken(db as unknown as D1Like, token, "study", now);
    expect(unlocked.ok).toBe(true);
    if (unlocked.ok) expect(unlocked.name).toBe("Claude Desktop");
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
      expect(host.querySelector('[data-testid="agent-setup-url"]')?.textContent).toContain(
        "token=lk_",
      );
      expect(host.querySelector('[data-testid="agent-setup-prompt"]')?.textContent).toContain(
        "/api/my/identity",
      );

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

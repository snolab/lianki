import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestD1 } from "@/lib/d1/testDb";
import { createInboxDeps } from "@/lib/inbox/deps";
import { inboxRoutes } from "@/lib/inbox/routes";
import type { InboxBucket } from "@/lib/inbox/handlers";
const schema = ["0035_inbox.sql", "0068_import_files.sql", "0077_inbox_upload_log.sql"]
  .map((f) => readFileSync(new URL("../db/migrations/" + f, import.meta.url), "utf8"))
  .join("\n");
const fixture = () => {
  const db = createTestD1(schema);
  const blobs = new Map<string, Uint8Array>();
  const bucket: InboxBucket = {
    put: async (k, b) => {
      blobs.set(k, new Uint8Array(await new Response(b).arrayBuffer()));
    },
    get: async (k) =>
      blobs.has(k)
        ? { body: new Response(blobs.get(k)!.slice().buffer as ArrayBuffer).body! }
        : null,
    delete: async (k) => {
      blobs.delete(k);
    },
  };
  let user: { id: string; email?: string | null } | null = { id: "u1", email: "qa@lianki.test" };
  const values = {
    "inbox.maxFileBytes": 1024,
    "inbox.maxDayBytes": 4096,
    "inbox.maxStoredBytes": 8192,
    "inbox.uploadsPerMinute": 3,
  };
  const deps = createInboxDeps({
    user: async () => user,
    db: () => db,
    bucket: () => bucket,
    value: async (k) => values[k],
  });
  return {
    db,
    blobs,
    deps,
    user: (u: typeof user) => {
      user = u;
    },
  };
};
const request = (method: string, body?: BodyInit, origin = "https://local.example") =>
  new Request("https://local.example/api/my/inbox", {
    method,
    headers: {
      origin,
      ...(body ? { "content-length": String(typeof body === "string" ? body.length : 3) } : {}),
    },
    body,
  });
describe("account inbox route adapters", () => {
  it("binds account identity, storage and all four live quota values", async () => {
    const f = fixture();
    expect(await f.deps.who()).toMatchObject({ id: "u1", owner: false });
    expect(f.deps.db()).toBe(f.db);
    expect(await f.deps.limits!()).toEqual({
      maxFileBytes: 1024,
      maxDayBytes: 4096,
      maxStoredBytes: 8192,
      uploadsPerMinute: 3,
    });
    expect(f.deps.allow!("a", 1)).toBe(true);
    expect(f.deps.allow!("a", 1)).toBe(false);
    f.user(null);
    expect(await f.deps.who()).toBeNull();
    f.user({ id: "u1" });
    expect(await f.deps.who()).toBeNull();
    f.user({ id: "", email: "qa@lianki.test" });
    expect(await f.deps.who()).toBeNull();
  });
  it("accepts a signed-in non-dev upload/list/read/link/delete with same-origin writes", async () => {
    const f = fixture();
    const routes = inboxRoutes(f.deps, () => "d1");
    const uploaded = await routes.POST(request("POST", "png"));
    expect(uploaded.status).toBe(201);
    const { id } = (await uploaded.json()) as { id: string };
    const context = { params: Promise.resolve({ id }) };
    const listing = (await (await routes.GET()).json()) as { items: { id: string }[] };
    expect(listing.items.map((x) => x.id)).toEqual([id]);
    const read = await routes.read(
      new Request("https://local.example/api/my/inbox/" + id),
      context,
    );
    expect(await read.text()).toBe("png");
    expect(
      (await routes.PATCH(request("PATCH", JSON.stringify({ ids: [id], line: "line" })))).status,
    ).toBe(200);
    expect((await routes.DELETE(request("DELETE"), context)).status).toBe(200);
    expect(f.blobs.size).toBe(0);
    f.user(null);
    expect((await routes.GET()).status).toBe(404);
  });
  it("rejects CSRF before invoking storage and off-D1 paths are unavailable", async () => {
    const f = fixture();
    const live = inboxRoutes(f.deps, () => "d1");
    const context = { params: Promise.resolve({ id: "a".repeat(20) }) };
    expect((await live.POST(request("POST", "png", "https://other.example"))).status).toBe(403);
    expect((await live.PATCH(request("PATCH", "{}", "https://other.example"))).status).toBe(403);
    expect(
      (await live.DELETE(request("DELETE", undefined, "https://other.example"), context)).status,
    ).toBe(403);
    const off = inboxRoutes(f.deps, () => "mongodb");
    expect((await off.GET()).status).toBe(503);
    expect((await off.POST(request("POST", "png"))).status).toBe(503);
    expect((await off.PATCH(request("PATCH", "{}"))).status).toBe(503);
    expect((await off.read(new Request("https://x"), context)).status).toBe(503);
    expect((await off.DELETE(request("DELETE"), context)).status).toBe(503);
    expect(f.blobs.size).toBe(0);
  });
});

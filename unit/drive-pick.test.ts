// "Choose docs from Google Drive" (docs/connections.md, "Picking docs"): the
// imported-docs list query, the Picker opening by itself after connecting,
// and the pick → import flow with the network and Google's Picker mocked.
import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { listGdocImports } from "@/lib/connections/gdoc-imports";
import {
  autoPickOnReturn,
  pickAndImport,
  pickReturnTo,
  resyncGdoc,
  withoutPickParams,
  type Fetch,
  type PickDeps,
} from "@/lib/connections/drive-pick";
import { returnPath } from "@/lib/connections/google";

const A = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
const B = "1BbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
const C = "1CbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";

describe("listGdocImports", () => {
  let db: TestD1Database;
  const add = (id: string, user: string, key: string | null, updated: string) =>
    db
      .prepare(
        `INSERT INTO read_materials (id, user_id, title, lines, source_key, created_at, updated_at)
         VALUES (?, ?, ?, '[]', ?, ?, ?)`,
      )
      .bind(id, user, `T ${id}`, key, updated, updated)
      .run();

  beforeEach(async () => {
    db = createTestD1(testSchema());
    await add("m1", "u1", `gdoc:${A}`, "2026-11-01T00:00:00.000Z");
    await add("m2", "u1", `gdoc:${B}`, "2026-11-04T00:00:00.000Z");
    await add("m3", "u1", null, "2026-11-05T00:00:00.000Z"); // pasted text
    await add("m4", "u1", "epub:x", "2026-11-05T00:00:00.000Z"); // another source
    await add("m5", "u2", `gdoc:${C}`, "2026-11-05T00:00:00.000Z"); // someone else's
    await add("m6", "u1", "gdoc:bad", "2026-11-05T00:00:00.000Z"); // not a doc id
    await add("m7", "u1", "gdoc_x:zzzzzzzzzzzzzzzzzzzzzzzzzz", "2026-11-05T00:00:00.000Z");
  });

  it("lists only this user's Google Docs books, newest sync first", async () => {
    expect(await listGdocImports(db, "u1")).toEqual([
      { id: "m2", docId: B, title: "T m2", syncedAt: "2026-11-04T00:00:00.000Z" },
      { id: "m1", docId: A, title: "T m1", syncedAt: "2026-11-01T00:00:00.000Z" },
    ]);
    expect((await listGdocImports(db, "u2")).map((r) => r.id)).toEqual(["m5"]);
    expect(await listGdocImports(db, "nobody")).toEqual([]);
  });

  it("caps the rows", async () => {
    // m6 (newest, not a doc id) takes a row and is dropped; m2 is next.
    expect((await listGdocImports(db, "u1", 2)).map((r) => r.id)).toEqual(["m2"]);
  });

  it("uses the (user_id, source_key) index", async () => {
    const plan = db
      .raw()
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM read_materials
         WHERE user_id = ? AND source_key >= 'gdoc:' AND source_key < 'gdoc;'`,
      )
      .all("u1") as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("idx_read_materials_user_source");
  });
});

describe("opening the Picker after connecting", () => {
  it("comes back to the page that started it", () => {
    expect(pickReturnTo("/connections")).toBe("/connections?pick=drive");
    expect(pickReturnTo("/reader")).toBe("/reader?pick=drive");
    // The callback keeps them: returnPath allows exactly these.
    expect(returnPath(pickReturnTo("/connections"))).toBe("/connections?pick=drive");
    expect(returnPath(pickReturnTo("/reader"))).toBe("/reader?pick=drive");
    for (const bad of ["/reader?pick=other", "/admin?pick=drive", "/reader?pick=drive&x=1"])
      expect(returnPath(bad)).toBe("/connections");
  });

  it("opens only after a connect that worked and was started by the button", () => {
    expect(autoPickOnReturn("?pick=drive&google=connected")).toBe(true);
    expect(autoPickOnReturn("?google=connected&pick=drive")).toBe(true);
    expect(autoPickOnReturn("?pick=drive&google=denied")).toBe(false);
    expect(autoPickOnReturn("?pick=drive&google=failed")).toBe(false);
    expect(autoPickOnReturn("?pick=drive")).toBe(false);
    expect(autoPickOnReturn("?google=connected")).toBe(false);
    expect(autoPickOnReturn(`?gdoc=${A}&google=connected`)).toBe(false);
    expect(autoPickOnReturn("")).toBe(false);
  });

  it("drops its words from the URL and keeps the rest", () => {
    expect(withoutPickParams("?pick=drive&google=connected")).toBe("");
    expect(withoutPickParams("?pick=drive&google=connected&tab=2")).toBe("?tab=2");
    expect(withoutPickParams("")).toBe("");
  });
});

type Call = { url: string; body: Record<string, unknown> };

function mockFetch(answer: (c: Call) => [number, unknown]) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const c = { url, body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(c);
    const [status, json] = answer(c);
    return new Response(JSON.stringify(json), { status });
  }) as Fetch;
  return { f, calls };
}

// Fake values in the shapes the Picker accepts (parsePickerSetup).
const SETUP = {
  accessToken: "ya29.fake-test-token",
  apiKey: "AIzaFakeTestKey_000000000000",
  appId: "123456789012",
};

function deps(
  f: Fetch,
  picked: string[] | Error,
): PickDeps & { connected: string[]; progress: string[] } {
  const connected: string[] = [];
  const progress: string[] = [];
  return {
    fetch: f,
    pick: async (s) => {
      expect(s).toEqual(SETUP);
      if (picked instanceof Error) throw picked;
      return picked;
    },
    connect: async (r) => {
      connected.push(r);
      return "ok";
    },
    onProgress: (n, t) => progress.push(`${n}/${t}`),
    connected,
    progress,
  };
}

describe("pickAndImport", () => {
  it("imports every picked doc through Drive, once each", async () => {
    const { f, calls } = mockFetch((c) =>
      c.url === "/api/connections/google/picker"
        ? [200, SETUP]
        : [200, { id: `book-${String(c.body.url).slice(36, 37)}`, title: "T" }],
    );
    const d = deps(f, [A, B, A]);
    const out = await pickAndImport("/connections", d);
    expect(out).toEqual({
      kind: "done",
      imported: [
        { id: "book-A", title: "T" },
        { id: "book-B", title: "T" },
      ],
      failed: [],
    });
    expect(calls.slice(1).map((c) => c.body)).toEqual([
      { url: `https://docs.google.com/document/d/${A}/edit`, via: "drive" },
      { url: `https://docs.google.com/document/d/${B}/edit`, via: "drive" },
    ]);
    expect(d.progress).toEqual(["1/2", "2/2"]);
    expect(d.connected).toEqual([]);
  });

  it("not connected: to Google's consent, coming back to open the Picker", async () => {
    const { f } = mockFetch(() => [409, { error: "not-connected" }]);
    const d = deps(f, []);
    expect(await pickAndImport("/reader", d)).toEqual({ kind: "leaving" });
    expect(d.connected).toEqual(["/reader?pick=drive"]);
  });

  it("closed without picking, or not set up yet", async () => {
    const ok = mockFetch(() => [200, SETUP]);
    expect(await pickAndImport("/reader", deps(ok.f, []))).toEqual({ kind: "cancelled" });
    expect(ok.calls).toHaveLength(1);
    const off = mockFetch(() => [503, { error: "not-configured" }]);
    expect(await pickAndImport("/reader", deps(off.f, []))).toEqual({
      kind: "error",
      code: "not-configured",
    });
    const slow = mockFetch(() => [429, { error: "rate-limited" }]);
    expect(await pickAndImport("/reader", deps(slow.f, []))).toEqual({
      kind: "error",
      code: "rate-limited",
    });
    expect(await pickAndImport("/reader", deps(ok.f, new Error("load")))).toEqual({
      kind: "error",
      code: "failed",
    });
  });

  it("keeps going past a doc that fails, and says which", async () => {
    const { f } = mockFetch((c) =>
      c.url === "/api/connections/google/picker"
        ? [200, SETUP]
        : String(c.body.url).includes(A)
          ? [413, { error: "too-large" }]
          : [200, { id: "book-B", title: "B" }],
    );
    expect(await pickAndImport("/connections", deps(f, [A, B]))).toEqual({
      kind: "done",
      imported: [{ id: "book-B", title: "B" }],
      failed: ["too-large"],
    });
  });

  it("a grant that ended before the first import: connect again", async () => {
    const { f } = mockFetch((c) =>
      c.url === "/api/connections/google/picker" ? [200, SETUP] : [409, { error: "reconnect" }],
    );
    const d = deps(f, [A]);
    expect(await pickAndImport("/connections", d)).toEqual({ kind: "leaving" });
    expect(d.connected).toEqual(["/connections?pick=drive"]);
  });
});

describe("pickAndImport: network trouble", () => {
  const boom = (() => Promise.reject(new Error("offline"))) as unknown as Fetch;

  it("the token request fails or throws", async () => {
    const down = mockFetch(() => [500, {}]);
    expect(await pickAndImport("/reader", deps(down.f, [A]))).toEqual({
      kind: "error",
      code: "failed",
    });
    expect(await pickAndImport("/reader", deps(boom, [A]))).toEqual({
      kind: "error",
      code: "failed",
    });
  });

  it("an import that throws or answers no JSON counts as failed, without onProgress", async () => {
    let n = 0;
    const f = (async (url: string) => {
      if (url === "/api/connections/google/picker") return Response.json(SETUP);
      n++;
      if (n === 1) throw new Error("offline");
      return new Response("not json", { status: 502 });
    }) as Fetch;
    const { onProgress: _, ...quiet } = deps(f, [A, B]);
    expect(await pickAndImport("/reader", quiet)).toEqual({
      kind: "done",
      imported: [],
      failed: ["fetch-failed", "fetch-failed"],
    });
  });

  it("a grant that ends after one import: the rest are listed as failed", async () => {
    const { f } = mockFetch((c) =>
      c.url === "/api/connections/google/picker"
        ? [200, SETUP]
        : String(c.body.url).includes(A)
          ? [200, { id: "book-A" }]
          : [409, { error: "reconnect" }],
    );
    const d = deps(f, [A, B]);
    expect(await pickAndImport("/reader", d)).toEqual({
      kind: "done",
      imported: [{ id: "book-A", title: "" }],
      failed: ["reconnect"],
    });
    expect(d.connected).toEqual([]);
  });

  it("connecting cannot start: says why", async () => {
    const { f } = mockFetch(() => [409, {}]);
    const d = { ...deps(f, []), connect: async () => "not-configured" as const };
    expect(await pickAndImport("/reader", d)).toEqual({ kind: "error", code: "not-configured" });
  });
});

describe("resyncGdoc", () => {
  it("re-imports through Drive", async () => {
    const { f, calls } = mockFetch(() => [200, { id: "book", updated: true }]);
    expect(await resyncGdoc(f, A)).toEqual({ ok: true, id: "book" });
    expect(calls.map((c) => c.body.via)).toEqual(["drive"]);
  });

  it("a doc that came by its public link: falls back to the link", async () => {
    const { f, calls } = mockFetch((c) =>
      c.body.via === "drive" ? [422, { error: "not-granted" }] : [200, { id: "book" }],
    );
    expect(await resyncGdoc(f, A)).toEqual({ ok: true, id: "book" });
    expect(calls.map((c) => c.body.via ?? "link")).toEqual(["drive", "link"]);
  });

  it("private and no longer reachable: pick it again, or connect again", async () => {
    const notShared = (drive: [number, unknown]) =>
      mockFetch((c) => (c.body.via === "drive" ? drive : [422, { error: "not-shared" }])).f;
    expect(await resyncGdoc(notShared([422, { error: "not-granted" }]), A)).toEqual({
      ok: false,
      error: "not-granted",
    });
    expect(await resyncGdoc(notShared([409, { error: "reconnect" }]), A)).toEqual({
      ok: false,
      error: "reconnect",
    });
  });

  it("a doc error is not retried by link", async () => {
    const { f, calls } = mockFetch(() => [413, { error: "too-large" }]);
    expect(await resyncGdoc(f, A)).toEqual({ ok: false, error: "too-large" });
    expect(calls).toHaveLength(1);
  });
});

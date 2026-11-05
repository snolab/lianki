// Renaming a /read material (the row menu): the title is cleaned and capped,
// only the owner's row changes, and a re-import of its source (a Google
// Doc's "Sync again") keeps the user's title while the text updates.
import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { cleanTitle, TITLE_MAX } from "@/lib/read/title";
import { sameOriginJson, sameOriginJsonPost } from "@/lib/security/same-origin";
import { useBackend, useBlobs, useD1 } from "./support/testMocks";

const { saveReadMaterial, renameReadMaterial, replaceReadMaterialText, getReadMaterialById } =
  await import("@/lib/getReadMaterialsCollection");

let d1: TestD1Database;

beforeEach(() => {
  d1 = createTestD1(testSchema());
  useD1(d1);
  useBackend("d1");
  const store = new Map<string, string>();
  useBlobs({
    put: async (k: string, v: string) => void store.set(k, v),
    get: async (k: string) => (store.has(k) ? { text: async () => store.get(k)! } : null),
    delete: async (k: string) => void store.delete(k),
  });
});

describe("cleanTitle", () => {
  it("trims, collapses whitespace and drops control characters", () => {
    expect(cleanTitle("  My\tbook \n two  ")).toBe("My book two");
    expect(cleanTitle("a\u0000b")).toBe("a b");
  });

  it("refuses empty and non-strings", () => {
    for (const bad of ["", "   ", "\n\t", null, undefined, 7, {}])
      expect(cleanTitle(bad)).toBeNull();
  });

  it("caps the length without splitting a character", () => {
    expect([...cleanTitle("x".repeat(500))!]).toHaveLength(TITLE_MAX);
    const emoji = "😀".repeat(TITLE_MAX + 5);
    const out = cleanTitle(emoji)!;
    expect([...out]).toHaveLength(TITLE_MAX);
    expect(out).toBe("😀".repeat(TITLE_MAX));
  });
});

describe("renameReadMaterial", () => {
  it("renames the owner's material only", async () => {
    const m = await saveReadMaterial("u1", "Old", "a\nb", ["a", "b"]);
    const id = String(m._id);
    expect(await renameReadMaterial("u2", id, "Stolen")).toBe(false);
    expect((await getReadMaterialById("u1", id))?.title).toBe("Old");
    expect(await renameReadMaterial("u1", id, "New")).toBe(true);
    expect((await getReadMaterialById("u1", id))?.title).toBe("New");
    expect(await renameReadMaterial("u1", "nope", "X")).toBe(false);
  });

  it("does not move the material in the list (updated_at kept)", async () => {
    const m = await saveReadMaterial("u1", "Old", "a", ["a"]);
    const before = (await getReadMaterialById("u1", String(m._id)))!.updatedAt;
    await renameReadMaterial("u1", String(m._id), "New");
    expect((await getReadMaterialById("u1", String(m._id)))!.updatedAt).toEqual(before);
  });
});

describe("a re-import keeps a renamed title", () => {
  it("takes the source's title until the user renames, then keeps theirs", async () => {
    const m = await saveReadMaterial("u1", "Doc v1", "{}", ["a"], "h1", "gdoc:x");
    const id = String(m._id);
    await replaceReadMaterialText("u1", id, "Doc v2", ["a", "b"], "{}", "h2");
    expect((await getReadMaterialById("u1", id))?.title).toBe("Doc v2");

    await renameReadMaterial("u1", id, "My notes");
    await replaceReadMaterialText("u1", id, "Doc v3", ["a", "b", "c"], "{}", "h3");
    const after = (await getReadMaterialById("u1", id))!;
    expect(after.title).toBe("My notes");
    expect(after.lines).toEqual(["a", "b", "c"]); // the text still updates
    expect(after.contentHash).toBe("h3");
  });
});

describe("sameOriginJson (PATCH)", () => {
  const ok = {
    "content-type": "application/json",
    origin: "https://lianki.com",
    host: "lianki.com",
    "sec-fetch-site": "same-origin",
  };
  const req = (method: string, headers: Record<string, string> = ok) =>
    new Request("https://lianki.com/api/read/x", {
      method,
      headers,
      body: method === "GET" ? undefined : "{}",
    });

  it("accepts a same-origin JSON PATCH, refuses cross-site and GET", () => {
    expect(sameOriginJson(req("PATCH"))).toBe(true);
    expect(sameOriginJson(req("PATCH", { ...ok, origin: "https://evil.example" }))).toBe(false);
    expect(sameOriginJson(req("PATCH", { ...ok, "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOriginJson(req("PATCH", { ...ok, "content-type": "text/plain" }))).toBe(false);
    expect(sameOriginJson(req("GET"))).toBe(false);
    // The POST-only form still refuses anything else.
    expect(sameOriginJsonPost(req("PATCH"))).toBe(false);
    expect(sameOriginJsonPost(req("POST"))).toBe(true);
  });
});

/**
 * The editable profile (lib/profile/; docs/secrets-and-auth.md, "Profile
 * edits"): name validation, avatar type and size checks, only your own user is
 * changed, the rate limits, the same-origin gate, how a picture is served.
 */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import {
  absoluteImage,
  avatarKey,
  avatarPath,
  isOwnAvatar,
  newAvatarId,
  squareCrop,
} from "../lib/profile/avatar";
import { PROFILE } from "../lib/profile/config";
import {
  type AvatarBucket,
  type ProfileDeps,
  deleteAvatar,
  getAvatar,
  postAvatar,
  postName,
} from "../lib/profile/handlers";
import { cleanName } from "../lib/profile/name";
import { sameOriginWrite } from "../lib/security/same-origin";

const SCHEMA =
  readFileSync(new URL("../db/migrations/0046_user_avatar.sql", import.meta.url), "utf8").replace(
    "REFERENCES user(id) ON DELETE CASCADE",
    "",
  ) +
  "CREATE TABLE auth_throttle (key TEXT PRIMARY KEY, count INTEGER NOT NULL, windowStart INTEGER NOT NULL, lockedUntil INTEGER NOT NULL DEFAULT 0);";

const BASE = "https://lianki.com";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = new TextEncoder().encode("RIFF\x10\0\0\0WEBPVP8 ");
const enc = (s: string) => new TextEncoder().encode(s);

function memBucket() {
  const store = new Map<string, { bytes: Uint8Array; type?: string }>();
  const b: AvatarBucket & { store: typeof store } = {
    store,
    async put(key, body, opts) {
      store.set(key, { bytes: body, type: opts?.httpMetadata?.contentType });
    },
    async get(key) {
      const v = store.get(key);
      return v
        ? {
            body: new Response(v.bytes as Uint8Array<ArrayBuffer>).body!,
            size: v.bytes.length,
            httpMetadata: { contentType: v.type },
          }
        : null;
    },
    async delete(key) {
      store.delete(key);
    },
  };
  return b;
}

type Fields = { name?: string; image?: string | null };
let bucket: ReturnType<typeof memBucket>;
let me: { id: string; image?: string | null } | null;
let updates: Fields[];
let failUpdate: boolean;
let deps: ProfileDeps;
let raw: ReturnType<typeof createTestD1>;

beforeEach(() => {
  raw = createTestD1(SCHEMA);
  bucket = memBucket();
  me = { id: "u1", image: null };
  updates = [];
  failUpdate = false;
  deps = {
    who: async () => me,
    update: async (f) => {
      if (failUpdate) throw new Error("update failed");
      updates.push(f);
      if (me && "image" in f) me.image = f.image;
    },
    db: () => raw,
    bucket: () => bucket,
    now: () => 1_800_000_000_000,
  };
});

const headers = (extra: Record<string, string> = {}) => ({
  host: "lianki.com",
  origin: BASE,
  "sec-fetch-site": "same-origin",
  ...extra,
});
const rows = (sql: string) =>
  raw
    .raw()
    .prepare(sql)
    .all()
    .map((r) => ({ ...r }));
const nameReq = (body: unknown, extra: Record<string, string> = {}) =>
  new Request(`${BASE}/api/profile/name`, {
    method: "POST",
    headers: headers({ "content-type": "application/json", ...extra }),
    body: JSON.stringify(body),
  });
const upReq = (bytes: Uint8Array, extra: Record<string, string> = {}) =>
  new Request(`${BASE}/api/profile/avatar`, {
    method: "POST",
    headers: headers({ "content-type": "image/png", ...extra }),
    body: bytes as Uint8Array<ArrayBuffer>,
  });
const delReq = (extra: Record<string, string> = {}) =>
  new Request(`${BASE}/api/profile/avatar`, {
    method: "DELETE",
    headers: headers({ "content-type": "application/json", ...extra }),
  });

describe("cleanName", () => {
  test("trims, collapses whitespace, and normalises", () => {
    expect(cleanName("  Ada \n\t Lovelace ")).toEqual({ ok: true, name: "Ada Lovelace" });
    expect(cleanName("e\u0301")).toEqual({ ok: true, name: "é" });
  });
  test("drops control and bidi-override characters, keeps joiners", () => {
    expect(cleanName("a\u0000b\u202ec")).toEqual({ ok: true, name: "abc" });
    const family = "👨\u200d👩\u200d👧";
    expect(cleanName(family)).toEqual({ ok: true, name: family });
  });
  test("refuses empty, blank and non-strings", () => {
    for (const v of ["", "   ", "\u202e", undefined, null, 5, {}])
      expect(cleanName(v)).toEqual({ ok: false, error: "empty" });
  });
  test("the limit counts characters, not UTF-16 units", () => {
    const max = PROFILE.nameMaxChars;
    expect(cleanName("字".repeat(max)).ok).toBe(true);
    expect(cleanName("😀".repeat(max)).ok).toBe(true);
    expect(cleanName("a".repeat(max + 1))).toEqual({ ok: false, error: "too-long" });
  });
});

describe("POST /api/profile/name", () => {
  test("saves the cleaned name", async () => {
    const r = await postName(nameReq({ name: "  Ada  " }), deps);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ name: "Ada" });
    expect(updates).toEqual([{ name: "Ada" }]);
  });
  test("a guest is refused", async () => {
    me = null;
    expect((await postName(nameReq({ name: "Ada" }), deps)).status).toBe(401);
    expect(updates).toEqual([]);
  });
  test("another site is refused before anything else", async () => {
    const r = await postName(
      nameReq({ name: "Ada" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
      deps,
    );
    expect(r.status).toBe(403);
    expect(updates).toEqual([]);
  });
  test("a bad name is refused, with its reason", async () => {
    const empty = await postName(nameReq({ name: " " }), deps);
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe("empty");
    const long = await postName(nameReq({ name: "a".repeat(999) }), deps);
    expect(((await long.json()) as { error: string }).error).toBe("too-long");
    const garbage = new Request(`${BASE}/api/profile/name`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: "{",
    });
    expect((await postName(garbage, deps)).status).toBe(400);
    expect(updates).toEqual([]);
  });
  test("only name is passed on: a request can't set an image, an email or a user id", async () => {
    await postName(
      nameReq({ name: "Ada", image: "https://evil.example/x.png", email: "a@b.c", userId: "u2" }),
      deps,
    );
    expect(updates).toEqual([{ name: "Ada" }]);
  });
  test("rate limited per user", async () => {
    for (let i = 0; i < PROFILE.nameLimit.max; i++)
      expect((await postName(nameReq({ name: `n${i}` }), deps)).status).toBe(200);
    const r = await postName(nameReq({ name: "again" }), deps);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    // Someone else's limit is their own.
    me = { id: "u2" };
    expect((await postName(nameReq({ name: "other" }), deps)).status).toBe(200);
  });
});

describe("POST /api/profile/avatar: what is accepted", () => {
  test("PNG, JPEG and WebP by their bytes, whatever the header says", async () => {
    for (const [bytes, type] of [
      [PNG, "image/png"],
      [JPEG, "image/jpeg"],
      [WEBP, "image/webp"],
    ] as const) {
      const r = await postAvatar(upReq(bytes, { "content-type": "application/pdf" }), deps);
      expect(r.status).toBe(201);
      const { image } = (await r.json()) as { image: string };
      const key = image.replace("/api/avatar/", "avatars/");
      expect(bucket.store.get(key)?.type).toBe(type);
    }
  });
  test.each([
    ["an SVG renamed .png", `<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>`],
    ["XML-prefixed SVG", `<?xml version="1.0"?><svg/>`],
    ["HTML renamed .png", "<!doctype html><script>alert(1)</script>"],
    ["plain text", "hello"],
    ["a GIF (never sent by the page)", "GIF89a<svg onload=alert(1)>"],
    ["a PDF", "%PDF-1.7"],
  ])("refuses %s", async (_what, body) => {
    const r = await postAvatar(upReq(enc(body), { "content-type": "image/png" }), deps);
    expect(r.status).toBe(415);
    expect(((await r.json()) as { error: string }).error).toBe("bad-type");
    expect(bucket.store.size).toBe(0);
    expect(updates).toEqual([]);
  });
  test("refuses an empty body", async () => {
    const r = await postAvatar(
      new Request(`${BASE}/api/profile/avatar`, { method: "POST", headers: headers() }),
      deps,
    );
    expect(r.status).toBe(415);
  });
  test("refuses a declared size over the cap", async () => {
    const r = await postAvatar(
      upReq(PNG, { "content-length": String(PROFILE.avatarMaxBytes + 1) }),
      deps,
    );
    expect(r.status).toBe(413);
    expect(bucket.store.size).toBe(0);
  });
  test("refuses more bytes than the cap even when the length isn't declared", async () => {
    const big = new Uint8Array(PROFILE.avatarMaxBytes + 1);
    big.set(PNG);
    const r = await postAvatar(upReq(big), deps);
    expect(r.status).toBe(413);
    expect(bucket.store.size).toBe(0);
  });
  test("exactly the cap is fine", async () => {
    const big = new Uint8Array(PROFILE.avatarMaxBytes);
    big.set(PNG);
    expect((await postAvatar(upReq(big), deps)).status).toBe(201);
  });
});

describe("POST /api/profile/avatar: whose, and what is left behind", () => {
  test("a guest is refused, another site is refused", async () => {
    me = null;
    expect((await postAvatar(upReq(PNG), deps)).status).toBe(401);
    me = { id: "u1" };
    const r = await postAvatar(upReq(PNG, { origin: "https://evil.example" }), deps);
    expect(r.status).toBe(403);
    expect(bucket.store.size).toBe(0);
  });
  test("the key and the image are under the session's own user only", async () => {
    // A request has no way to name a user: not a query, not a header.
    const r = await postAvatar(
      new Request(`${BASE}/api/profile/avatar?userId=u2`, {
        method: "POST",
        headers: headers({ "x-user-id": "u2" }),
        body: PNG,
      }),
      deps,
    );
    const { image } = (await r.json()) as { image: string };
    expect(image).toStartWith("/api/avatar/u1/");
    expect([...bucket.store.keys()][0]).toStartWith("avatars/u1/");
    expect(updates).toEqual([{ image }]);
    expect(rows("SELECT userId FROM user_avatar")).toEqual([{ userId: "u1" }]);
  });
  test("replacing deletes the old object and keeps the provider's picture", async () => {
    const google = "https://lh3.googleusercontent.com/a/x";
    me = { id: "u1", image: google };
    const first = (await (await postAvatar(upReq(PNG), deps)).json()) as { image: string };
    const second = (await (await postAvatar(upReq(JPEG), deps)).json()) as { image: string };
    expect(second.image).not.toBe(first.image);
    expect([...bucket.store.keys()]).toEqual([second.image.replace("/api/avatar/", "avatars/")]);
    // ...and removing goes back to it.
    const removed = await deleteAvatar(delReq(), deps);
    expect(await removed.json()).toEqual({ image: google });
    expect(me.image).toBe(google);
    expect(bucket.store.size).toBe(0);
    expect(rows("SELECT * FROM user_avatar")).toEqual([]);
  });
  test("a failed profile write leaves no new object and the old avatar intact", async () => {
    const first = (await (await postAvatar(upReq(PNG), deps)).json()) as { image: string };
    failUpdate = true;
    await expect(postAvatar(upReq(JPEG), deps)).rejects.toThrow("update failed");
    const key = first.image.replace("/api/avatar/", "avatars/");
    expect([...bucket.store.keys()]).toEqual([key]);
    expect(rows("SELECT r2Key FROM user_avatar")).toEqual([{ r2Key: key }]);
  });
  test("a failed first upload leaves nothing at all", async () => {
    failUpdate = true;
    await expect(postAvatar(upReq(PNG), deps)).rejects.toThrow("update failed");
    expect(bucket.store.size).toBe(0);
    expect(rows("SELECT * FROM user_avatar")).toEqual([]);
  });
  test("an old object that can't be deleted doesn't fail the save", async () => {
    await postAvatar(upReq(PNG), deps);
    bucket.delete = async () => {
      throw new Error("r2 down");
    };
    expect((await postAvatar(upReq(JPEG), deps)).status).toBe(201);
    expect((await deleteAvatar(delReq(), deps)).status).toBe(200);
  });
  test("uploads and removals share one rate limit per user", async () => {
    for (let i = 0; i < PROFILE.avatarLimit.max; i++)
      expect((await postAvatar(upReq(PNG), deps)).status).toBe(201);
    expect((await postAvatar(upReq(PNG), deps)).status).toBe(429);
    expect((await deleteAvatar(delReq(), deps)).status).toBe(429);
    me = { id: "u2" };
    expect((await postAvatar(upReq(PNG), deps)).status).toBe(201);
  });
  test("costs go down the inbox's log-only path, marked as avatar", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await postAvatar(upReq(PNG), deps);
      await postAvatar(upReq(PNG), deps);
      const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])));
      expect(lines.map((l) => [l.event, l.what, l.kind])).toEqual([
        ["inbox.cost", "avatar", "upload"],
        ["inbox.cost", "avatar", "storage"],
        ["inbox.cost", "avatar", "upload"],
      ]);
    } finally {
      log.mockRestore();
    }
  });
});

describe("DELETE /api/profile/avatar", () => {
  test("a guest and another site are refused", async () => {
    me = null;
    expect((await deleteAvatar(delReq(), deps)).status).toBe(401);
    me = { id: "u1" };
    expect((await deleteAvatar(delReq({ origin: "https://evil.example" }), deps)).status).toBe(403);
  });
  test("with no upload, a provider's picture stays", async () => {
    const google = "https://lh3.googleusercontent.com/a/x";
    me = { id: "u1", image: google };
    expect(await (await deleteAvatar(delReq(), deps)).json()).toEqual({ image: google });
    expect(updates).toEqual([]);
  });
  test("an upload with no provider picture goes back to none", async () => {
    await postAvatar(upReq(PNG), deps);
    expect(await (await deleteAvatar(delReq(), deps)).json()).toEqual({ image: null });
    expect(me?.image).toBe(null);
  });
  test("leaves another user's avatar alone", async () => {
    me = { id: "u2" };
    await postAvatar(upReq(PNG), deps);
    const other = [...bucket.store.keys()];
    me = { id: "u1" };
    await postAvatar(upReq(JPEG), deps);
    await deleteAvatar(delReq(), deps);
    expect([...bucket.store.keys()]).toEqual(other);
    expect(rows("SELECT userId FROM user_avatar")).toEqual([{ userId: "u2" }]);
  });
  test("an image of ours with its row gone is still cleared", async () => {
    me = { id: "u1", image: avatarPath("u1", newAvatarId()) };
    expect(await (await deleteAvatar(delReq(), deps)).json()).toEqual({ image: null });
    expect(me.image).toBe(null);
  });
});

describe("GET /api/avatar/<user>/<id>", () => {
  test("served safely, cacheable for good", async () => {
    const { image } = (await (await postAvatar(upReq(PNG), deps)).json()) as { image: string };
    const [, , , user, id] = image.split("/");
    const r = await getAvatar(user!, id!, deps);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(r.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
  });
  test("nothing there, or a malformed path, is 404 and never reaches R2", async () => {
    expect((await getAvatar("u1", newAvatarId(), deps)).status).toBe(404);
    let asked = 0;
    const counting = {
      bucket: () => ({
        ...bucket,
        get: async () => {
          asked++;
          return null;
        },
      }),
    };
    for (const [u, i] of [
      ["../inbox", newAvatarId()],
      ["u1", "../../secret"],
      ["u1", "ABC"],
      ["u 1", newAvatarId()],
    ] as const)
      expect((await getAvatar(u, i, counting)).status).toBe(404);
    expect(asked).toBe(0);
  });
  test("an object of any other type is never sent", async () => {
    const id = newAvatarId();
    await bucket.put(avatarKey("u1", id), enc("<svg/>"), {
      httpMetadata: { contentType: "image/svg+xml" },
    });
    expect((await getAvatar("u1", id, deps)).status).toBe(404);
  });
});

describe("avatar helpers", () => {
  test("avatarKey refuses anything that could leave its prefix", () => {
    expect(() => avatarKey("../x", newAvatarId())).toThrow();
    expect(() => avatarKey("u1", "../x")).toThrow();
    expect(avatarKey("u1", "a".repeat(20))).toBe(`avatars/u1/${"a".repeat(20)}`);
  });
  test("isOwnAvatar tells an upload from a provider's picture", () => {
    expect(isOwnAvatar("/api/avatar/u1/x")).toBe(true);
    expect(isOwnAvatar("https://lh3.googleusercontent.com/a/x")).toBe(false);
    expect(isOwnAvatar(null)).toBe(false);
  });
  test("squareCrop centres, and never scales up", () => {
    expect(squareCrop(4000, 3000, 512)).toEqual({ sx: 500, sy: 0, crop: 3000, out: 512 });
    expect(squareCrop(100, 300, 512)).toEqual({ sx: 0, sy: 100, crop: 100, out: 100 });
  });
  test("absoluteImage: own path resolved, provider URL kept, none empty", () => {
    expect(absoluteImage("/api/avatar/u1/x", "https://lianki.com/api/debug/identity")).toBe(
      "https://lianki.com/api/avatar/u1/x",
    );
    expect(absoluteImage("https://a.example/x.png", "https://lianki.com/")).toBe(
      "https://a.example/x.png",
    );
    expect(absoluteImage(null, "https://lianki.com/")).toBe("");
    expect(absoluteImage("/x", "not a base")).toBe("");
  });
  test("sameOriginWrite: reads refused, foreign origins refused, a raw upload fine", () => {
    const at = (method: string, h: Record<string, string>) =>
      new Request(`${BASE}/x`, { method, headers: h });
    expect(sameOriginWrite(at("GET", {}))).toBe(false);
    expect(sameOriginWrite(at("POST", { host: "lianki.com" }))).toBe(false);
    expect(sameOriginWrite(at("POST", { host: "lianki.com", origin: BASE }))).toBe(true);
    expect(
      sameOriginWrite(at("POST", { host: "lianki.com", origin: "https://www.evil.example" })),
    ).toBe(false);
  });
});

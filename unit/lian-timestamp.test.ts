import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { concat, fromHex, toHex, utf8 } from "@lianki/lian";
import { attestations, otsStatus, parseOts, serializeOts, stamp, upgrade } from "@lianki/lian/ots";
import {
  type StampDeps,
  type StampRow,
  receiptKey,
  stampDay,
  upgradeDay,
} from "@/lib/lian/timestamp";

/**
 * A mocked OpenTimestamps calendar — the real ones are only contacted by the
 * owner's `scripts/lian/timestamp.ts --go`. Its answers follow the wire format
 * of the reference client (python-opentimestamps), built by hand here.
 */
const sha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const vb = (b: Uint8Array) => concat(new Uint8Array([b.length]), b); // lengths < 128 here
const leb128 = (n: number) => {
  const out: number[] = [];
  do {
    out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n >>= 7;
  } while (n > 0);
  return new Uint8Array(out);
};
const body = (...parts: Uint8Array[]) => concat(...parts) as Uint8Array<ArrayBuffer>;
const PENDING = fromHex("83dfe30d2ef90c8e");
const BITCOIN = fromHex("0588960d73d71901");
const DIGEST = "947692fec7dbf6adfad049bfe934b75f2490cfe0d5db3f3b7fbe995fe6ca90cd";

function mockCalendar(uri: string, height: number) {
  const nonce = utf8(`nonce:${uri}`.slice(0, 16).padEnd(16, "."));
  const tail = utf8("blk-path");
  const seen: string[] = [];
  /** The commitment the calendar's pending attestation is for: sha256(nonce ‖ digest). */
  const commitment = (digest: Uint8Array) => sha(concat(nonce, digest));
  const fetch = async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `${uri}/digest` && init?.method === "POST") {
      const digest = new Uint8Array(init.body as Uint8Array);
      expect(digest.length).toBe(32);
      // prepend(nonce) → sha256 → pending(uri)
      return new Response(
        body(
          new Uint8Array([0xf1]),
          vb(nonce),
          new Uint8Array([0x08, 0x00]),
          PENDING,
          vb(vb(utf8(uri))),
        ),
      );
    }
    const m = url.match(/\/timestamp\/([0-9a-f]+)$/);
    if (m && url.startsWith(uri) && height > 0) {
      // append(tail) → sha256 → bitcoin(height)
      const h = leb128(height);
      return new Response(
        body(new Uint8Array([0xf0]), vb(tail), new Uint8Array([0x08, 0x00]), BITCOIN, vb(h)),
      );
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, seen, commitment, tail };
}

/** Several calendars behind one fetch. */
function calendars(...cals: ReturnType<typeof mockCalendar>[]) {
  return async (url: string, init?: RequestInit) => {
    for (const c of cals) {
      const r = await c.fetch(url, init);
      if (r.status !== 404) return r;
    }
    return new Response("not found", { status: 404 });
  };
}

describe(".ots files", () => {
  test("a stamp is a detached .ots file of the digest, one branch per calendar", async () => {
    const a = mockCalendar("https://a.cal.test", 0);
    const b = mockCalendar("https://b.cal.test", 0);
    const { ots, answered, failed } = await stamp(DIGEST, {
      calendars: ["https://a.cal.test", "https://b.cal.test", "https://down.cal.test"],
      fetch: calendars(a, b),
    });
    expect(answered).toEqual(["https://a.cal.test", "https://b.cal.test"]);
    expect(failed).toEqual(["https://down.cal.test"]);
    // magic, version 1, sha256, the digest
    expect(toHex(ots.slice(0, 31))).toBe(
      "004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294",
    );
    expect(toHex(ots.slice(31, 33))).toBe("0108");
    expect(toHex(ots.slice(33, 65))).toBe(DIGEST);
    const f = await parseOts(ots);
    expect(toHex(f.digest)).toBe(DIGEST);
    const atts = attestations(f.timestamp);
    expect(atts.map((x) => x.att)).toEqual([
      { kind: "pending", uri: "https://a.cal.test" },
      { kind: "pending", uri: "https://b.cal.test" },
    ]);
    // Each pending attestation is for the calendar's own commitment.
    expect(toHex(atts[0].msg)).toBe(toHex(a.commitment(fromHex(DIGEST))));
    expect(otsStatus(f)).toEqual({ status: "pending", height: null });
    // Re-serializing is byte-identical.
    expect(toHex(serializeOts(f))).toBe(toHex(ots));
  });

  test("upgrade swaps a pending branch for the Bitcoin path, once one calendar has it", async () => {
    const a = mockCalendar("https://a.cal.test", 0); // not in a block yet
    const b = mockCalendar("https://b.cal.test", 919_000);
    const { ots } = await stamp(DIGEST, {
      calendars: ["https://a.cal.test", "https://b.cal.test"],
      fetch: calendars(a, b),
    });
    const up = await upgrade(ots, { fetch: calendars(a, b) });
    expect(up.changed).toBe(true);
    expect(up).toMatchObject({ status: "bitcoin", height: 919_000 });
    expect(b.seen).toContain(
      `GET https://b.cal.test/timestamp/${toHex(b.commitment(fromHex(DIGEST)))}`,
    );
    const f = await parseOts(up.ots);
    const btc = attestations(f.timestamp).find((x) => x.att.kind === "bitcoin")!;
    expect(toHex(btc.msg)).toBe(toHex(sha(concat(b.commitment(fromHex(DIGEST)), b.tail))));
    expect(
      attestations(f.timestamp)
        .map((x) => x.att.kind)
        .sort(),
    ).toEqual(["bitcoin", "pending"]);
    // Nothing new from anyone: unchanged, same bytes.
    const again = await upgrade(ots, { fetch: calendars(a) });
    expect(again.changed).toBe(false);
    expect(again.ots).toBe(ots);
  });

  test("refuses too few calendars, a bad digest, and junk files", async () => {
    await expect(
      stamp(DIGEST, { calendars: ["https://x.test"], fetch: calendars() }),
    ).rejects.toThrow();
    await expect(stamp("abcd", { calendars: [], fetch: calendars() })).rejects.toThrow();
    await expect(parseOts(utf8("not an ots file at all, no magic here"))).rejects.toThrow();
    const a = mockCalendar("https://a.cal.test", 0);
    const { ots } = await stamp(DIGEST, { calendars: ["https://a.cal.test"], fetch: a.fetch });
    await expect(parseOts(ots.slice(0, ots.length - 3))).rejects.toThrow(/truncated/);
    await expect(parseOts(concat(ots, new Uint8Array([0])))).rejects.toThrow(/trailing/);
  });
});

/** In-memory D1 row + R2 object, as the script keeps them. */
function memoryDeps(fetch: StampDeps["fetch"], calendars: string[]) {
  const rows = new Map<string, StampRow>();
  const blobs = new Map<string, Uint8Array>();
  const deps: StampDeps = {
    readChainHash: async (d) => (d === "2026-11-05" ? DIGEST : null),
    readStamp: async (d) => rows.get(d) ?? null,
    saveStamp: async (r) => void rows.set(r.day, r),
    putReceipt: async (k, b) => void blobs.set(k, b),
    getReceipt: async (k) => blobs.get(k) ?? null,
    fetch,
    calendars,
  };
  return { deps, rows, blobs };
}

describe("stampDay / upgradeDay (the owner's script)", () => {
  const cals = ["https://a.cal.test", "https://b.cal.test"];

  test("stamps once, keeps the receipt, then upgrades to Bitcoin", async () => {
    const a = mockCalendar(cals[0], 0);
    const b = mockCalendar(cals[1], 0);
    const m = memoryDeps(calendars(a, b), cals);
    const now = new Date("2026-11-06T03:00:00Z");
    const first = await stampDay("2026-11-05", m.deps, now);
    expect(first.already).toBe(false);
    expect(first.row).toMatchObject({
      day: "2026-11-05",
      chainHash: DIGEST,
      r2Key: receiptKey("2026-11-05"),
      calendars: cals,
      status: "pending",
    });
    expect(m.blobs.has("lian/ots/2026-11-05.ots")).toBe(true);
    // Stamping again submits nothing.
    const posts = a.seen.length;
    expect((await stampDay("2026-11-05", m.deps, now)).already).toBe(true);
    expect(a.seen.length).toBe(posts);

    // Hours later: still pending, then in a block.
    expect((await upgradeDay("2026-11-05", m.deps, now)).changed).toBe(false);
    const b2 = mockCalendar(cals[1], 919_123);
    m.deps.fetch = calendars(a, b2);
    const up = await upgradeDay("2026-11-05", m.deps, new Date("2026-11-06T09:00:00Z"));
    expect(up.changed).toBe(true);
    expect(up.row).toMatchObject({
      status: "bitcoin",
      btcHeight: 919_123,
      upgradedAt: "2026-11-06T09:00:00.000Z",
    });
    expect(otsStatus(await parseOts(m.blobs.get("lian/ots/2026-11-05.ots")!)).status).toBe(
      "bitcoin",
    );
    expect((await upgradeDay("2026-11-05", m.deps)).changed).toBe(false);
  });

  test("refuses a bad day, an unanchored day, a missing stamp or receipt, and one calendar alone", async () => {
    const a = mockCalendar(cals[0], 0);
    const m = memoryDeps(calendars(a), cals);
    await expect(stampDay("11/5/2026", m.deps)).rejects.toThrow();
    await expect(stampDay("2026-11-04", m.deps)).rejects.toThrow(/not anchored/);
    await expect(stampDay("2026-11-05", m.deps)).rejects.toThrow(/1 calendars/);
    await expect(upgradeDay("2026-11-05", m.deps)).rejects.toThrow(/no timestamp/);
    m.rows.set("2026-11-05", {
      day: "2026-11-05",
      chainHash: DIGEST,
      r2Key: "gone",
      calendars: cals,
      status: "pending",
      btcHeight: null,
      createdAt: "x",
      upgradedAt: null,
    });
    await expect(upgradeDay("2026-11-05", m.deps)).rejects.toThrow(/receipt missing/);
  });
});

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  GENESIS,
  addDays,
  canonical,
  chainHash,
  concat,
  entryHash,
  fromHex,
  isDay,
  isHash,
  merkleProof,
  merkleRoot,
  sha256,
  studyDayLeaf,
  studyDayPreimage,
  toHex,
  utf8,
  verifyChain,
  verifyProof,
} from "@lianki/lian";

/** Independent reference: node:crypto, not Web Crypto. */
const H = (s: string) => createHash("sha256").update(s).digest("hex");
const LEAVES = ["a", "b", "c", "d", "e"].map(H);

describe("bytes", () => {
  test("SHA-256 known vectors (FIPS 180-2)", async () => {
    expect(toHex(await sha256(new Uint8Array()))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(toHex(await sha256(utf8("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  test("hex round-trips and refuses anything else", () => {
    expect(toHex(fromHex("00ff10"))).toBe("00ff10");
    expect(() => fromHex("0")).toThrow();
    expect(() => fromHex("AB")).toThrow();
    expect(() => fromHex(1 as unknown as string)).toThrow();
    expect(toHex(concat(fromHex("01"), fromHex("0203")))).toBe("010203");
    expect(isHash(H("a"))).toBe(true);
    expect(isHash("ab")).toBe(false);
  });
});

describe("canonical encoding", () => {
  test("sorted keys, no whitespace, integers only", () => {
    expect(canonical({ b: 1, a: [true, null, "x"], c: { z: 0, y: -0 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}',
    );
    expect(canonical(Object.create(null))).toBe("{}");
    expect(canonical(false)).toBe("false");
    expect(() => canonical(1.5)).toThrow();
    expect(() => canonical(NaN)).toThrow();
    expect(() => canonical(undefined)).toThrow();
    expect(() => canonical({ a: undefined })).toThrow();
    expect(() => canonical(new Date())).toThrow();
    expect(() => canonical(() => 1)).toThrow();
  });
  test("the same entry hashes the same whatever the key order", async () => {
    expect(await entryHash({ a: 1, b: 2 })).toBe(await entryHash({ b: 2, a: 1 }));
    expect(await entryHash("abc")).toBe(H('"abc"'));
  });
});

describe("Merkle tree", () => {
  test("roots match the reference vectors (RFC 6962 prefixes, odd node carried up)", async () => {
    expect(await merkleRoot([])).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    const want = [
      "a23bd5b06da9048238a65b3f1d9d0b9e15fae3dde262688e6489aa4c763d1820",
      "ad5ca6cddc0b27c6a83e332bf28011769236e6c6a1f786ebf7b5267b37a5bd22",
      "cac3d448d4e20a2ad5eae1f500e63c2a7f9217cd14572ba7fd22e26dc1ec2648",
      "3baac34fdbf4f2297a37c0613822d0c48efdcd6602ca7a4f48ceb31339ffb3d5",
      "4dc1abc938a0141a3c7cd1fed88948c35c4452e7e8aff9b1503eb5100a2c77b3",
    ];
    for (let k = 1; k <= 5; k++) expect(await merkleRoot(LEAVES.slice(0, k))).toBe(want[k - 1]);
  });

  test("every leaf's proof verifies, for every size up to 9", async () => {
    const many = Array.from({ length: 9 }, (_, i) => H(String(i)));
    for (let n = 1; n <= many.length; n++) {
      const ls = many.slice(0, n);
      const root = await merkleRoot(ls);
      for (let i = 0; i < n; i++)
        expect(await verifyProof(ls[i], await merkleProof(ls, i), root)).toBe(true);
    }
  });

  test("a proof fails for another leaf, another root, a changed step or junk", async () => {
    const root = await merkleRoot(LEAVES);
    const p = await merkleProof(LEAVES, 2);
    expect(await verifyProof(LEAVES[3], p, root)).toBe(false);
    expect(await verifyProof(LEAVES[2], p, H("x"))).toBe(false);
    expect(
      await verifyProof(
        LEAVES[2],
        [{ ...p[0], side: p[0].side === "L" ? "R" : "L" }, ...p.slice(1)],
        root,
      ),
    ).toBe(false);
    expect(await verifyProof(LEAVES[2], [{ side: "L", hash: "zz" }], root)).toBe(false);
    expect(await verifyProof(LEAVES[2], [{ side: "X" as "L", hash: H("q") }], root)).toBe(false);
    expect(await verifyProof("nope", p, root)).toBe(false);
    expect(await verifyProof(LEAVES[2], "x" as never, root)).toBe(false);
    // An inner node is not a leaf (domain separation).
    expect(await verifyProof(p[0].hash, p.slice(1), root)).toBe(false);
  });

  test("bad input throws", async () => {
    await expect(merkleRoot(["xyz"])).rejects.toThrow();
    await expect(merkleProof(LEAVES, 5)).rejects.toThrow();
    await expect(merkleProof(LEAVES, -1)).rejects.toThrow();
  });
});

async function buildChain(n: number, start = "2026-11-01") {
  const days = [];
  let prev = GENESIS;
  for (let i = 0; i < n; i++) {
    const day = addDays(start, i);
    const merkleRoot = H(`root ${i}`);
    const c = await chainHash(day, merkleRoot, prev);
    days.push({ day, merkleRoot, chainHash: c });
    prev = c;
  }
  return days;
}

describe("chain", () => {
  test("chain hash matches the reference vector", async () => {
    const root = await merkleRoot(LEAVES.slice(0, 3));
    expect(await chainHash("2026-11-05", root, GENESIS)).toBe(
      "947692fec7dbf6adfad049bfe934b75f2490cfe0d5db3f3b7fbe995fe6ca90cd",
    );
  });

  test("days", () => {
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("2026-13-01")).toBe(false);
    expect(isDay(20261105)).toBe(false);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(() => addDays("nope", 1)).toThrow();
  });

  test("bad chain input throws", async () => {
    await expect(chainHash("2026-11-5", H("a"), GENESIS)).rejects.toThrow();
    await expect(chainHash("2026-11-05", "ab", GENESIS)).rejects.toThrow();
    await expect(chainHash("2026-11-05", H("a"), GENESIS, 0)).rejects.toThrow();
  });

  test("an intact chain verifies; an empty one too", async () => {
    const days = await buildChain(6);
    const r = await verifyChain(days);
    expect(r).toEqual({ ok: true, days: 6, head: days[5].chainHash });
    expect(await verifyChain([])).toEqual({ ok: true, days: 0, head: GENESIS });
    // A suffix verifies from the day before it.
    expect((await verifyChain(days.slice(3), days[2].chainHash)).ok).toBe(true);
  });

  test("altering any one day is detected at that day", async () => {
    const days = await buildChain(6);
    for (let i = 0; i < days.length; i++) {
      for (const field of ["merkleRoot", "chainHash"] as const) {
        const bad = days.map((d) => ({ ...d }));
        bad[i][field] = H(`tampered ${i}`);
        const r = await verifyChain(bad);
        expect(r).toEqual({ ok: false, index: i, day: days[i].day, reason: "hash" });
      }
    }
  });

  test("re-chaining after an edit still fails at the edited day (the head moves)", async () => {
    const days = await buildChain(4);
    const forged = days.map((d) => ({ ...d }));
    forged[1].merkleRoot = H("forged");
    let prev = forged[0].chainHash;
    for (let i = 1; i < forged.length; i++) {
      forged[i].chainHash = await chainHash(forged[i].day, forged[i].merkleRoot, prev);
      prev = forged[i].chainHash;
    }
    // Self-consistent, but its head differs from the published one.
    const r = await verifyChain(forged);
    expect(r.ok && r.head).not.toBe(days[3].chainHash);
  });

  test("removed, reordered and malformed days are detected", async () => {
    const days = await buildChain(5);
    expect(await verifyChain([...days.slice(0, 2), ...days.slice(3)])).toMatchObject({
      ok: false,
      index: 2,
      reason: "hash",
    });
    expect(await verifyChain([days[0], days[0]])).toMatchObject({ ok: false, reason: "order" });
    expect(await verifyChain([{ ...days[0], day: "bad" }])).toMatchObject({ reason: "input" });
    expect(await verifyChain([null as never])).toMatchObject({ reason: "input" });
    expect(await verifyChain([{ ...days[0], version: 999 }])).toMatchObject({ reason: "input" });
  });
});

describe("study-day leaf", () => {
  const salt = "00".repeat(32);
  test("is H(canonical tuple) — reference vector", async () => {
    const leaf = await studyDayLeaf(studyDayPreimage(salt, "u1", "2026-11-05", { reviews: 7 }));
    expect(leaf).toBe("b481bea0a9226c44060585c5296f73c3972f6966309e4a0aa1696035c486d93b");
    expect(leaf).toBe(
      H(
        '["lian/study-day/1","0000000000000000000000000000000000000000000000000000000000000000","u1","2026-11-05",{"reviews":7}]',
      ),
    );
  });
  test("any field changes the leaf; the salt hides the user", async () => {
    const base = await studyDayLeaf(studyDayPreimage(salt, "u1", "2026-11-05", { reviews: 7 }));
    const other = "11".repeat(32);
    for (const p of [
      studyDayPreimage(other, "u1", "2026-11-05", { reviews: 7 }),
      studyDayPreimage(salt, "u2", "2026-11-05", { reviews: 7 }),
      studyDayPreimage(salt, "u1", "2026-11-06", { reviews: 7 }),
      studyDayPreimage(salt, "u1", "2026-11-05", { reviews: 8 }),
    ])
      expect(await studyDayLeaf(p)).not.toBe(base);
  });
  test("refuses a short salt, no user, a bad day or count; drops extra summary fields", () => {
    expect(() => studyDayPreimage("ab", "u1", "2026-11-05", { reviews: 1 })).toThrow();
    expect(() => studyDayPreimage(salt, "", "2026-11-05", { reviews: 1 })).toThrow();
    expect(() => studyDayPreimage(salt, "u1", "2026-11-31", { reviews: 1 })).toThrow();
    expect(() => studyDayPreimage(salt, "u1", "2026-11-05", { reviews: -1 })).toThrow();
    const p = studyDayPreimage(salt, "u1", "2026-11-05", { reviews: 1, card: "x" } as never);
    expect(p.summary).toEqual({ reviews: 1 });
  });
});

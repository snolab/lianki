/**
 * The daily chain: each day's anchor commits to that day's Merkle root and to
 * the day before, so changing any anchored day changes every chain hash after
 * it — and a chain hash published (OpenTimestamps, git) pins every day up to
 * it.
 *
 *   chainHash(N) = H(version ‖ day ‖ merkleRoot(N) ‖ chainHash(N−1))
 *
 * version: one byte (CHAIN_VERSION). day: the 10 ASCII bytes "YYYY-MM-DD".
 * merkleRoot, chainHash: 32 bytes each. Every field has a fixed length, so the
 * concatenation is unambiguous. The first day's previous hash is GENESIS
 * (32 zero bytes).
 */
import { concat, fromHex, isHash, sha256, toHex, utf8 } from "./bytes";

export const CHAIN_VERSION = 1;
export const GENESIS = "0".repeat(64);

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isDay(d: unknown): d is string {
  if (typeof d !== "string" || !DAY.test(d)) return false;
  return new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
}

/** The UTC day `n` days after `day` (n may be negative). */
export function addDays(day: string, n: number): string {
  if (!isDay(day)) throw new Error("lian: not a day");
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export async function chainHash(
  day: string,
  merkleRoot: string,
  prev: string,
  version = CHAIN_VERSION,
): Promise<string> {
  if (!isDay(day)) throw new Error("lian: not a day");
  if (!isHash(merkleRoot) || !isHash(prev)) throw new Error("lian: not a 32-byte hex hash");
  if (!Number.isInteger(version) || version < 1 || version > 255)
    throw new Error("lian: bad version");
  return toHex(
    await sha256(
      concat(new Uint8Array([version]), utf8(day), fromHex(merkleRoot), fromHex(prev)),
    ),
  );
}

export type Anchor = { day: string; merkleRoot: string; chainHash: string; version?: number };

export type ChainCheck =
  | { ok: true; days: number; head: string }
  | { ok: false; index: number; day: string; reason: "order" | "hash" | "input" };

/**
 * Re-derive every chain hash from the first day (whose previous hash is
 * `start`, GENESIS for the full chain) and compare. The first mismatch is
 * the day that was altered, or the first day after a removed one. Days must
 * be strictly increasing. An empty list is ok.
 */
export async function verifyChain(days: Anchor[], start = GENESIS): Promise<ChainCheck> {
  let prev = start;
  let last = "";
  for (let i = 0; i < days.length; i++) {
    const a = days[i];
    if (!a || !isDay(a.day) || !isHash(a.merkleRoot) || !isHash(a.chainHash))
      return { ok: false, index: i, day: String(a?.day), reason: "input" };
    if (a.day <= last) return { ok: false, index: i, day: a.day, reason: "order" };
    let want: string;
    try {
      want = await chainHash(a.day, a.merkleRoot, prev, a.version ?? CHAIN_VERSION);
    } catch {
      return { ok: false, index: i, day: a.day, reason: "input" };
    }
    if (want !== a.chainHash) return { ok: false, index: i, day: a.day, reason: "hash" };
    prev = a.chainHash;
    last = a.day;
  }
  return { ok: true, days: days.length, head: prev };
}

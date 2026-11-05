/**
 * External timestamps of the chain at milestones (docs/lian.md, "Publishing"):
 * a day's chain hash goes to the OpenTimestamps calendars, the .ots receipt
 * is kept in R2 with a lian_timestamp row, and `upgrade` later swaps the
 * calendars' pending promise for the path to a Bitcoin block. Owner-triggered
 * (scripts/lian/timestamp.ts), never on a timer.
 *
 * Storage is passed in, so the same steps run against wrangler (the script)
 * and against an in-memory store with a mocked calendar (unit tests).
 */
import { type Fetch, OTS_CALENDARS, stamp, upgrade } from "@lianki/lian/ots";
import { isDay } from "@lianki/lian";

export type StampRow = {
  day: string;
  chainHash: string;
  r2Key: string;
  calendars: string[];
  status: "pending" | "bitcoin";
  btcHeight: number | null;
  createdAt: string;
  upgradedAt: string | null;
};

export type StampDeps = {
  readChainHash(day: string): Promise<string | null>;
  readStamp(day: string): Promise<StampRow | null>;
  saveStamp(row: StampRow, isNew: boolean): Promise<void>;
  putReceipt(key: string, ots: Uint8Array): Promise<void>;
  getReceipt(key: string): Promise<Uint8Array | null>;
  fetch: Fetch;
  calendars?: string[];
};

export const receiptKey = (day: string) => `lian/ots/${day}.ots`;

/** Stamp `day`'s chain hash. A day already stamped is left as it is. */
export async function stampDay(
  day: string,
  deps: StampDeps,
  now = new Date(),
): Promise<{ row: StampRow; already: boolean; failed: string[] }> {
  if (!isDay(day)) throw new Error("not a day (YYYY-MM-DD)");
  const have = await deps.readStamp(day);
  if (have) return { row: have, already: true, failed: [] };
  const chainHash = await deps.readChainHash(day);
  if (!chainHash) throw new Error(`${day} is not anchored`);
  const { ots, answered, failed } = await stamp(chainHash, {
    calendars: deps.calendars ?? OTS_CALENDARS,
    fetch: deps.fetch,
    min: 2,
  });
  const row: StampRow = {
    day,
    chainHash,
    r2Key: receiptKey(day),
    calendars: answered,
    status: "pending",
    btcHeight: null,
    createdAt: now.toISOString(),
    upgradedAt: null,
  };
  // The receipt first: a row never points at a receipt that is not there.
  await deps.putReceipt(row.r2Key, ots);
  await deps.saveStamp(row, true);
  return { row, already: false, failed };
}

/** Fetch the Bitcoin path for `day`'s receipt, if a calendar has it yet. */
export async function upgradeDay(
  day: string,
  deps: StampDeps,
  now = new Date(),
): Promise<{ row: StampRow; changed: boolean }> {
  const row = await deps.readStamp(day);
  if (!row) throw new Error(`${day} has no timestamp`);
  if (row.status === "bitcoin") return { row, changed: false };
  const ots = await deps.getReceipt(row.r2Key);
  if (!ots) throw new Error(`receipt missing: ${row.r2Key}`);
  const up = await upgrade(ots, { fetch: deps.fetch });
  if (!up.changed) return { row, changed: false };
  const next: StampRow = {
    ...row,
    status: up.status,
    btcHeight: up.height,
    upgradedAt: now.toISOString(),
  };
  await deps.putReceipt(row.r2Key, up.ots);
  await deps.saveStamp(next, false);
  return { row: next, changed: true };
}

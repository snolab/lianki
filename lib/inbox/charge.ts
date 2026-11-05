/**
 * What the inbox costs, in real USD (R2's list prices, config.ts INBOX.r2),
 * charged to the user by usage (owner, 2026-11-04: "按用量扣莲（上传和存储）").
 * The same seam as the AI gloss (lib/read/gloss-server.ts chargeAi): the
 * credit unit is not final, so for now this only records the cost; the debit
 * goes here, and only here. No ledger, no unit names.
 *
 * Event-driven, nothing polls:
 * - an upload: one Class A write;
 * - a read (a download): one Class B read;
 * - storage: accrued as bytes stored × time since it was last settled
 *   (inbox_usage.settled_ms), settled at every change (upload, delete) and
 *   whenever the user opens the inbox view (store.ts settleStorage).
 */
import { INBOX } from "./config";

const GB = 1024 ** 3;
/** A billing month, as R2 counts GB-months: 30 days. */
export const MONTH_MS = 30 * 24 * 3600_000;

/** One write's cost (PutObject). */
export const uploadUsd = () => INBOX.r2.classAUsdPerMillion / 1e6;
/** One read's cost (GetObject). */
export const readUsd = () => INBOX.r2.classBUsdPerMillion / 1e6;
/** Storage of `bytes` for `ms`. */
export const storageUsd = (bytes: number, ms: number) =>
  (Math.max(0, bytes) / GB) * (Math.max(0, ms) / MONTH_MS) * INBOX.r2.storageUsdPerGbMonth;
/** What keeping `bytes` stored costs per month (shown in the inbox view's usage). */
export const monthlyUsd = (bytes: number) => storageUsd(bytes, MONTH_MS);

export type InboxUse = {
  kind: "upload" | "storage" | "read";
  usd: number;
  bytes: number;
  /** storage: the span it covers, in ms. */
  ms?: number;
  /** The same R2 costs for something other than the inbox (lib/profile: a user's avatar). */
  what?: "avatar";
};

/** Settle one cost against the user: recorded now; the debit lands here once the unit exists. */
export async function chargeInbox(userId: string, use: InboxUse) {
  void userId;
  console.log(
    JSON.stringify({
      event: "inbox.cost",
      kind: use.kind,
      usd: use.usd,
      bytes: use.bytes,
      ...(use.what ? { what: use.what } : {}),
      ...(use.ms !== undefined ? { ms: use.ms } : {}),
    }),
  );
  return { ok: true as const };
}

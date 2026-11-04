/**
 * The chat inbox's limits and prices, in one object (docs/dev-debug-widget.md,
 * "Attachments and the inbox"). THE OWNER MAY CHANGE ANY OF THEM: the caps
 * below are conservative first values the agent picked on 2026-11-04 (he
 * decides the final numbers). Changing a value here and deploying is all it
 * takes.
 *
 * Cost (owner, 2026-11-04 17:45 JST, tap: "按用量扣莲（上传和存储）"): users
 * bear the real R2 cost of what they upload and store, charged by usage
 * through lib/inbox/charge.ts. There is no product quota; `maxStoredBytes`
 * is only a safety cap.
 */
export const INBOX = {
  /** Largest single file, in bytes (20 MB: a phone photo or a short clip; not a long video). */
  maxFileBytes: 20 * 1024 * 1024,
  /** Most bytes one user uploads in any rolling 24 hours, all files together (200 MB). */
  maxDayBytes: 200 * 1024 * 1024,
  /** Safety cap: most bytes one user keeps stored at once (2 GB). Not a plan limit. */
  maxStoredBytes: 2 * 1024 * 1024 * 1024,
  /** Most uploads per minute (per Worker isolate), whatever their size. */
  uploadsPerMinute: 30,
  /** How long an agent's download ticket (`eval.ts inbox get`) stays good; single use. */
  ticketMs: 60_000,
  /**
   * Cloudflare R2 list prices, Standard storage class, USD
   * (https://developers.cloudflare.com/r2/pricing/, as of 2026-11):
   * storage $0.015 per GB-month, Class A operations $4.50 per million,
   * Class B operations $0.36 per million; egress free. What R2 bills
   * Lianki, not a product price. The free tier is not subtracted: each user
   * bears the real marginal cost.
   */
  r2: {
    storageUsdPerGbMonth: 0.015,
    /** Class A (writes: PutObject; a DeleteObject is free). */
    classAUsdPerMillion: 4.5,
    /** Class B (reads: GetObject). */
    classBUsdPerMillion: 0.36,
  },
} as const;

/** R2 key prefix: every inbox object lives under it, in the existing lianki-blobs bucket. */
export const INBOX_PREFIX = "inbox/";

/**
 * Retention: none. Nothing is ever deleted automatically; a file stays until
 * the owner deletes it (the chat's + menu → Inbox → Delete, his own session).
 */
export const INBOX_AUTO_DELETE = false;

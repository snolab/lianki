/**
 * "AI: a stored file → words" (docs/import-material.md): its flag, its
 * feature id and its limits. No imports: the route and the page share them.
 *
 * The limits are guards against abuse and runaway cost, not product numbers:
 * the page never shows them (an over-limit file is "too large", a cut-off one
 * "only the first part").
 */
export const AI_IMPORT = {
  /** The owner's switch at /dev/flags (lib/flags.ts, audience owner). */
  flag: "words.import-ai",
  /** The ledger note of its charges (lib/payments/prices.ts FEATURES). */
  feature: "words.import-ai",
  /** One stored file, in bytes, before it is read (the inbox's per-file cap). */
  maxFileBytes: 20 * 1024 * 1024,
  /** All the text read from the file, in characters; the rest is cut before any call. */
  maxTextChars: 60_000,
  /** One model call's share of the text, in characters. */
  chunkChars: 6_000,
  /** Text calls at most (maxTextChars / chunkChars). */
  maxChunks: 10,
  /** Calls running at once; the hold is checked between rounds. */
  parallel: 3,
  /** One call's time limit, in ms (a long answer takes a minute). */
  callTimeoutMs: 90_000,
  /** Images in one request (a stored photo). */
  maxImages: 4,
  /** One image as a data URL, in characters (~1.5 MB of JPEG). */
  maxImageChars: 2_000_000,
  /** The JSON body ({fileId, locale}), in bytes. */
  maxBodyBytes: 2048,
  /** Rows one call may answer. */
  maxRowsPerCall: 150,
  /** Output tokens of one call (maxRowsPerCall short rows). */
  maxOutputTokens: 4000,
  /** Rows in the CSV at most, after merging the calls. */
  maxRows: 1500,
  /** Cells, in characters. */
  maxCellChars: { word: 200, meaning: 300, example: 400 },
  /** Conversions per user per window (per Worker isolate, lib/rateLimit.ts). */
  rate: { windowMs: 10 * 60_000, max: 20 },
} as const;

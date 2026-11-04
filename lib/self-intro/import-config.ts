/**
 * The /self-intro import step (docs/self-intro-import.md): what it fills, and
 * its limits. Client-safe: imported by the page, the parsers and the route.
 *
 * The limits are operational guards against abuse and runaway cost, not
 * product numbers: the UI never shows them (an over-limit file is "too
 * large", nothing more). The file cap matches the inbox's and the EPUB
 * import's (lib/inbox/config.ts, lib/epub/unzip.ts); the rate limit is in
 * the style of the other self-intro routes (per user, per isolate).
 */

/** The self-introduction fields, in the order the interview asks them. */
export const SELF_INTRO_FIELDS = [
  "name",
  "from",
  "age",
  "occupation",
  "hobby",
  "languages",
] as const;
export type SelfIntroField = (typeof SELF_INTRO_FIELDS)[number];
export type SelfIntroFields = Record<SelfIntroField, string>;

export const emptyFields = (): SelfIntroFields =>
  Object.fromEntries(SELF_INTRO_FIELDS.map((k) => [k, ""])) as SelfIntroFields;

export const IMPORT = {
  /** The owner's switch at /dev/flags (lib/flags.ts); the owner sees the step while it is off. */
  flag: "self-intro.import",
  /** One picked file, in bytes, before parsing (as the inbox and the EPUB import). */
  maxFileBytes: 20 * 1024 * 1024,
  /** Files picked at once. */
  maxFiles: 10,
  /** All text together (typed + every file's), in characters; the rest is cut before the call. */
  maxTextChars: 40_000,
  /** Images sent to the model in one request (photos, screenshots, handwritten notes). */
  maxImages: 4,
  /** An image's longer side after the page shrinks it, in pixels (enough to read handwriting). */
  imageMaxSide: 1600,
  /** One image as a data URL after shrinking, in characters (~1.5 MB of JPEG). */
  maxImageChars: 2_000_000,
  /** The whole JSON request body, in bytes. */
  maxBodyBytes: 10 * 1024 * 1024,
  /** A field's value, in characters (the translate route takes up to 200). */
  maxFieldChars: 200,
  /** Imports per user per window (per Worker isolate, lib/rateLimit.ts). */
  rate: { windowMs: 10 * 60_000, max: 10 },
  /** Facts one import lists for the user to keep, edit or drop. */
  maxFacts: 30,
  /** Most output tokens of the one extraction call (up to `maxFacts` short facts). */
  maxOutputTokens: 1500,
} as const;

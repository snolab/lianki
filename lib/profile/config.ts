/**
 * Limits of the editable profile (docs/secrets-and-auth.md, "Profile edits"),
 * in one object. First values, picked by the agent on 2026-11-05; the owner
 * may change any of them.
 */
const MIN = 60_000;

export const PROFILE = {
  /** Longest display name, in characters (code points): fits any nav, no paragraph. */
  nameMaxChars: 64,
  /** The stored avatar's side, in px: a 128 CSS px circle on a 3x screen, and a little room. */
  avatarSide: 512,
  /** Largest stored avatar (a 512 px WebP/JPEG is well under 100 KB). */
  avatarMaxBytes: 1024 * 1024,
  /** Largest photo the browser will try to decode and shrink. */
  pickMaxBytes: 40 * 1024 * 1024,
  /** Name changes per user. */
  nameLimit: { max: 20, windowMs: 10 * MIN },
  /** Avatar uploads and removals per user. */
  avatarLimit: { max: 10, windowMs: 60 * MIN },
} as const;

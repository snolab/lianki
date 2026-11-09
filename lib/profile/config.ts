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
  /** Asking to change the sign-in address, per user. */
  emailLimit: { max: 5, windowMs: 60 * MIN },
  /** Mails one address can be sent by such requests, from anyone. */
  emailTargetLimit: { max: 3, windowMs: 60 * MIN },
  /** Pressing confirm on the mailed link's page, per IP. */
  emailConfirmLimit: { max: 20, windowMs: 15 * MIN },
  /** How long the mailed link works. */
  emailLinkMs: 60 * MIN,
  /** How young a session has to be to ask (better-auth's freshAge, as for adding a passkey). */
  emailFreshMs: 24 * 60 * MIN,
} as const;

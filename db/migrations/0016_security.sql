-- Security counters and known sign-in devices (lib/security, docs/security-measures.md).
--
-- auth_throttle: one row per counted key — failed sign-ins per account or IP,
-- OTP sends, checkout starts. A fixed window: `count` hits since `windowStart`
-- (epoch ms); `lockedUntil` (epoch ms, 0 = not locked) is set when a failure
-- counter reaches its limit. Keys never hold a raw email: accounts are a
-- SHA-256 of the lowercased address.
CREATE TABLE IF NOT EXISTS auth_throttle (
  key         TEXT PRIMARY KEY NOT NULL,
  count       INTEGER NOT NULL,
  windowStart INTEGER NOT NULL,
  lockedUntil INTEGER NOT NULL DEFAULT 0
);

-- known_device: the browsers a user has signed in from. `deviceHash` is a
-- SHA-256 of the random httpOnly `lk_device` cookie, never the cookie itself.
-- A sign-in from a browser not listed here sends the login notification mail.
CREATE TABLE IF NOT EXISTS known_device (
  userId     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  deviceHash TEXT NOT NULL,
  userAgent  TEXT,
  firstSeen  TEXT NOT NULL,
  lastSeen   TEXT NOT NULL,
  PRIMARY KEY (userId, deviceHash)
);

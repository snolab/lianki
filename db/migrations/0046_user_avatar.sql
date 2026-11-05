-- A user's own uploaded picture (lib/profile/, docs/secrets-and-auth.md,
-- "Profile edits"). The object is in R2 lianki-blobs under r2Key; user.image
-- holds its same-origin URL. previousImage is the picture from the sign-in
-- provider it replaced, so removing the upload goes back to it.
CREATE TABLE IF NOT EXISTS user_avatar (
  userId        TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  r2Key         TEXT NOT NULL,
  size          INTEGER NOT NULL,
  previousImage TEXT,
  updatedMs     INTEGER NOT NULL
);

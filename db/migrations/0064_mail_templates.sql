-- Mail templates edited at /dev/templates (lib/mail-templates/store.ts,
-- docs/mail-templates.md). The built-in defaults live in code; a row here
-- overrides one template in one language once it is active.
--
-- mail_template_version is APPEND-ONLY: every save adds a version, nothing is
-- ever changed or removed (the triggers refuse it). `schema` is the template's
-- variable-set version the edit was written for; an edit for an older schema
-- is never sent. created_by is the editor's user id. Times are epoch ms.
CREATE TABLE IF NOT EXISTS mail_template_version (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  template    TEXT NOT NULL,
  locale      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  schema      INTEGER NOT NULL,
  subject     TEXT NOT NULL,
  html        TEXT NOT NULL,
  text        TEXT NOT NULL,
  note        TEXT,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (template, locale, version)
);

CREATE TRIGGER IF NOT EXISTS mail_template_version_no_update
BEFORE UPDATE ON mail_template_version
BEGIN
  SELECT RAISE(ABORT, 'mail_template_version is append-only');
END;

CREATE TRIGGER IF NOT EXISTS mail_template_version_no_delete
BEFORE DELETE ON mail_template_version
BEGIN
  SELECT RAISE(ABORT, 'mail_template_version is append-only');
END;

-- Which version a template sends in a language. No row, or version 0: the
-- built-in default. Rollback = point it at an older version (or 0).
CREATE TABLE IF NOT EXISTS mail_template_active (
  template      TEXT NOT NULL,
  locale        TEXT NOT NULL,
  version       INTEGER NOT NULL,
  activated_by  TEXT NOT NULL,
  activated_at  INTEGER NOT NULL,
  PRIMARY KEY (template, locale)
);

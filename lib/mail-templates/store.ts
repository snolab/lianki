/**
 * The stored edits of mail templates in D1 (db/migrations/0064_mail_templates.sql,
 * docs/mail-templates.md): an append-only version list per template and
 * language, and which version is active (0 = the built-in default).
 *
 * - save: validate (locked variables, sanitised HTML) → append version N+1 →
 *   make it active. Refused when invalid; nothing is written.
 * - activate (rollback): point the template at an older version, or 0. A
 *   version written for another schema, or one that no longer validates, is
 *   refused.
 */
import type { D1Like } from "@/lib/d1/types";
import { MAIL_TEMPLATES, type MailTemplateId } from "./defs";
import { validateSource, type TemplateError, type TemplateSource } from "./engine";
import type { MailLocale } from "./locales";

export type TemplateDb = Pick<D1Like, "prepare">;

export type StoredVersion = TemplateSource & {
  version: number;
  schema: number;
  note: string | null;
  createdBy: string;
  createdAt: number;
};

const COLS =
  "version, schema, subject, html, text, note, created_by AS createdBy, created_at AS createdAt";

/** Every stored version of one template in one language, newest first. */
export async function listVersions(
  db: TemplateDb,
  id: MailTemplateId,
  locale: MailLocale,
): Promise<StoredVersion[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM mail_template_version WHERE template = ?1 AND locale = ?2 ORDER BY version DESC`,
    )
    .bind(id, locale)
    .all<StoredVersion>();
  return results;
}

/** The active version number (0: the built-in default). */
export async function activeVersionNumber(
  db: TemplateDb,
  id: MailTemplateId,
  locale: MailLocale,
): Promise<number> {
  const row = await db
    .prepare("SELECT version FROM mail_template_active WHERE template = ?1 AND locale = ?2")
    .bind(id, locale)
    .first<{ version: number }>();
  return row?.version ?? 0;
}

/** Which version every edited template sends, per language (only the non-default ones). */
export async function activeMap(db: TemplateDb): Promise<Record<string, Record<string, number>>> {
  const { results } = await db
    .prepare("SELECT template, locale, version FROM mail_template_active WHERE version > 0")
    .all<{ template: string; locale: string; version: number }>();
  const out: Record<string, Record<string, number>> = {};
  for (const r of results) (out[r.template] ??= {})[r.locale] = r.version;
  return out;
}

/** The active stored version, or null when the built-in default is active. */
export async function activeStored(
  db: TemplateDb,
  id: MailTemplateId,
  locale: MailLocale,
): Promise<StoredVersion | null> {
  return db
    .prepare(
      `SELECT v.version, v.schema, v.subject, v.html, v.text, v.note, v.created_by AS createdBy, v.created_at AS createdAt FROM mail_template_active a
       JOIN mail_template_version v
         ON v.template = a.template AND v.locale = a.locale AND v.version = a.version
       WHERE a.template = ?1 AND a.locale = ?2 AND a.version > 0`,
    )
    .bind(id, locale)
    .first<StoredVersion>();
}

async function setActive(
  db: TemplateDb,
  id: MailTemplateId,
  locale: MailLocale,
  version: number,
  by: string,
  now: number,
) {
  await db
    .prepare(
      `INSERT INTO mail_template_active (template, locale, version, activated_by, activated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(template, locale) DO UPDATE SET
         version = ?3, activated_by = ?4, activated_at = ?5`,
    )
    .bind(id, locale, version, by, now)
    .run();
}

export type SaveResult = { ok: true; version: number } | { ok: false; errors: TemplateError[] };

/** Validate and append a new version, then make it the active one. */
export async function saveVersion(
  db: TemplateDb,
  input: {
    id: MailTemplateId;
    locale: MailLocale;
    source: TemplateSource;
    note?: string | null;
    by: string;
    now?: number;
  },
): Promise<SaveResult> {
  const def = MAIL_TEMPLATES[input.id];
  const errors = validateSource(input.source, def.vars);
  if (errors.length) return { ok: false, errors };
  const now = input.now ?? Date.now();
  const top = await db
    .prepare(
      "SELECT MAX(version) AS v FROM mail_template_version WHERE template = ?1 AND locale = ?2",
    )
    .bind(input.id, input.locale)
    .first<{ v: number | null }>();
  const version = (top?.v ?? 0) + 1;
  await db
    .prepare(
      `INSERT INTO mail_template_version
         (template, locale, version, schema, subject, html, text, note, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      input.id,
      input.locale,
      version,
      def.schema,
      input.source.subject,
      input.source.html,
      input.source.text,
      input.note?.trim().slice(0, 200) || null,
      input.by,
      now,
    )
    .run();
  await setActive(db, input.id, input.locale, version, input.by, now);
  return { ok: true, version };
}

export type ActivateResult =
  | { ok: true; version: number }
  | { ok: false; error: "no-such-version" | "old-schema" | "invalid"; errors?: TemplateError[] };

/** Rollback: make `version` (0 = the built-in default) the one that is sent. */
export async function activateVersion(
  db: TemplateDb,
  input: { id: MailTemplateId; locale: MailLocale; version: number; by: string; now?: number },
): Promise<ActivateResult> {
  const now = input.now ?? Date.now();
  if (input.version !== 0) {
    const row = await db
      .prepare(
        `SELECT ${COLS} FROM mail_template_version WHERE template = ?1 AND locale = ?2 AND version = ?3`,
      )
      .bind(input.id, input.locale, input.version)
      .first<StoredVersion>();
    if (!row) return { ok: false, error: "no-such-version" };
    const def = MAIL_TEMPLATES[input.id];
    if (row.schema !== def.schema) return { ok: false, error: "old-schema" };
    const errors = validateSource(row, def.vars);
    if (errors.length) return { ok: false, error: "invalid", errors };
  }
  await setActive(db, input.id, input.locale, input.version, input.by, now);
  return { ok: true, version: input.version };
}

/**
 * What /api/dev/templates does once the route has asked who is calling
 * (isDev; `who` null = not a developer → an empty 404, like every /api/dev
 * route). Plain functions over deps, so the unit tests drive every answer.
 * docs/mail-templates.md, "Editor".
 *
 *   GET  /api/dev/templates                      → the templates, locales, active versions
 *   GET  /api/dev/templates?id=…&locale=…        → one template in one language: built-in, versions, active
 *   POST {op:"save", id, locale, subject, html, text, note?}
 *   POST {op:"activate", id, locale, version}    (rollback; 0 = the built-in)
 *   POST {op:"test", id, locale, sample, subject, html, text}
 *        → the editor's source with sample values, to the caller's OWN address
 *          only; rate-limited; a stub on a local server.
 */
import { NextResponse } from "next/server";
import type { SendEmailInput } from "@/lib/email";
import { audit, type AuditDb } from "@/lib/security/audit-log";
import { sameOriginJsonPost } from "@/lib/security/same-origin";
import { hit, type ThrottleDb } from "@/lib/security/throttle";
import { renderWith } from "./compose";
import {
  MAIL_TEMPLATE_IDS,
  MAIL_TEMPLATES,
  SAMPLE_SETS,
  isMailTemplateId,
  type SampleSet,
} from "./defs";
import type { TemplateSource } from "./engine";
import { MAIL_LOCALES, isMailLocale } from "./locales";
import {
  activateVersion,
  activeMap,
  activeVersionNumber,
  listVersions,
  saveVersion,
  type TemplateDb,
} from "./store";

export type TemplatesCaller = { id: string; email: string };
export type TemplatesDb = TemplateDb & ThrottleDb & AuditDb;

export type TemplatesDeps = {
  db: () => TemplatesDb | null;
  send: (mail: SendEmailInput) => Promise<{ id: string }>;
  now?: () => number;
};

/** Test mails per developer: a few, to look at a change, never a mailing tool. */
export const TEST_SENDS = { max: 5, windowMs: 10 * 60_000 };

const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new NextResponse(null, { status: 404 });
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: NO_STORE });

export async function templatesGet(req: Request, who: TemplatesCaller | null, d: TemplatesDeps) {
  const db = who ? d.db() : null;
  if (!db) return notFound();
  const q = new URL(req.url).searchParams;
  const id = q.get("id");
  const locale = q.get("locale");
  if (id === null) {
    return json({
      templates: MAIL_TEMPLATE_IDS.map((t) => ({
        id: t,
        schema: MAIL_TEMPLATES[t].schema,
        vars: MAIL_TEMPLATES[t].vars,
      })),
      locales: MAIL_LOCALES,
      samples: SAMPLE_SETS,
      active: await activeMap(db),
    });
  }
  if (!isMailTemplateId(id) || !isMailLocale(locale)) return json({ error: "invalid" }, 400);
  const [versions, active] = await Promise.all([
    listVersions(db, id, locale),
    activeVersionNumber(db, id, locale),
  ]);
  return json({
    id,
    locale,
    schema: MAIL_TEMPLATES[id].schema,
    builtin: MAIL_TEMPLATES[id].builtin(locale),
    versions,
    active,
  });
}

type Body = {
  op?: unknown;
  id?: unknown;
  locale?: unknown;
  version?: unknown;
  sample?: unknown;
  subject?: unknown;
  html?: unknown;
  text?: unknown;
  note?: unknown;
};

const source = (b: Body): TemplateSource | null =>
  typeof b.subject === "string" && typeof b.html === "string" && typeof b.text === "string"
    ? { subject: b.subject, html: b.html, text: b.text }
    : null;

export async function templatesPost(req: Request, who: TemplatesCaller | null, d: TemplatesDeps) {
  const db = who ? d.db() : null;
  if (!who || !db) return notFound();
  if (!sameOriginJsonPost(req)) return json({ error: "forbidden" }, 403);
  const b = (await req.json().catch(() => null)) as Body | null;
  if (!b || !isMailTemplateId(b.id) || !isMailLocale(b.locale))
    return json({ error: "invalid" }, 400);
  const { id, locale } = b;
  const now = (d.now ?? Date.now)();
  const subject = `${id}:${locale}`;

  if (b.op === "save") {
    const src = source(b);
    if (!src) return json({ error: "invalid" }, 400);
    const r = await saveVersion(db, {
      id,
      locale,
      source: src,
      note: typeof b.note === "string" ? b.note : null,
      by: who.id,
      now,
    });
    if (!r.ok) return json({ error: "invalid-template", errors: r.errors }, 422);
    await audit(
      db,
      { kind: "mail-template.save", actor: who.id, subject, detail: `v${r.version}` },
      now,
    );
    return json({ version: r.version });
  }

  if (b.op === "activate") {
    const version = typeof b.version === "number" && Number.isInteger(b.version) ? b.version : -1;
    if (version < 0) return json({ error: "invalid" }, 400);
    const r = await activateVersion(db, { id, locale, version, by: who.id, now });
    if (!r.ok) return json({ error: r.error, errors: r.errors }, 422);
    await audit(
      db,
      { kind: "mail-template.activate", actor: who.id, subject, detail: `v${version}` },
      now,
    );
    return json({ version });
  }

  if (b.op === "test") {
    const src = source(b);
    const sample: SampleSet = SAMPLE_SETS.includes(b.sample as SampleSet)
      ? (b.sample as SampleSet)
      : "typical";
    if (!src) return json({ error: "invalid" }, 400);
    let mail: TemplateSource;
    try {
      mail = renderWith(id, locale, src, MAIL_TEMPLATES[id].samples[sample]);
    } catch (e) {
      const errors = (e as { errors?: unknown }).errors ?? [];
      return json({ error: "invalid-template", errors }, 422);
    }
    const limit = await hit(db, `mail-template-test:${who.id}`, TEST_SENDS, now);
    if (!limit.allowed)
      return json({ error: "rate-limited", retryAfterMs: limit.retryAfterMs }, 429);
    try {
      // Only ever the caller's own address: the session's, never one from the body.
      await d.send({
        to: who.email,
        subject: `[test] ${mail.subject}`,
        text: mail.text,
        html: mail.html,
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "mail.template.test-failed",
          template: id,
          locale,
          error: String(e).slice(0, 200),
        }),
      );
      return json({ error: "send-failed" }, 502);
    }
    await audit(db, { kind: "mail-template.test-send", actor: who.id, subject }, now);
    console.log(JSON.stringify({ event: "mail.template.test-sent", template: id, locale }));
    return json({ status: "sent" });
  }

  return json({ error: "invalid" }, 400);
}

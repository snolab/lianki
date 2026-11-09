"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { LOCALE_LABELS } from "@/lib/constants";
import { renderWith } from "@/lib/mail-templates/compose";
import { previewDoc } from "@/lib/mail-templates/layout";
import {
  MAIL_TEMPLATE_IDS,
  MAIL_TEMPLATES,
  SAMPLE_SETS,
  lockedVars,
  type MailTemplateId,
  type SampleSet,
} from "@/lib/mail-templates/defs";
import { lineDiff, htmlLines } from "@/lib/mail-templates/diff";
import {
  escapeHtml,
  validateSource,
  type TemplateError,
  type TemplateField,
  type TemplateSource,
} from "@/lib/mail-templates/engine";
import { MAIL_LOCALES, type MailLocale } from "@/lib/mail-templates/locales";
import { mailBrand } from "@/lib/mail-templates/brand";

type Version = TemplateSource & {
  version: number;
  note: string | null;
  createdAt: number;
  schema: number;
};
type Detail = { builtin: TemplateSource; versions: Version[]; active: number };

const camel = (id: string) => id.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const same = (a: TemplateSource, b: TemplateSource) =>
  a.subject === b.subject && a.html === b.html && a.text === b.text;
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const ERR_KEY: Record<TemplateError["code"], string> = {
  empty: "empty",
  "too-long": "tooLong",
  "subject-newline": "subjectNewline",
  "malformed-placeholder": "malformed",
  "unknown-var": "unknownVar",
  "missing-var": "missingVar",
  "link-var-not-link": "linkNotLink",
  "html-syntax": "htmlSyntax",
  "html-comment": "htmlComment",
  "html-tag": "htmlTag",
  "html-event-handler": "htmlHandler",
  "html-attr": "htmlAttr",
  "html-href": "htmlHref",
  "html-src": "htmlSrc",
  "html-style": "htmlStyle",
  "var-in-attr": "varInAttr",
};

const BTN =
  "min-h-9 px-3 rounded bg-[oklch(0.2_0_0)] text-[oklch(0.98_0_0)] dark:bg-[oklch(0.95_0_0)] dark:text-[oklch(0.15_0_0)] disabled:opacity-40";
const BTN2 = "min-h-9 px-3 rounded border disabled:opacity-40";
const FIELD = "w-full min-w-0 border rounded px-2 py-1 bg-transparent font-mono text-sm";
const ERR = "text-sm text-[oklch(0.5_0.2_27)] dark:text-[oklch(0.75_0.15_27)]";
const OK = "text-sm text-[oklch(0.45_0.12_150)] dark:text-[oklch(0.8_0.12_150)]";

/** What the preview shows when the source does not validate: values filled in, escaped. */
function roughRender(src: TemplateSource, values: Record<string, string>): TemplateSource {
  const f = (s: string, esc: (x: string) => string) =>
    s.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (m, k: string) => (k in values ? esc(values[k]) : m));
  return {
    subject: f(src.subject, (x) => x),
    html: f(src.html, escapeHtml),
    text: f(src.text, (x) => x),
  };
}

/** The preview frame: a mail client in light or dark mode. Sandboxed: no script, no same-origin. */
function frameDoc(html: string, dark: boolean) {
  // A mail in the shared layout is a whole document with its own dark rules.
  if (/^<!doctype html>/i.test(html)) return previewDoc(html, dark);
  const bg = dark ? "oklch(0.2 0 0)" : "oklch(1 0 0)";
  const fg = dark ? "oklch(0.92 0 0)" : "oklch(0.2 0 0)";
  const link = dark ? "oklch(0.78 0.132 22.3)" : "oklch(0.45 0.198 22.3)";
  return `<!doctype html><html style="color-scheme:${dark ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:${bg};color:${fg}}a{color:${link}}</style></head><body>${html}</body></html>`;
}

export default function TemplatesEditor() {
  const c = useIntlayer("dev-templates");
  const [id, setId] = useState<MailTemplateId>("signin-code");
  const [locale, setLocale] = useState<MailLocale>("en");
  const [sample, setSample] = useState<SampleSet>("typical");
  const [dark, setDark] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<TemplateSource>({ subject: "", html: "", text: "" });
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [serverErrors, setServerErrors] = useState<TemplateError[]>([]);
  const [diffOf, setDiffOf] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const t = c as unknown as Record<string, { value: string }> & {
    errors: Record<string, { value: string }>;
    names: Record<string, { value: string }>;
    about: Record<string, { value: string }>;
  };
  const fieldName = (f: TemplateField) =>
    f === "subject" ? c.subject.value : f === "html" ? c.html.value : c.text.value;
  const errText = (e: TemplateError) =>
    fill(t.errors[ERR_KEY[e.code]]?.value ?? e.code, {
      field: fieldName(e.field),
      detail: e.detail ?? "",
    });
  const failText = useCallback((status: number) => fill(c.errOther.value, { status }), [c]);

  const sourceOf = (d: Detail, v: number): TemplateSource =>
    d.versions.find((x) => x.version === v) ?? d.builtin;

  // The latest template + language asked for: an older answer arriving late is dropped.
  const want = useRef("");
  const load = useCallback(
    async (keepDraft = false) => {
      const key = `${id}:${locale}`;
      want.current = key;
      const r = await fetch(`/api/dev/templates?id=${id}&locale=${encodeURIComponent(locale)}`, {
        cache: "no-store",
      });
      if (r.status === 404) return location.reload();
      if (!r.ok) return setMsg({ ok: false, text: failText(r.status) });
      const d = (await r.json()) as Detail;
      if (want.current !== key) return;
      setDetail(d);
      if (!keepDraft) {
        const s = sourceOf(d, d.active);
        setDraft({ subject: s.subject, html: s.html, text: s.text });
      }
    },
    [id, locale, failText],
  );

  useEffect(() => {
    setDetail(null);
    setMsg(null);
    setServerErrors([]);
    setDiffOf(null);
    void load();
  }, [load]);

  const def = MAIL_TEMPLATES[id];
  const values = useMemo(
    () => ({ ...def.samples[sample], ...mailBrand(locale) }),
    [def, sample, locale],
  );
  const errors = useMemo(() => validateSource(draft, def.vars), [draft, def]);
  const rendered = useMemo(() => {
    try {
      return renderWith(id, locale, draft, def.samples[sample]);
    } catch {
      return roughRender(draft, values);
    }
  }, [id, locale, draft, def, sample, values]);
  const live = detail ? sourceOf(detail, detail.active) : null;
  const dirty = live ? !same(live, draft) : false;

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    setServerErrors([]);
    try {
      const r = await fetch("/api/dev/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, locale, ...body }),
      });
      if (r.status === 404) {
        location.reload();
        return null;
      }
      const j = (await r.json().catch(() => ({}))) as {
        version?: number;
        error?: string;
        errors?: TemplateError[];
        retryAfterMs?: number;
      };
      if (j.errors?.length) setServerErrors(j.errors);
      if (r.status === 429)
        setMsg({
          ok: false,
          text: fill(c.testLimited.value, {
            minutes: Math.max(1, Math.ceil((j.retryAfterMs ?? 0) / 60_000)),
          }),
        });
      else if (!r.ok && !j.errors?.length) setMsg({ ok: false, text: failText(r.status) });
      return r.ok ? j : null;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const j = await post({ op: "save", ...draft, note });
    if (j?.version) {
      setNote("");
      setMsg({ ok: true, text: fill(c.saved.value, { version: j.version }) });
      await load(true);
    }
  };
  const activate = async (version: number) => {
    const j = await post({ op: "activate", version });
    if (j) await load();
  };
  const test = async () => {
    const j = await post({ op: "test", sample, ...draft });
    if (j) setMsg({ ok: true, text: c.testSent.value });
  };

  const shownErrors = serverErrors.length ? serverErrors : errors;
  const diffSource = detail && diffOf !== null ? sourceOf(detail, diffOf) : null;
  const vars = Object.entries(def.vars);

  return (
    <div className="space-y-4">
      <p className="text-sm opacity-80">{c.intro}</p>

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="space-y-1">
          <span className="block font-medium">{c.template}</span>
          <select
            data-testid="tpl-id"
            className="border rounded px-2 min-h-9 bg-transparent max-w-full"
            value={id}
            onChange={(e) => setId(e.target.value as MailTemplateId)}
          >
            {MAIL_TEMPLATE_IDS.map((x) => (
              <option key={x} value={x}>
                {t.names[camel(x)]?.value ?? x}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block font-medium">{c.language}</span>
          <select
            data-testid="tpl-locale"
            className="border rounded px-2 min-h-9 bg-transparent"
            value={locale}
            onChange={(e) => setLocale(e.target.value as MailLocale)}
          >
            {MAIL_LOCALES.map((l) => (
              <option key={l} value={l}>
                {l === "zh-Hant"
                  ? "繁體中文 (zh-Hant)"
                  : `${LOCALE_LABELS[l as keyof typeof LOCALE_LABELS] ?? l} (${l})`}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block font-medium">{c.sample}</span>
          <select
            data-testid="tpl-sample"
            className="border rounded px-2 min-h-9 bg-transparent"
            value={sample}
            onChange={(e) => setSample(e.target.value as SampleSet)}
          >
            {SAMPLE_SETS.map((s) => (
              <option key={s} value={s}>
                {s === "typical" ? c.sampleTypical : c.sampleLong}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="space-y-1">
          <legend className="font-medium">{c.theme}</legend>
          <div className="flex rounded border overflow-hidden">
            {[false, true].map((d) => (
              <button
                key={String(d)}
                type="button"
                data-testid={d ? "tpl-dark" : "tpl-light"}
                aria-pressed={dark === d}
                className={`min-h-9 px-3 ${dark === d ? "bg-[oklch(0.2_0_0)] text-[oklch(0.98_0_0)] dark:bg-[oklch(0.95_0_0)] dark:text-[oklch(0.15_0_0)]" : ""}`}
                onClick={() => setDark(d)}
              >
                {d ? c.dark : c.light}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      <p className="text-sm opacity-70">{t.about[camel(id)]?.value}</p>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Editor */}
        <section className="space-y-3 min-w-0">
          <div className="text-sm space-y-1">
            <div>
              <span className="font-medium">{c.locked}: </span>
              {lockedVars(id).length
                ? lockedVars(id).map((v) => (
                    <code
                      key={v}
                      className="mr-1 px-1 rounded bg-[oklch(0.93_0_0)] dark:bg-[oklch(0.3_0_0)]"
                    >{`{${v}}`}</code>
                  ))
                : "—"}
            </div>
            <div className="opacity-80">
              <span className="font-medium">{c.optional}: </span>
              {[...vars.filter(([, s]) => !s.required).map(([n]) => n), "brand", "brandLong"].map(
                (v) => (
                  <code key={v} className="mr-1">{`{${v}}`}</code>
                ),
              )}
            </div>
          </div>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{c.subject}</span>
            <input
              data-testid="tpl-subject"
              className={FIELD}
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{c.html}</span>
            <textarea
              data-testid="tpl-html"
              className={`${FIELD} h-64`}
              spellCheck={false}
              value={draft.html}
              onChange={(e) => setDraft({ ...draft, html: e.target.value })}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{c.text}</span>
            <textarea
              data-testid="tpl-text"
              className={`${FIELD} h-40`}
              spellCheck={false}
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
          </label>

          {shownErrors.length > 0 && (
            <div data-testid="tpl-errors" className={ERR}>
              <div className="font-medium">{c.fixFirst}</div>
              <ul className="list-disc pl-5">
                {shownErrors.map((e, i) => (
                  <li key={i}>{errText(e)}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <input
              className="min-w-0 flex-1 border rounded px-2 min-h-9 bg-transparent text-sm"
              placeholder={c.note.value}
              maxLength={200}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              data-testid="tpl-save"
              className={BTN}
              disabled={busy || errors.length > 0 || !dirty}
              onClick={() => void save()}
            >
              {c.save}
            </button>
            <button
              data-testid="tpl-test"
              className={BTN2}
              disabled={busy || errors.length > 0}
              onClick={() => void test()}
            >
              {c.sendTest}
            </button>
            {detail && (
              <button
                className={BTN2}
                disabled={busy || same(detail.builtin, draft)}
                onClick={() => setDraft({ ...detail.builtin })}
              >
                {c.fromBuiltin}
              </button>
            )}
            {dirty && <span className="text-xs opacity-70">{c.unsaved}</span>}
          </div>
          {msg && (
            <p data-testid="tpl-msg" role="status" className={msg.ok ? OK : ERR}>
              {msg.text}
            </p>
          )}
        </section>

        {/* Live preview */}
        <section className="space-y-2 min-w-0">
          <h2 className="font-semibold">{c.preview}</h2>
          <div className="rounded border overflow-hidden">
            <div
              data-testid="tpl-preview-subject"
              className="px-3 py-2 text-sm font-medium border-b break-words"
            >
              {rendered.subject}
            </div>
            <iframe
              data-testid="tpl-preview"
              title={c.preview.value}
              sandbox=""
              className="w-full h-[28rem] block"
              srcDoc={frameDoc(rendered.html, dark)}
            />
          </div>
          <h3 className="text-sm font-medium">{c.previewText}</h3>
          <pre
            data-testid="tpl-preview-text"
            className="text-xs whitespace-pre-wrap break-words rounded border p-2 max-h-64 overflow-auto"
          >
            {rendered.text}
          </pre>
        </section>
      </div>

      {/* Versions */}
      <section className="space-y-2">
        <h2 className="font-semibold">{c.versions}</h2>
        {detail && detail.versions.length === 0 && (
          <p className="text-sm opacity-70">{c.noVersions}</p>
        )}
        <ul
          data-testid="tpl-versions"
          className="divide-y divide-[oklch(0.88_0_0)] dark:divide-[oklch(0.35_0_0)] text-sm"
        >
          {detail &&
            [
              ...detail.versions,
              { version: 0, note: null, createdAt: 0, schema: def.schema, ...detail.builtin },
            ].map((v) => (
              <li
                key={v.version}
                data-testid={`tpl-version-${v.version}`}
                className="py-2 flex flex-wrap items-center gap-2"
              >
                <span className="font-medium">{v.version === 0 ? c.builtin : `v${v.version}`}</span>
                {v.createdAt > 0 && <span className="opacity-70">{fmt(v.createdAt)}</span>}
                {v.note && <span className="opacity-80 break-words">“{v.note}”</span>}
                {detail.active === v.version && (
                  <span className="px-1.5 rounded text-xs bg-[oklch(0.9_0.08_150)] text-[oklch(0.3_0.08_150)] dark:bg-[oklch(0.35_0.08_150)] dark:text-[oklch(0.95_0.03_150)]">
                    {c.active}
                  </span>
                )}
                <span className="ml-auto flex flex-wrap gap-2">
                  <button
                    className={BTN2}
                    onClick={() => setDiffOf(diffOf === v.version ? null : v.version)}
                  >
                    {c.diff}
                  </button>
                  <button
                    className={BTN2}
                    onClick={() => setDraft({ subject: v.subject, html: v.html, text: v.text })}
                  >
                    {c.edit}
                  </button>
                  {detail.active !== v.version && (
                    <button
                      data-testid={`tpl-activate-${v.version}`}
                      className={BTN2}
                      disabled={busy || (v.version > 0 && v.schema !== def.schema)}
                      onClick={() => void activate(v.version)}
                    >
                      {v.version === 0 ? c.useBuiltin : c.activate}
                    </button>
                  )}
                </span>
              </li>
            ))}
        </ul>
        {diffSource && diffOf !== null && (
          <div data-testid="tpl-diff" className="rounded border p-2 space-y-2">
            <div className="flex items-center">
              <span className="font-medium text-sm">
                {fill(c.diffTitle.value, { version: diffOf === 0 ? c.builtin.value : diffOf })}
              </span>
              <button className={`${BTN2} ml-auto`} onClick={() => setDiffOf(null)}>
                {c.close}
              </button>
            </div>
            {(["subject", "html", "text"] as const).map((f) => {
              const lines = lineDiff(
                f === "html" ? htmlLines(diffSource[f]) : diffSource[f],
                f === "html" ? htmlLines(draft[f]) : draft[f],
              );
              if (lines.every((l) => l.op === "=")) return null;
              return (
                <div key={f}>
                  <div className="text-xs font-medium">{fieldName(f)}</div>
                  <pre className="text-xs whitespace-pre-wrap break-all">
                    {lines.map((l, i) => (
                      <div
                        key={i}
                        className={
                          l.op === "+"
                            ? "bg-[oklch(0.93_0.06_150)] dark:bg-[oklch(0.32_0.07_150)]"
                            : l.op === "-"
                              ? "bg-[oklch(0.93_0.05_27)] dark:bg-[oklch(0.32_0.07_27)]"
                              : "opacity-60"
                        }
                      >
                        {l.op === "=" ? " " : l.op} {l.line}
                      </div>
                    ))}
                  </pre>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

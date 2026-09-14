"use client";

import { useEffect, useMemo, useState } from "react";
import { useIntlayer } from "next-intlayer";
import {
  IMMERSION_DOMAINS,
  IMMERSION_LANGUAGES,
  type ImmersionDomain,
  type ImmersionLanguage,
  type ImmersionSite,
  type Register,
  orderImmersionLanguages,
} from "@/lib/immersion-sites";

const LANGS_KEY = "lk:lab:immersion:langs";
const TRANSPOSE_KEY = "lk:lab:immersion:transpose";
const ALL_LANGS = IMMERSION_LANGUAGES.map((l) => l.code);

function readSavedLangs(): ImmersionLanguage[] | null {
  try {
    const raw = localStorage.getItem(LANGS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const known = parsed.filter((c): c is ImmersionLanguage =>
      (ALL_LANGS as string[]).includes(c as string),
    );
    return known.length ? known : null;
  } catch {
    return null;
  }
}

function SiteLink({ site, muted = false }: { site: ImmersionSite; muted?: boolean }) {
  const host = new URL(site.url).hostname.replace(/^www\./, "");
  return (
    <a
      href={site.url}
      target="_blank"
      rel="noopener noreferrer"
      title={site.note ? `${host} — ${site.note}` : host}
      className={
        muted
          ? "text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:underline"
          : "font-medium text-blue-700 dark:text-blue-300 hover:underline"
      }
    >
      {site.name}
    </a>
  );
}

const STICKY_HEAD =
  "sticky start-0 z-10 bg-gray-50 dark:bg-gray-900 text-start px-4 py-3 font-semibold";
const STICKY_ROW = "sticky start-0 z-10 bg-white dark:bg-gray-950 text-start px-4 py-3 font-normal";

function LangHeader({
  lang,
  focused,
}: {
  lang: (typeof IMMERSION_LANGUAGES)[number];
  focused: boolean;
}) {
  return (
    <>
      {focused && (
        <span aria-hidden className="me-1 text-blue-600 dark:text-blue-400">
          ★
        </span>
      )}
      <span lang={lang.code}>{lang.native}</span>
      <span className="ms-1.5 text-xs font-normal text-gray-400">{lang.code.toUpperCase()}</span>
    </>
  );
}

/** Tint for the browser's first-choice language, so its column/row reads first. */
const FOCUS_CELL = "bg-blue-50/60 dark:bg-blue-950/30";

function TopicHeader({
  domain,
  registerLabel,
}: {
  domain: ImmersionDomain;
  registerLabel: (r: Register) => React.ReactNode;
}) {
  return (
    <>
      <div className="font-semibold">{domain.title}</div>
      <div className="text-xs font-normal text-gray-500 dark:text-gray-400 mt-0.5">
        {domain.blurb}
      </div>
      <div className="flex flex-wrap gap-1 mt-1.5">
        {domain.registers.map((r) => (
          <span
            key={r}
            className="rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-gray-600 dark:text-gray-300"
          >
            {registerLabel(r)}
          </span>
        ))}
      </div>
    </>
  );
}

function SiteCell({
  domain,
  code,
  focused,
}: {
  domain: ImmersionDomain;
  code: ImmersionLanguage;
  focused: boolean;
}) {
  const { primary, alt } = domain.sites[code];
  return (
    <td className={`px-4 py-3 ${focused ? FOCUS_CELL : ""}`} lang={code}>
      <div>
        <SiteLink site={primary} />
      </div>
      {alt && (
        <div className="mt-0.5">
          <SiteLink site={alt} muted />
        </div>
      )}
    </td>
  );
}

export default function ImmersionClient({ preferred }: { preferred: ImmersionLanguage[] }) {
  const t = useIntlayer("lab-immersion-page");
  // Browser-preferred languages lead the chips and the columns; the first of
  // them is the highlighted one. A saved choice (below) overrides which are
  // shown, never the order.
  const ordered = orderImmersionLanguages(preferred);
  const focus = preferred[0] ?? null;
  const [langs, setLangs] = useState<ImmersionLanguage[]>(preferred.length ? preferred : ALL_LANGS);
  const [query, setQuery] = useState("");
  // false: topics down, languages across (the original table). true: swapped —
  // handy when you learn one language and want its whole column as a row.
  const [transposed, setTransposed] = useState(false);

  // Restore the column choice after mount — reading localStorage during render
  // would desync SSR and hydration.
  useEffect(() => {
    const saved = readSavedLangs();
    if (saved) setLangs(saved);
    try {
      setTransposed(localStorage.getItem(TRANSPOSE_KEY) === "1");
    } catch {}
  }, []);

  function toggleTransposed() {
    setTransposed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(TRANSPOSE_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }

  function toggleLang(code: ImmersionLanguage) {
    setLangs((prev) => {
      // Keep column order stable regardless of click order.
      const next = prev.includes(code)
        ? prev.filter((c) => c !== code)
        : ordered.map((l) => l.code).filter((c) => c === code || prev.includes(c));
      try {
        localStorage.setItem(LANGS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  const columns = ordered.filter((l) => langs.includes(l.code));

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return IMMERSION_DOMAINS;
    return IMMERSION_DOMAINS.filter((d) => {
      if (d.title.toLowerCase().includes(q) || d.blurb.toLowerCase().includes(q)) return true;
      if (d.registers.some((r) => r.includes(q))) return true;
      return columns.some(({ code }) => {
        const { primary, alt } = d.sites[code];
        return [primary, alt].some(
          (site) => site && (site.name.toLowerCase().includes(q) || site.url.includes(q)),
        );
      });
    });
  }, [query, columns]);

  const registerLabel = (r: Register) => t.registers[r];

  return (
    <main className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-2">🗺 {t.heading}</h1>
      <p className="text-gray-600 dark:text-gray-400 max-w-3xl mb-6">{t.intro}</p>

      {/* Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">{t.languages}</legend>
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 me-1">
            {t.languages}
          </span>
          {ordered.map((l) => {
            const on = langs.includes(l.code);
            return (
              <button
                key={l.code}
                type="button"
                aria-pressed={on}
                onClick={() => toggleLang(l.code)}
                className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                  on
                    ? "border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500"
                    : "border-gray-300 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500"
                }`}
              >
                {l.code === focus && (
                  <span aria-hidden className="me-1">
                    ★
                  </span>
                )}
                <span lang={l.code}>{l.native}</span>
                <span className="ms-1 text-xs opacity-70">{l.code.toUpperCase()}</span>
              </button>
            );
          })}
        </fieldset>
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.filterPlaceholder.value}
            aria-label={t.filterPlaceholder.value}
            className="w-full sm:w-64 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={toggleTransposed}
            aria-pressed={transposed}
            title={t.transpose.value}
            className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              transposed
                ? "border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500"
                : "border-gray-300 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500"
            }`}
          >
            <span aria-hidden className="me-1.5">
              ⇄
            </span>
            {t.transpose}
          </button>
        </div>
      </div>

      {/* Matrix */}
      {columns.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 py-8 text-center">{t.noLanguages}</p>
      ) : rows.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 py-8 text-center">{t.noMatch}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm border-collapse">
            {transposed ? (
              <>
                <thead className="bg-gray-50 dark:bg-gray-900/60">
                  <tr>
                    <th scope="col" className={`${STICKY_HEAD} min-w-36`}>
                      {t.languages}
                    </th>
                    {rows.map((d) => (
                      <th
                        key={d.key}
                        scope="col"
                        className="text-start px-4 py-3 align-top min-w-44 font-semibold"
                      >
                        <TopicHeader domain={d} registerLabel={registerLabel} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {columns.map((l) => (
                    <tr
                      key={l.code}
                      className="border-t border-gray-200 dark:border-gray-800 align-top hover:bg-gray-50/60 dark:hover:bg-gray-900/40"
                    >
                      <th
                        scope="row"
                        className={`${STICKY_ROW} font-semibold whitespace-nowrap ${l.code === focus ? FOCUS_CELL : ""}`}
                      >
                        <LangHeader lang={l} focused={l.code === focus} />
                      </th>
                      {rows.map((d) => (
                        <SiteCell key={d.key} domain={d} code={l.code} focused={l.code === focus} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </>
            ) : (
              <>
                <thead className="bg-gray-50 dark:bg-gray-900/60">
                  <tr>
                    <th scope="col" className={`${STICKY_HEAD} min-w-48`}>
                      {t.topic}
                    </th>
                    {columns.map((l) => (
                      <th
                        key={l.code}
                        scope="col"
                        className={`text-start px-4 py-3 font-semibold min-w-36 whitespace-nowrap ${l.code === focus ? FOCUS_CELL : ""}`}
                      >
                        <LangHeader lang={l} focused={l.code === focus} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr
                      key={d.key}
                      className="border-t border-gray-200 dark:border-gray-800 align-top hover:bg-gray-50/60 dark:hover:bg-gray-900/40"
                    >
                      <th scope="row" className={STICKY_ROW}>
                        <TopicHeader domain={d} registerLabel={registerLabel} />
                      </th>
                      {columns.map((l) => (
                        <SiteCell
                          key={l.code}
                          domain={d}
                          code={l.code}
                          focused={l.code === focus}
                        />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </>
            )}
          </table>
        </div>
      )}

      {/* How it fits */}
      <section className="mt-10 max-w-3xl">
        <h2 className="text-lg font-semibold mb-3">{t.howTo.title}</h2>
        <ol className="list-decimal ps-5 space-y-2 text-sm text-gray-700 dark:text-gray-300">
          <li>
            <a href="/lianki.user.js" className="text-blue-600 dark:text-blue-400 hover:underline">
              {t.howTo.steps.install}
            </a>
            {t.howTo.steps.installTail}
          </li>
          <li>{t.howTo.steps.clip}</li>
          <li>{t.howTo.steps.review}</li>
        </ol>
      </section>
    </main>
  );
}

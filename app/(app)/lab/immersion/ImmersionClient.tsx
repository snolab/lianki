"use client";

import { useEffect, useMemo, useState } from "react";
import { useIntlayer } from "next-intlayer";
import {
  IMMERSION_DOMAINS,
  IMMERSION_LANGUAGES,
  type ImmersionLanguage,
  type ImmersionSite,
  type Register,
} from "@/lib/immersion-sites";

const LANGS_KEY = "lk:lab:immersion:langs";
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

export default function ImmersionClient() {
  const t = useIntlayer("lab-immersion-page");
  const [langs, setLangs] = useState<ImmersionLanguage[]>(ALL_LANGS);
  const [query, setQuery] = useState("");

  // Restore the column choice after mount — reading localStorage during render
  // would desync SSR and hydration.
  useEffect(() => {
    const saved = readSavedLangs();
    if (saved) setLangs(saved);
  }, []);

  function toggleLang(code: ImmersionLanguage) {
    setLangs((prev) => {
      // Keep column order stable regardless of click order.
      const next = prev.includes(code)
        ? prev.filter((c) => c !== code)
        : ALL_LANGS.filter((c) => c === code || prev.includes(c));
      try {
        localStorage.setItem(LANGS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  const columns = IMMERSION_LANGUAGES.filter((l) => langs.includes(l.code));

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
          {IMMERSION_LANGUAGES.map((l) => {
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
                <span lang={l.code}>{l.native}</span>
                <span className="ms-1 text-xs opacity-70">{l.code.toUpperCase()}</span>
              </button>
            );
          })}
        </fieldset>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.filterPlaceholder.value}
          aria-label={t.filterPlaceholder.value}
          className="w-full sm:w-64 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm"
        />
      </div>

      {/* Matrix */}
      {columns.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 py-8 text-center">{t.noLanguages}</p>
      ) : rows.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 py-8 text-center">{t.noMatch}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-gray-50 dark:bg-gray-900/60 text-start">
              <tr>
                <th
                  scope="col"
                  className="sticky start-0 z-10 bg-gray-50 dark:bg-gray-900 text-start px-4 py-3 font-semibold min-w-48"
                >
                  {t.topic}
                </th>
                {columns.map((l) => (
                  <th
                    key={l.code}
                    scope="col"
                    className="text-start px-4 py-3 font-semibold min-w-36 whitespace-nowrap"
                  >
                    <span lang={l.code}>{l.native}</span>
                    <span className="ms-1.5 text-xs font-normal text-gray-400">
                      {l.code.toUpperCase()}
                    </span>
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
                  <th
                    scope="row"
                    className="sticky start-0 z-10 bg-white dark:bg-gray-950 text-start px-4 py-3 font-normal"
                  >
                    <div className="font-semibold">{d.title}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{d.blurb}</div>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {d.registers.map((r) => (
                        <span
                          key={r}
                          className="rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-600 dark:text-gray-300"
                        >
                          {registerLabel(r)}
                        </span>
                      ))}
                    </div>
                  </th>
                  {columns.map((l) => {
                    const { primary, alt } = d.sites[l.code];
                    return (
                      <td key={l.code} className="px-4 py-3" lang={l.code}>
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
                  })}
                </tr>
              ))}
            </tbody>
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

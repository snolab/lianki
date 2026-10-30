"use client";

import { useEffect, useMemo, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import {
  ANKIWEB_CHECKED,
  ANKIWEB_DECKS,
  ankiWebInfoUrl,
  ankiWebSearchUrl,
  searchDecks,
  type AnkiWebDeck,
} from "@/lib/words/ankiweb";
import { longDate } from "@/lib/dates";

const text = (s: unknown): string =>
  typeof s === "string" ? s : String((s as { value?: unknown } | null)?.value ?? s);

/** Curated languages, in the order they first appear in the list. */
const LANGS = [...new Set(ANKIWEB_DECKS.map((d) => d.lang))];

/**
 * The hand-picked AnkiWeb decks (lib/words/ankiweb-decks.json) and a box that
 * opens AnkiWeb's own search. Everything here is a link out: Lianki never
 * fetches AnkiWeb. `studyLang` (the language of the user's lists, if any)
 * preselects a language chip and the AnkiWeb query.
 */
export default function AnkiWebDecks({
  studyLang,
  picked,
  onPick,
}: {
  studyLang?: string;
  picked?: AnkiWebDeck;
  onPick: (deck: AnkiWebDeck) => void;
}) {
  const t = useIntlayer("words-import-ankiweb");
  const { locale } = useLocale();
  const [q, setQ] = useState("");
  const [lang, setLang] = useState<string>("");
  const [webQ, setWebQ] = useState("");
  const [webEdited, setWebEdited] = useState(false);

  const names = useMemo(() => {
    const make = (loc: string) => {
      try {
        const dn = new Intl.DisplayNames([loc], { type: "language" });
        return (c: string) => dn.of(c) ?? c;
      } catch {
        return (c: string) => c;
      }
    };
    return { local: make(locale), en: make("en") };
  }, [locale]);

  // The study language, once the user's lists are known.
  useEffect(() => {
    if (studyLang && LANGS.includes(studyLang)) setLang((l) => l || studyLang);
  }, [studyLang]);
  // AnkiWeb lists decks in English: prefill its search with the language's English name.
  useEffect(() => {
    if (!webEdited) setWebQ(lang ? names.en(lang) : "");
  }, [lang, names, webEdited]);

  const shown = useMemo(
    () =>
      searchDecks(q, lang ? ANKIWEB_DECKS.filter((d) => d.lang === lang) : ANKIWEB_DECKS, (c) => [
        names.local(c),
        names.en(c),
      ]),
    [q, lang, names],
  );

  const badge = (d: AnkiWebDeck) =>
    d.licence === "personal"
      ? text(t.personalUse)
      : d.licence === "open"
        ? text(t.openLicence)
        : d.licence;
  const chip = (on: boolean) =>
    `min-h-10 px-3 rounded-full text-sm border transition-colors ${
      on
        ? "bg-[oklch(0.6_0.15_160/0.2)] border-[oklch(0.6_0.15_160/0.6)]"
        : "border-[oklch(0.5_0_0/0.25)] hover:bg-[oklch(0.5_0_0/0.08)]"
    }`;
  const field =
    "rounded bg-[oklch(0.5_0_0/0.1)] px-2 py-1.5 text-sm min-w-0 flex-1 focus:outline focus:outline-2 focus:outline-[oklch(0.65_0.15_160)]";

  return (
    <section
      id="ankiweb-decks"
      aria-labelledby="ankiweb-decks-h"
      data-testid="ankiweb-decks"
      className="rounded-lg bg-[oklch(0.5_0_0/0.06)] p-4 space-y-3"
    >
      <div>
        <h2 id="ankiweb-decks-h" className="text-lg font-semibold">
          {t.heading}
        </h2>
        <p className="text-sm opacity-70 mt-1">{t.intro}</p>
      </div>

      <div className="flex flex-wrap gap-2" role="group">
        <button
          type="button"
          className={chip(!lang)}
          aria-pressed={!lang}
          onClick={() => setLang("")}
        >
          {t.allLangs}
        </button>
        {LANGS.map((l) => (
          <button
            key={l}
            type="button"
            className={chip(lang === l)}
            aria-pressed={lang === l}
            onClick={() => setLang(l)}
          >
            {names.local(l)}
          </button>
        ))}
      </div>

      <label className="flex items-center gap-2">
        <span className="sr-only">{t.filter}</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`${text(t.filter)} — ${text(t.filterHint)}`}
          className={field}
          data-testid="ankiweb-filter"
        />
      </label>

      {shown.length ? (
        <ul className="divide-y divide-[oklch(0.5_0_0/0.15)]" data-testid="ankiweb-list">
          {shown.map((d) => (
            <li key={d.id} className="py-2.5 flex flex-wrap items-start gap-x-3 gap-y-1">
              <div className="min-w-0 flex-1 basis-60">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{d.title}</span>
                  <span className="text-xs opacity-60">
                    {names.local(d.lang)} · {d.level}
                  </span>
                </div>
                <p className="text-sm opacity-80">{d.description}</p>
                <span
                  className={`inline-block mt-1 text-xs rounded px-1.5 py-0.5 ${
                    d.licence === "personal"
                      ? "bg-[oklch(0.75_0.12_80/0.2)]"
                      : "bg-[oklch(0.65_0.15_160/0.2)]"
                  }`}
                  title={d.licenceNote}
                >
                  {badge(d)}
                </span>
              </div>
              <a
                href={ankiWebInfoUrl(d.id)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onPick(d)}
                className="min-h-10 inline-flex items-center px-3 rounded text-sm bg-[oklch(0.5_0_0/0.1)] hover:bg-[oklch(0.5_0_0/0.18)]"
                data-testid="ankiweb-open"
              >
                {t.openDeck} ↗
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm opacity-70">{t.noMatch}</p>
      )}

      {picked && (
        <p role="status" className="text-sm rounded bg-[oklch(0.65_0.15_160/0.15)] px-3 py-2">
          {text(t.opened).replace("{title}", picked.title)}
        </p>
      )}

      <p className="text-xs opacity-60">
        {t.privateNote}{" "}
        {text(t.checked).replace("{date}", longDate(`${ANKIWEB_CHECKED}T12:00:00Z`, locale))}
      </p>

      <form
        className="space-y-1 pt-2 border-t border-[oklch(0.5_0_0/0.15)]"
        onSubmit={(e) => {
          e.preventDefault();
          // Opened in the user's browser only; never fetched.
          window.open(ankiWebSearchUrl(webQ), "_blank", "noopener,noreferrer");
        }}
      >
        <label htmlFor="ankiweb-search" className="block text-sm font-medium">
          {t.searchMore}
        </label>
        <div className="flex gap-2">
          <input
            id="ankiweb-search"
            type="search"
            enterKeyHint="search"
            value={webQ}
            onChange={(e) => {
              setWebQ(e.target.value);
              setWebEdited(true);
            }}
            placeholder={text(t.searchPlaceholder)}
            className={field}
            data-testid="ankiweb-search"
          />
          <button
            type="submit"
            className="min-h-10 px-4 rounded text-sm bg-[oklch(0.5_0_0/0.12)] hover:bg-[oklch(0.5_0_0/0.2)]"
          >
            {t.searchButton} ↗
          </button>
        </div>
        <p className="text-xs opacity-60">{t.searchNote}</p>
      </form>
    </section>
  );
}

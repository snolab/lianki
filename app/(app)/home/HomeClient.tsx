"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { APP_NAV } from "@/lib/app-nav";
import { Icon } from "@/app/components/icons";
import { loadCatalog } from "@/lib/words/catalog-cache";

/** Learning features shown as entries below the word lists. */
const EXPLORE = ["alphabet", "learn", "aiVocab", "polyglot", "selfIntro", "read", "roadmap"];
/** The page-card features, behind "Advanced". */
const ADVANCED = ["sites", "review", "cards"];

/**
 * Home: navigation and onboarding. Word lists come first — what is due and a
 * Continue, or three steps to start; then the other learning features; the
 * page-card features (sites, page review, the card list and its userscript)
 * last, under Advanced.
 */
export default function HomeClient({ isLoggedIn }: { isLoggedIn: boolean }) {
  const t = useIntlayer("nav-home");
  // Nav labels live in two dictionaries, as in the app shell: landing-page
  // has learn / aiVocab / polyglot / roadmap, app-shell the rest.
  const landingNav = useIntlayer("landing-page").nav as unknown as Record<
    string,
    { value: string }
  >;
  const shellNav = useIntlayer("app-shell").nav as unknown as Record<string, { value: string }>;
  const nav = { ...landingNav, ...shellNav };
  const [words, setWords] = useState<{ lists: number; due: number } | null>(null);

  useEffect(() => {
    if (!isLoggedIn) return;
    // Count what /words shows and "Continue" studies: lists from the
    // vocabulary catalog plus Anki imports. word_lists also holds /alphabet's
    // lists, which made this read 41 due while /words said 16.
    Promise.all([
      fetch("/api/words/lists").then((r) => (r.ok ? r.json() : null)),
      loadCatalog<{ lists?: { id: string }[] }>("/words/index.json").catch(() => null),
    ])
      .then(
        ([d, catalog]: [
          { lists?: { due?: number; source?: string }[] } | null,
          { lists?: { id: string }[] } | null,
        ]) => {
          const ids = new Set((catalog?.lists ?? []).map((c) => c.id));
          // No catalog (offline, first visit): fall back to every non-group list.
          const lists = (d?.lists ?? []).filter((l) =>
            catalog
              ? !!l.source && (ids.has(l.source) || l.source.startsWith("anki:"))
              : !l.source?.startsWith("group:"),
          );
          setWords({ lists: lists.length, due: lists.reduce((s, l) => s + (l.due ?? 0), 0) });
        },
      )
      .catch(() => setWords({ lists: 0, due: 0 }));
  }, [isLoggedIn]);

  const item = (key: string) => APP_NAV.find((n) => n.key === key)!;
  const label = (key: string) => nav[key]?.value ?? key;
  const started = !!words && words.lists > 0;

  return (
    <main className="max-w-3xl mx-auto px-4 py-8 space-y-8">
      <h1 className="font-brush text-4xl">{t.title}</h1>

      {/* Word lists: the main path. */}
      <section className="rounded-2xl border border-black/10 dark:border-white/10 p-5 sm:p-6 space-y-4">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Icon name="textAa" />
          {t.wordsTitle}
        </h2>
        {started ? (
          <div className="flex flex-wrap items-center gap-4">
            <p className="text-lg tabular-nums">
              <span className="text-3xl font-semibold">{words!.due}</span> {t.due}
              <span className="ms-3 text-sm opacity-60">
                {words!.lists} {t.lists}
              </span>
            </p>
            <Link
              href={words!.lists > 1 ? "/words?list=all" : "/words"}
              className="ms-auto rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold px-5 py-2.5"
            >
              {t.cont} →
            </Link>
          </div>
        ) : (
          <div className="space-y-4" data-onboarding>
            <h3 className="font-medium opacity-80">{t.startTitle}</h3>
            <ol className="space-y-2 list-decimal ps-5 text-[15px]">
              <li>{t.step1}</li>
              <li>{t.step2}</li>
              <li>{t.step3}</li>
            </ol>
            <Link
              href="/words"
              className="inline-block rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold px-5 py-2.5"
            >
              {t.startButton} →
            </Link>
          </div>
        )}
      </section>

      {/* Other learning features. */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide opacity-60">{t.explore}</h2>
        <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {EXPLORE.map((k) => (
            <li key={k}>
              <Link
                href={item(k).href}
                className="flex items-center gap-2 rounded-xl border border-black/10 dark:border-white/10 px-4 py-3 hover:bg-black/5 dark:hover:bg-white/5"
              >
                <Icon name={item(k).icon} className="text-lg opacity-80" />
                <span className="font-medium">{label(k)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* Page cards: the advanced path. */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide opacity-60">{t.advanced}</h2>
        <p className="text-sm opacity-70">{t.advancedHint}</p>
        <ul className="flex flex-wrap gap-2">
          {ADVANCED.map((k) => (
            <li key={k}>
              <Link
                href={item(k).href}
                className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 dark:border-white/10 px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
              >
                <Icon name={item(k).icon} className="opacity-80" />
                {label(k)}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

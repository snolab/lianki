"use client";
import { useSignedIn } from "@/app/components/BoxApiBridge";

import { dueNow, shownLists } from "@/lib/today/goal";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { APP_NAV } from "@/lib/app-nav";
import { Icon } from "@/app/components/icons";
import { loadCatalog } from "@/lib/words/catalog-cache";
import { HOME_EXPLORE, HOME_EXPLORE_HREF } from "@/lib/home-features";
import { FeatureCard } from "./FeatureCard";

/**
 * Home: navigation. A new learner sees only the title and Explore, every
 * feature to try for themselves; once they study word lists, what is due and
 * a Continue sit above Explore. The LiCards (链卡) page-card features close the
 * Explore grid.
 */
export default function HomeClient({
  isLoggedIn: serverSignedIn,
  todayGoal = false,
}: {
  isLoggedIn: boolean;
  /** `today.goal`: a link to /today beside Continue. */
  todayGoal?: boolean;
}) {
  // On a box, from lianki.com (BoxApiBridge); else the server's answer.
  const isLoggedIn = useSignedIn(serverSignedIn);
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
          // No catalog (offline, first visit): every non-group list (lib/today/goal.ts).
          const ids = catalog ? new Set((catalog.lists ?? []).map((c) => c.id)) : null;
          const lists = shownLists(d?.lists ?? [], ids);
          setWords({ lists: lists.length, due: dueNow(lists) });
        },
      )
      .catch(() => setWords({ lists: 0, due: 0 }));
  }, [isLoggedIn]);

  const item = (key: string) => APP_NAV.find((n) => n.key === key)!;
  const label = (key: string) => nav[key]?.value ?? key;
  const started = words !== null && words.lists > 0;

  return (
    <main className="max-w-3xl mx-auto px-4 py-8 space-y-8">
      <h1 className="font-brush text-4xl">{t.title}</h1>

      {/* What they already use, once there is some: word lists, due and Continue. */}
      {started && (
        <section className="rounded-2xl border border-black/10 dark:border-white/10 p-5 sm:p-6 space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Icon name="textAa" />
            {t.wordsTitle}
          </h2>
          <div className="flex flex-wrap items-center gap-4">
            <p className="text-lg tabular-nums">
              <span className="text-3xl font-semibold">{words.due}</span> {t.due}
              <span className="ms-3 text-sm opacity-60">
                {words.lists} {t.lists}
              </span>
            </p>
            {todayGoal && (
              <Link
                href="/today"
                data-home-today
                className="ms-auto inline-flex items-center gap-1.5 rounded-lg border border-current/30 px-4 py-2.5 font-semibold"
              >
                <Icon name="sparkle" />
                {label("today")}
              </Link>
            )}
            <Link
              href={words.lists > 1 ? "/words?list=all" : "/words"}
              className={`${todayGoal ? "" : "ms-auto "}rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold px-5 py-2.5`}
            >
              {t.cont} →
            </Link>
          </div>
        </section>
      )}

      {/* Every feature, to explore. */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide opacity-60">{t.explore}</h2>
        <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {HOME_EXPLORE.map((k) => (
            <li key={k}>
              <FeatureCard
                featureKey={k}
                href={HOME_EXPLORE_HREF[k] ?? item(k).href}
                icon={item(k).icon}
                label={k === "words" ? t.wordsTitle.value : label(k)}
                desc={t.cards[k].value}
              />
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

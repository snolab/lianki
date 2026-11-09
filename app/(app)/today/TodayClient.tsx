"use client";
/**
 * /today: today's goal, full screen. One number (the cards left today), a
 * progress bar, and Start (to /words). Light: gold ground, seal-red ink; dark:
 * seal-red ground, gold ink (owner, 2026-11-10). The counts are /words's own
 * (lib/today/goal.ts).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { loadCatalog } from "@/lib/words/catalog-cache";
import {
  doneIn,
  dueNow,
  goal,
  localMidnight,
  shownLists,
  type Goal,
  type GoalList,
} from "@/lib/today/goal";

export default function TodayClient() {
  const text = useIntlayer("today-page");
  const { locale } = useLocale();
  const router = useRouter();
  const [g, setG] = useState<Goal | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch("/api/words/lists").then((r) => (r.ok ? r.json() : null)),
      loadCatalog<{ lists?: { id: string }[] }>("/words/index.json").catch(() => null),
      fetch(`/api/words/today?since=${encodeURIComponent(localMidnight())}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(
        ([d, catalog, today]: [
          { lists?: GoalList[] } | null,
          { lists?: { id: string }[] } | null,
          { done?: Record<string, number> } | null,
        ]) => {
          const ids = catalog?.lists ? new Set(catalog.lists.map((c) => c.id)) : null;
          const lists = shownLists(d?.lists ?? [], ids);
          if (live) setG(goal(dueNow(lists), doneIn(lists, today?.done ?? {})));
        },
      )
      .catch(() => live && setG(goal(0, 0)));
    return () => {
      live = false;
    };
  }, []);

  const pct = g ? Math.round(g.share * 100) : 0;
  const plural = new Intl.PluralRules(locale).select(g?.left ?? 0);
  const left = g
    ? g.left === 0
      ? text.allDone.value
      : (plural === "one" ? text.leftOne.value : text.leftOther.value).replace(
          "{count}",
          g.left.toLocaleString(locale),
        )
    : " ";

  return (
    <main className="lk-today fixed inset-0 z-40 flex flex-col justify-center gap-7 overflow-y-auto px-7 pb-10 pt-16">
      <button
        type="button"
        aria-label={text.close.value}
        data-today-close
        onClick={() => (history.length > 1 ? router.back() : router.push("/home"))}
        className="lk-today-x absolute end-2 top-[max(0.5rem,env(safe-area-inset-top))] inline-flex size-11 items-center justify-center rounded-full text-xl"
      >
        ✕
      </button>
      <div className="lk-today-seal" aria-hidden>
        鏈
      </div>
      <h1 className="font-brush text-5xl tracking-wider">{text.title}</h1>
      <p className="text-2xl tabular-nums" data-today-left={g?.left ?? ""} aria-live="polite">
        {left}
      </p>
      <div
        className="lk-today-bar"
        role="progressbar"
        aria-label={text.progress.value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        data-today-progress={g ? pct : ""}
      >
        <i style={{ width: `${pct}%` }} />
      </div>
      <Link href="/words" data-today-start className="lk-today-go">
        {text.start}
      </Link>
      <style>{CSS}</style>
    </main>
  );
}

// Seal and gold, AA both ways (4.95:1 measured). Light: gold ground, red ink;
// dark: red ground, gold ink.
const CSS = `
.lk-today {
  --t-seal: oklch(0.49 0.2 22.3);
  --t-gold: oklch(0.89 0.12 86);
  --t-bg: var(--t-gold);
  --t-ink: var(--t-seal);
  background: var(--t-bg);
  color: var(--t-ink);
  font-family: var(--font-sans);
}
@media (prefers-color-scheme: dark) {
  .lk-today { --t-bg: var(--t-seal); --t-ink: var(--t-gold); }
}
.lk-today-seal {
  width: 56px; height: 56px; border-radius: 10px; display: grid; place-items: center;
  font-size: 30px; font-weight: 800; border: 3px solid currentColor; transform: rotate(-6deg);
}
.lk-today-bar { height: 10px; border-radius: 999px; overflow: hidden;
  background: color-mix(in oklch, currentColor 25%, transparent); }
.lk-today-bar > i { display: block; height: 100%; background: currentColor; border-radius: inherit;
  transition: width 0.6s ease-out; }
.lk-today-go { display: block; text-align: center; font-size: 20px; font-weight: 700; padding: 16px;
  border-radius: 16px; background: var(--t-ink); color: var(--t-bg); }
.lk-today-go:focus-visible, .lk-today-x:focus-visible { outline: 3px solid currentColor; outline-offset: 3px; }
.lk-today-go:focus-visible { outline-color: var(--t-ink); }
`;

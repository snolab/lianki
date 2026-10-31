"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { createUiStore, useUi } from "@lianki/ui-state";
import { useInputModality } from "@/lib/use-input-modality";
import {
  api,
  bookmarkletSource,
  cardFromDue,
  cardFromGet,
  detectPlatform,
  gradeKey,
  installGuideHref,
  keyAction,
  optionsFrom,
  RATINGS,
  type GradeOption,
  type Platform,
  type Rating,
  type ReviewCard,
} from "@/lib/review-ui";

/**
 * /review: one due page card at a time, graded inside the site.
 *
 * For people without the userscript. The card's page is opened by a real tap
 * on a link (target=_blank), which iOS Safari never blocks — unlike the bare
 * flow's script-run window.open. After reading, the user comes back to this
 * tab and grades; the next card loads in place. Every call is an existing
 * endpoint, unchanged (lib/review-ui.ts `api`), so the old HTML flow and the
 * userscript see exactly the same data.
 */

/** The tutorial: folded or not, and a platform picked by hand ("" = detect). A device preference. */
const tutorialStore = createUiStore(
  "review-tutorial",
  1,
  { collapsed: false, platform: "" },
  { storage: "local" },
);

type Phase =
  | { s: "loading" }
  | { s: "card"; card: ReviewCard; options: GradeOption[] | null }
  | { s: "notCard"; url: string }
  | { s: "done" }
  | { s: "signedOut" }
  | { s: "error" };

class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

async function getJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) throw new HttpError(res.status);
  return res.json();
}

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

export default function ReviewClient({
  isLoggedIn,
  initialUrl,
}: {
  isLoggedIn: boolean;
  initialUrl: string | null;
}) {
  const t = useIntlayer("review-page");
  const [phase, setPhase] = useState<Phase>(isLoggedIn ? { s: "loading" } : { s: "signedOut" });
  const [counts, setCounts] = useState<{ due: number; total: number } | null>(null);
  const [opened, setOpened] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const modality = useInputModality();
  const gradedText = t.graded.value;

  const refreshCounts = useCallback(() => {
    getJson(api.stats())
      .then((j) => {
        const { due, notes } = j as { due?: number; notes?: number };
        if (typeof due === "number" && typeof notes === "number") setCounts({ due, total: notes });
      })
      .catch(() => {});
  }, []);

  /** Show a card, then fetch its four intervals. */
  const show = useCallback((card: ReviewCard, options: GradeOption[] | null = null) => {
    setOpened(false);
    setConfirmDelete(false);
    setPhase({ s: "card", card, options });
    if (options) return;
    getJson(api.options(card.id))
      .then((j) =>
        setPhase((p) =>
          p.s === "card" && p.card.id === card.id ? { ...p, options: optionsFrom(j) } : p,
        ),
      )
      .catch(() => {});
  }, []);

  const fail = useCallback((e: unknown) => {
    setPhase(e instanceof HttpError && e.status === 401 ? { s: "signedOut" } : { s: "error" });
  }, []);

  /** The next due card: the one the API just named, else the top of the due pile. */
  const loadNext = useCallback(
    async (preferUrl?: string | null) => {
      try {
        let card: ReviewCard | null = null;
        if (preferUrl) card = cardFromGet(await getJson(api.get(preferUrl)).catch(() => null));
        card ??= cardFromDue(await getJson(api.due()));
        if (card) show(card);
        else setPhase({ s: "done" });
      } catch (e) {
        fail(e);
      }
      refreshCounts();
    },
    [show, fail, refreshCounts],
  );

  const start = useCallback(async () => {
    setPhase({ s: "loading" });
    if (!initialUrl) return loadNext();
    try {
      const card = cardFromGet(await getJson(api.get(initialUrl)));
      if (card) show(card);
      else setPhase({ s: "notCard", url: initialUrl });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) setPhase({ s: "notCard", url: initialUrl });
      else fail(e);
    }
    refreshCounts();
  }, [initialUrl, loadNext, show, fail, refreshCounts]);

  useEffect(() => {
    if (isLoggedIn) void start();
  }, [isLoggedIn, start]);

  /** Leave `?url=` behind once that card is dealt with: from here on it is the plain queue. */
  const dropUrlParam = () => {
    if (!new URLSearchParams(location.search).has("url")) return;
    history.replaceState(history.state, "", location.pathname);
  };

  const grade = useCallback(
    async (rating: Rating) => {
      if (phase.s !== "card" || busy) return;
      setBusy(true);
      try {
        const j = (await getJson(api.review(phase.card.id, rating))) as {
          due?: string;
          nextUrl?: string | null;
        };
        setFlash(j.due ? fill(gradedText, { time: j.due }) : null);
        dropUrlParam();
        await loadNext(j.nextUrl);
      } catch (e) {
        fail(e);
      } finally {
        setBusy(false);
      }
    },
    [phase, busy, loadNext, fail, gradedText],
  );

  const remove = useCallback(async () => {
    if (phase.s !== "card" || busy) return;
    setBusy(true);
    try {
      const j = (await getJson(api.delete(phase.card.id))) as { nextUrl?: string | null };
      setFlash(null);
      dropUrlParam();
      await loadNext(j.nextUrl);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }, [phase, busy, loadNext, fail]);

  const add = async (url: string) => {
    setBusy(true);
    try {
      const j = (await getJson(api.add(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      })) as { _id?: unknown; url?: string; title?: string | null; options?: unknown };
      const card = cardFromGet({ ...j, _id: j._id == null ? undefined : String(j._id) });
      if (card) show(card, optionsFrom(j));
      else setPhase({ s: "error" });
      refreshCounts();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // Clear the "Graded" line a few seconds after it appears.
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(id);
  }, [flash]);

  // Keyboard: the legacy grading page's keys (lib/review-ui.ts keyAction).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      const typing =
        !!a && (a.isContentEditable || a.tagName === "INPUT" || a.tagName === "TEXTAREA");
      const act = keyAction({ ...e, code: e.code, typing });
      if (!act || phase.s !== "card") return;
      // Enter on a focused button or link is that control's own click.
      if (e.code === "Enter" && a && /^(A|BUTTON|SUMMARY)$/.test(a.tagName)) return;
      e.preventDefault();
      if (act.kind === "grade") void grade(act.rating);
      else if (act.kind === "delete") setConfirmDelete(true);
      else if (act.kind === "cancel") setConfirmDelete(false);
      else if (act.kind === "open") {
        window.open(phase.card.url, "_blank", "noopener,noreferrer");
        setOpened(true);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [phase, grade]);

  const gradeLabel: Record<Rating, string> = {
    1: t.again.value,
    2: t.hard.value,
    3: t.good.value,
    4: t.easy.value,
  };
  const gradeTone: Record<Rating, string> = {
    1: "grade-again",
    2: "grade-hard",
    3: "grade-good",
    4: "grade-easy",
  };

  return (
    <main className="max-w-xl mx-auto px-4 py-6 sm:py-8 space-y-5">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-brush text-4xl">{t.title}</h1>
        {counts && (
          <p className="text-sm tabular-nums opacity-70" data-testid="review-counts">
            {fill(t.counts.value, { due: counts.due, total: counts.total })}
          </p>
        )}
      </header>

      {isLoggedIn && <Tutorial />}

      {flash && (
        <p
          role="status"
          className="rounded-lg border border-black/10 dark:border-white/10 px-4 py-2 text-sm"
        >
          {flash}
        </p>
      )}

      {phase.s === "loading" && (
        <p className="py-10 text-center text-lg opacity-70" role="status">
          {t.loading}
        </p>
      )}

      {phase.s === "card" && (
        <section
          className="rounded-2xl border border-black/10 dark:border-white/10 bg-white/60 dark:bg-gray-900/60 p-5 sm:p-6 space-y-5"
          data-testid="review-card"
          aria-busy={busy}
        >
          <div className="space-y-1 min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide opacity-60">{t.upNext}</p>
            <h2 className="text-xl font-semibold break-words">
              {phase.card.title ?? phase.card.url}
            </h2>
            <p className="text-sm opacity-60 break-all">{phase.card.url}</p>
          </div>

          <div className="space-y-2">
            <a
              href={phase.card.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpened(true)}
              className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 px-5 py-3 text-lg font-semibold text-white"
              data-testid="open-card"
            >
              {t.openCard} <span aria-hidden>↗</span>
            </a>
            <p className="text-sm opacity-70">{opened ? t.opened : t.openHint}</p>
          </div>

          <div className="grid grid-cols-4 gap-2" role="group" aria-label={t.title.value}>
            {RATINGS.map((r) => {
              const due = phase.options?.find((o) => o.rating === r)?.due;
              return (
                <button
                  key={r}
                  type="button"
                  disabled={busy}
                  onClick={() => void grade(r)}
                  className={`${gradeTone[r]} flex min-h-16 flex-col items-center justify-center rounded-xl border-2 px-1 py-2 font-semibold disabled:opacity-50`}
                  style={{
                    borderColor: "var(--grade)",
                    color: "var(--grade)",
                    background: "oklch(from var(--grade) l c h / 0.08)",
                  }}
                  data-testid={`grade-${r}`}
                >
                  <span className="text-base leading-tight">{gradeLabel[r]}</span>
                  <span className="text-xs tabular-nums opacity-80">
                    {due ?? "…"}
                    {modality === "keyboard" && (
                      <kbd className="ms-1 opacity-70">{gradeKey(r)}</kbd>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            {confirmDelete ? (
              <div
                role="alertdialog"
                aria-label={t.deleteCard.value}
                className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-blue-600/40 p-3"
              >
                <p className="w-full">{t.deleteAsk}</p>
                <button
                  type="button"
                  autoFocus
                  disabled={busy}
                  onClick={() => void remove()}
                  className="min-h-10 rounded-lg bg-blue-600 px-4 font-semibold text-white"
                  data-testid="delete-yes"
                >
                  {t.deleteYes}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="min-h-10 rounded-lg border border-black/15 dark:border-white/15 px-4"
                >
                  {t.deleteNo}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="min-h-10 rounded-lg px-2 opacity-70 hover:opacity-100 underline-offset-2 hover:underline"
                data-testid="delete-card"
              >
                {t.deleteCard}
              </button>
            )}
          </div>

          {modality === "keyboard" && <p className="text-xs opacity-60">{t.keys}</p>}
        </section>
      )}

      {phase.s === "notCard" && (
        <section className="rounded-2xl border border-black/10 dark:border-white/10 p-5 space-y-3">
          <h2 className="text-xl font-semibold">{t.notCard}</h2>
          <p className="text-sm opacity-70 break-all">{phase.url}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void add(phase.url)}
              className="min-h-11 rounded-lg bg-blue-600 hover:bg-blue-700 px-5 font-semibold text-white"
            >
              {t.addCard}
            </button>
            <button
              type="button"
              onClick={() => {
                dropUrlParam();
                setPhase({ s: "loading" });
                void loadNext();
              }}
              className="min-h-11 rounded-lg border border-black/15 dark:border-white/15 px-4"
            >
              {t.nextCard}
            </button>
          </div>
        </section>
      )}

      {phase.s === "done" && (
        <section
          className="rounded-2xl border border-black/10 dark:border-white/10 p-6 text-center space-y-3"
          data-testid="review-done"
        >
          <p className="text-4xl" aria-hidden>
            ✓
          </p>
          <h2 className="text-2xl font-semibold">{t.allDone}</h2>
          <p className="opacity-70">{t.allDoneBody}</p>
          <div className="flex flex-wrap justify-center gap-2 pt-2">
            <Link
              href="/home"
              className="min-h-11 inline-flex items-center rounded-lg bg-blue-600 hover:bg-blue-700 px-5 font-semibold text-white"
            >
              {t.backHome}
            </Link>
            <Link
              href="/list"
              className="min-h-11 inline-flex items-center rounded-lg border border-black/15 dark:border-white/15 px-4"
            >
              {t.cardList}
            </Link>
          </div>
        </section>
      )}

      {phase.s === "signedOut" && (
        <section className="rounded-2xl border border-black/10 dark:border-white/10 p-6 text-center space-y-3">
          <h2 className="text-xl font-semibold">{t.signInTitle}</h2>
          <div className="flex flex-wrap justify-center gap-2">
            <Link
              href={`/sign-in?callbackUrl=${encodeURIComponent(
                initialUrl ? `/review?url=${encodeURIComponent(initialUrl)}` : "/review",
              )}`}
              className="min-h-11 inline-flex items-center rounded-lg bg-blue-600 hover:bg-blue-700 px-5 font-semibold text-white"
            >
              {t.signIn}
            </Link>
            <Link
              href="/next"
              className="min-h-11 inline-flex items-center rounded-lg border border-black/15 dark:border-white/15 px-4"
            >
              {t.localDeck}
            </Link>
          </div>
        </section>
      )}

      {phase.s === "error" && (
        <section className="rounded-2xl border border-blue-600/40 p-5 space-y-3" role="alert">
          <p>{t.error}</p>
          <button
            type="button"
            onClick={() => void start()}
            className="min-h-11 rounded-lg bg-blue-600 hover:bg-blue-700 px-5 font-semibold text-white"
          >
            {t.retry}
          </button>
        </section>
      )}

      {isLoggedIn && <Bookmarklet />}

      <footer className="pt-2 text-xs opacity-60">
        {/* The bare HTML flow, kept exactly as it was (owner, 2026-11-01). */}
        <a href="/api/fsrs/next" className="underline underline-offset-2">
          {t.classic}
        </a>
      </footer>
    </main>
  );
}

/** Three steps for reviewing without the userscript; iPhone or Android, folded per device. */
function Tutorial() {
  const t = useIntlayer("review-page");
  const { locale } = useLocale();
  const collapsed = useUi(tutorialStore, (s) => s.collapsed);
  const picked = useUi(tutorialStore, (s) => s.platform);
  const [detected, setDetected] = useState<Platform>("ios");
  useEffect(() => setDetected(detectPlatform(navigator.userAgent)), []);
  const platform: Platform = picked === "ios" || picked === "android" ? picked : detected;
  const steps =
    platform === "android"
      ? [t.androidStep1, t.androidStep2, t.androidStep3]
      : [t.iosStep1, t.iosStep2, t.iosStep3];

  return (
    <section
      className="rounded-2xl border border-black/10 dark:border-white/10 px-4 py-3 space-y-3"
      data-testid="review-tutorial"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold me-auto">{t.tutorialTitle}</h2>
        {!collapsed && (
          <div
            role="radiogroup"
            aria-label={t.tutorialTitle.value}
            className="inline-flex rounded-lg border border-black/15 dark:border-white/15 p-0.5 text-sm"
          >
            {(["ios", "android"] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={platform === p}
                onClick={() => tutorialStore.setState({ platform: p })}
                className={`min-h-10 rounded-md px-3 ${platform === p ? "bg-blue-600 text-white" : ""}`}
              >
                {p === "ios" ? t.iphone : t.android}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => tutorialStore.setState({ collapsed: !collapsed })}
          className="min-h-10 rounded-lg px-3 text-sm underline underline-offset-2"
          data-testid="tutorial-toggle"
        >
          {collapsed ? t.tutorialShow : t.tutorialHide}
        </button>
      </div>
      {!collapsed && (
        <>
          <ol className="list-decimal ps-5 space-y-1.5 text-[15px]">
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <p className="text-sm opacity-80">
            {t.userscriptTip}{" "}
            <a
              href={installGuideHref(platform, locale)}
              className="font-medium text-blue-600 dark:text-blue-400 underline underline-offset-2"
            >
              {t.installGuide} →
            </a>
          </p>
        </>
      )}
    </section>
  );
}

/** The bookmarklet: code with a copy button, a draggable link, and install steps. */
function Bookmarklet() {
  const t = useIntlayer("review-page");
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const src = bookmarkletSource(location.origin);
    setCode(src);
    // React refuses javascript: hrefs in JSX; this one is ours, so set it directly.
    linkRef.current?.setAttribute("href", src);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const ta = document.getElementById("lk-bookmarklet-code") as HTMLTextAreaElement | null;
      ta?.select();
      document.execCommand?.("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <details
      className="rounded-2xl border border-black/10 dark:border-white/10 px-4 py-3 group"
      data-testid="review-bookmarklet"
    >
      <summary className="cursor-pointer font-semibold min-h-10 flex items-center">
        {t.bmTitle}
      </summary>
      <div className="space-y-3 pt-2 text-[15px]">
        <p>{t.bmBody}</p>
        <p className="text-sm opacity-70">{t.bmLimit}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <textarea
            id="lk-bookmarklet-code"
            readOnly
            value={code}
            rows={3}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full min-w-0 flex-1 resize-none rounded-lg border border-black/15 dark:border-white/15 bg-transparent p-2 font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => void copy()}
            className="min-h-11 shrink-0 rounded-lg bg-blue-600 hover:bg-blue-700 px-4 font-semibold text-white"
            data-testid="bookmarklet-copy"
          >
            {copied ? t.copied : t.copy}
          </button>
        </div>
        <p className="hidden sm:block text-sm">
          {t.bmDrag}{" "}
          <a
            ref={linkRef}
            onClick={(e) => e.preventDefault()}
            className="ms-1 inline-block rounded-lg border border-blue-600 px-3 py-1 font-medium text-blue-600 dark:text-blue-400"
          >
            {t.bmName}
          </a>
        </p>
        <div className="space-y-1">
          <h3 className="font-medium">{t.bmIosTitle}</h3>
          <ol className="list-decimal ps-5 space-y-1 text-sm">
            <li>{t.bmIos1}</li>
            <li>{t.bmIos2}</li>
            <li>{t.bmIos3}</li>
            <li>{t.bmIos4}</li>
          </ol>
        </div>
        <p className="text-sm">{t.bmAndroid}</p>
      </div>
    </details>
  );
}

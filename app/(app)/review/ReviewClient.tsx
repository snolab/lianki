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
  openPlaceholderTab,
  optionsFrom,
  RATINGS,
  returnStep,
  sendTabTo,
  stateAfterOpen,
  type GradeOption,
  type ReturnEvent,
  type ReturnState,
  type Platform,
  type Rating,
  type ReviewCard,
} from "@/lib/review-ui";

/**
 * /review: one due page card at a time, graded inside the site.
 *
 * For people without the userscript; the tutorial on the page walks the
 * owner's 8 steps. The card's page is opened by a real tap on a link
 * (target=_blank), which iOS Safari never blocks — unlike the bare flow's
 * script-run window.open — or, after a grade, by the grade tap itself
 * (lib/review-ui.ts openPlaceholderTab). When the user is back from that tab,
 * the grading question shows prominently (returnStep); the next card loads in
 * place. Every call is an existing
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
  const [ret, setRet] = useState<ReturnState>("idle");
  const promptRef = useRef<HTMLHeadingElement>(null);
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
    setRet((r) => returnStep(r, "card"));
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
    async (preferUrl?: string | null): Promise<ReviewCard | null> => {
      let card: ReviewCard | null = null;
      try {
        if (preferUrl) card = cardFromGet(await getJson(api.get(preferUrl)).catch(() => null));
        card ??= cardFromDue(await getJson(api.due()));
        if (card) show(card);
        else setPhase({ s: "done" });
      } catch (e) {
        fail(e);
      }
      refreshCounts();
      return card;
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
      // Step 3: this tap (or key press) is what lets a tab open; the next
      // card's url follows once the grade is saved.
      const tab = openPlaceholderTab(window, counts?.due ?? null);
      let next: ReviewCard | null = null;
      try {
        const j = (await getJson(api.review(phase.card.id, rating))) as {
          due?: string;
          nextUrl?: string | null;
        };
        setFlash(j.due ? fill(gradedText, { time: j.due }) : null);
        dropUrlParam();
        next = await loadNext(j.nextUrl);
      } catch (e) {
        fail(e);
      } finally {
        if (sendTabTo(tab, next?.url ?? null))
          setRet(stateAfterOpen({ hidden: document.hidden, focused: document.hasFocus() }));
        setBusy(false);
      }
    },
    [phase, busy, loadNext, fail, gradedText, counts],
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

  // Step 6: back from the card's tab (visible again, or focused again), ask.
  useEffect(() => {
    const on = (e: ReturnEvent) => () => setRet((r) => returnStep(r, e));
    const onVis = () => setRet((r) => returnStep(r, document.hidden ? "hidden" : "visible"));
    const onBlur = on("blur");
    const onFocus = on("focus");
    document.addEventListener("visibilitychange", onVis);
    addEventListener("blur", onBlur);
    addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      removeEventListener("blur", onBlur);
      removeEventListener("focus", onFocus);
    };
  }, []);

  // The prompt in view, and read out, the moment it shows.
  useEffect(() => {
    if (ret !== "back") return;
    const el = promptRef.current;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.focus({ preventScroll: true });
  }, [ret]);

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
        setRet((r) => returnStep(r, "open"));
        window.open(phase.card.url, "_blank", "noopener,noreferrer");
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [phase, grade]);

  /** Step 6: the user is back from the card's tab — ask, prominently. */
  const back = phase.s === "card" && ret === "back";

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
              onClick={() => setRet((r) => returnStep(r, "open"))}
              className={
                back
                  ? "flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-blue-600 px-5 py-2 text-base font-semibold text-blue-600 dark:text-blue-400"
                  : "flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 px-5 py-3 text-lg font-semibold text-white"
              }
              data-testid="open-card"
            >
              {t.openCard} <span aria-hidden>↗</span>
            </a>
            {!back && (
              <p className="text-sm opacity-70">{ret === "idle" ? t.openHint : t.opened}</p>
            )}
          </div>

          {back && (
            <h3
              ref={promptRef}
              tabIndex={-1}
              role="status"
              className="text-center text-2xl font-semibold outline-none"
              data-testid="return-prompt"
            >
              {t.returnPrompt}
            </h3>
          )}

          <div
            className={`grid grid-cols-4 gap-2 ${back ? "rounded-2xl p-2" : ""}`}
            style={
              back
                ? {
                    boxShadow: "0 0 0 3px oklch(0.62 0.19 259.8 / 0.55)",
                    background: "oklch(0.62 0.19 259.8 / 0.08)",
                  }
                : undefined
            }
            role="group"
            aria-label={back ? t.returnPrompt.value : t.title.value}
          >
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

/**
 * The owner's 8 steps, side by side: this page (no userscript) and the
 * userscript. iPhone or Android changes step 5; folded per device.
 */
function Tutorial() {
  const t = useIntlayer("review-page");
  const { locale } = useLocale();
  const collapsed = useUi(tutorialStore, (s) => s.collapsed);
  const picked = useUi(tutorialStore, (s) => s.platform);
  const [detected, setDetected] = useState<Platform>("ios");
  useEffect(() => setDetected(detectPlatform(navigator.userAgent)), []);
  const platform: Platform = picked === "ios" || picked === "android" ? picked : detected;
  const you = t.whoYou;
  const lianki = t.whoLianki;
  const steps = [
    [you, t.flow1Without, t.flow1With],
    [lianki, t.flow2Without, null],
    [lianki, t.flow3Without, t.flow3With],
    [you, t.flow4Without, t.flow4With],
    [you, platform === "android" ? t.flow5WithoutAndroid : t.flow5WithoutIos, t.flow5With],
    [lianki, t.flow6Without, t.flow6With],
    [you, t.flow7, null],
    [lianki, t.flow8Without, t.flow8With],
  ] as const;

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
          <table className="w-full table-fixed border-collapse text-[13px] leading-snug">
            <colgroup>
              <col className="w-14" />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr className="align-bottom text-xs">
                <th scope="col" />
                <th scope="col" className="px-1.5 pb-1 text-start font-semibold">
                  {t.colWithout}
                </th>
                <th scope="col" className="px-1.5 pb-1 text-start font-semibold opacity-70">
                  {t.colWith}
                </th>
              </tr>
            </thead>
            <tbody>
              {steps.map(([who, without, withScript], i) => (
                <tr
                  key={i}
                  className="border-t border-black/10 dark:border-white/10 align-top"
                  data-testid={`tutorial-step-${i + 1}`}
                >
                  <th scope="row" className="py-1.5 pe-1 text-start font-normal">
                    <span className="font-semibold tabular-nums">{i + 1}</span>{" "}
                    <span className="text-[11px] opacity-60">{who}</span>
                  </th>
                  <td className="px-1.5 py-1.5">{without}</td>
                  <td className="px-1.5 py-1.5 opacity-70">{withScript ?? t.same}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-sm">{t.tutorialDiff}</p>
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

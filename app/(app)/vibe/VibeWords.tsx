"use client";

/**
 * The 新词 list on /vibe (docs/vibe.md): the words heard, marked as in the reader,
 * and a card to add one: NewWordStrip, the reader's own preview. Opening a word
 * stores nothing and asks no model (`fetchCachedGloss`: `cached:
 * true`); only the slider's grade makes a card, through lib/vibe/new-words.ts.
 * Follows new lines as they are saved; nothing polls.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import type { WordProbe } from "@/lib/read/batch-grade";
import type { WordRow } from "@/lib/read/reader-model";
import { GRADE_HOLD_MS } from "@/lib/read/reader-server";
import { fetchCachedGloss, type Gloss } from "@/lib/read/select-gloss-fetch";
import {
  createCommits,
  firstHeard,
  heardWords,
  PROBE_MAX,
  probeWords,
  type HeardWord,
  type WordKind,
} from "@/lib/vibe/new-words";
import type { VibeLine } from "@/lib/vibe/session";
import { SWIPE_MIRROR_KEY } from "@/lib/words/swipe";
import { SwipeFeelProvider } from "@/lib/words/swipe-core";
import { NewWordStrip } from "../read/[id]/reader-grade-handle";

const DIM = "text-[oklch(0.45_0_0)] dark:text-[oklch(0.72_0_0)]";

const postGrade = (material: string, body: unknown, keepalive = false) =>
  fetch(`/api/read/${material}/batch-grade`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive,
  }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));

function useHeard(material: string | null, lineCount: number, shown: readonly string[]) {
  const [rows, setRows] = useState<WordRow[]>([]);
  const [probes, setProbes] = useState<Map<string, WordProbe>>(() => new Map());
  const [others, setOthers] = useState<Map<string, WordProbe>>(() => new Map());
  // Words on screen that are not the doc's own counted words (a translation's):
  // whether each has a card, by the same probe. Read only.
  const asked = useRef(new Set<string>());
  const extra = shown.filter((w) => !asked.current.has(w));
  const extraKey = extra.join("\n");
  useEffect(() => {
    if (!material || !extraKey) return;
    const words = extraKey.split("\n").slice(0, PROBE_MAX);
    for (const w of words) asked.current.add(w);
    void postGrade(material, { probe: { words: words.map((w) => ({ w })) } })
      .then((p) =>
        setOthers((m) => {
          const next = new Map(m);
          for (const x of (p as { words: WordProbe[] }).words) next.set(x.w, x);
          return next;
        }),
      )
      .catch(() => {});
  }, [material, extraKey]);
  useEffect(() => {
    if (!material) return;
    let live = true;
    void (async () => {
      const r = await fetch(`/api/read/${material}/words`).catch(() => null);
      if (!r?.ok || !live) return;
      const got = ((await r.json()) as { words?: WordRow[] }).words ?? [];
      if (!live) return;
      setRows(got);
      const words = probeWords(got);
      if (!words.length) return;
      const p = await postGrade(material, { probe: { words } }).catch(() => null);
      if (live && p) setProbes(new Map((p as { words: WordProbe[] }).words.map((x) => [x.w, x])));
    })();
    return () => {
      live = false;
    };
  }, [material, lineCount]);
  return { rows, probes, others };
}

/**
 * The words of a conversation, on either column or in the list: the marks, and the
 * one card a tap opens. `shown` is every word on screen.
 */
export function useVibeWords({
  material,
  lines,
  locale,
  shown,
}: {
  material: string | null;
  lines: readonly VibeLine[];
  locale: string;
  shown: readonly string[];
}) {
  const t = useIntlayer("vibe-page");
  const { rows, probes, others } = useHeard(material, lines.length, shown);
  const [open, setOpen] = useState<HeardWord | null>(null);
  const [context, setContext] = useState<string | null>(null);
  const [, bump] = useState(0);
  const [gloss, setGloss] = useState<{ w: string; g: Gloss | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [mirror, setMirror] = useState(false);
  const [openedAt, setOpenedAt] = useState(0);
  const commits = useRef<ReturnType<typeof createCommits> | null>(null);
  const place = useRef(material);
  place.current = material;
  commits.current ??= createCommits({
    holdMs: GRADE_HOLD_MS,
    newId: () => crypto.randomUUID(),
    day: () => new Date().toLocaleDateString("en-CA"),
    post: (body, keepalive) => postGrade(place.current ?? "", body, keepalive),
    onChange: () => bump((n) => n + 1),
    onFailed: () => setFailed(true),
  });
  const desk = commits.current;

  useEffect(() => {
    try {
      setMirror(localStorage.getItem(SWIPE_MIRROR_KEY) === "1");
    } catch {}
    // The reader's marks are switched on by an attribute on <html> (globals.css).
    const root = document.documentElement;
    const marks = root.dataset.readMarks;
    root.dataset.readMarks = "all";
    // Leaving: what he swiped still goes.
    const out = () => desk.flush();
    window.addEventListener("pagehide", out);
    return () => {
      window.removeEventListener("pagehide", out);
      desk.flush();
      if (marks === undefined) delete root.dataset.readMarks;
      else root.dataset.readMarks = marks;
    };
  }, [desk]);

  const words = useMemo(() => heardWords(rows, probes, Date.now()), [rows, probes]);
  const label: Record<WordKind, string> = {
    new: t.kindNew.value,
    due: t.kindDue.value,
    learning: t.kindLearning.value,
    known: t.kindKnown.value,
  };
  const langName = (code?: string) => {
    if (!code) return null;
    try {
      return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
    } catch {
      return code;
    }
  };

  const openWord = (h: HeardWord, where?: string) => {
    const ctx = where ?? firstHeard(h.w, lines)?.text ?? null;
    setOpen(h);
    setContext(ctx);
    setFailed(false);
    setOpenedAt(performance.now());
    setGloss(null);
    if (!material) return;
    // No user's key here: decks and shared glosses only, no model before a swipe.
    void fetchCachedGloss(material, h.w, ctx).then((g) => setGloss({ w: h.w, g }));
  };

  const byWord = useMemo(() => new Map(words.map((h) => [h.w, h])), [words]);
  /** A word in a line or a translation, whether or not the doc counted it. */
  const heardOf = (w: string): HeardWord => {
    const known = byWord.get(w);
    if (known) return known;
    const carded = !!others.get(w)?.due;
    return {
      w,
      count: 0,
      fam: carded ? "l2" : "u",
      kind: carded ? "learning" : "new",
      carded,
    };
  };

  const card = open && (
    <div
      data-select-card
      data-testid="vibe-word-card"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-[oklch(0.6_0_0/0.3)] bg-[oklch(from_var(--background)_l_c_h/0.9)] px-4 pt-3 backdrop-blur-md"
      style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto max-w-xl">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-xl font-semibold" data-testid="vibe-word-title">
            {open.w}
          </p>
          <button
            type="button"
            className="min-h-11 min-w-11 rounded-lg"
            aria-label={t.close.value}
            data-testid="vibe-word-close"
            onClick={() => setOpen(null)}
          >
            ×
          </button>
        </div>
        <p className={`text-sm ${DIM}`} data-testid="vibe-word-meaning">
          {gloss?.w === open.w ? (gloss.g?.back ?? t.noMeaning) : null}
        </p>
        {failed && (
          <p className="text-sm" role="status" data-testid="vibe-word-failed">
            {t.addFailed}
          </p>
        )}
        {desk.has(open.w) ? (
          <div className="mt-2 flex items-center gap-3">
            <span data-testid="vibe-word-added">{t.added}</span>
            <button
              type="button"
              className="min-h-11 rounded-lg border border-[oklch(0.7_0_0)] px-4 dark:border-[oklch(0.45_0_0)]"
              data-testid="vibe-word-undo"
              onClick={() => desk.undo(open.w)}
            >
              {t.undoAdd}
            </button>
          </div>
        ) : open.carded ? (
          <p className="mt-2" data-testid="vibe-word-carded">
            {t.inDeck}
          </p>
        ) : (
          <SwipeFeelProvider>
            <NewWordStrip
              context={context}
              intervals={null}
              mirror={mirror}
              openedAt={openedAt}
              canUndo={false}
              lastWhat={null}
              onPreview={() => {}}
              onCommit={(r) => desk.commit(open.w, context, r)}
              onUndo={() => {}}
            />
          </SwipeFeelProvider>
        )}
      </div>
    </div>
  );

  const list = (
    <div data-testid="vibe-words">
      {!words.length && <p className={DIM}>{t.wordsEmpty}</p>}
      {/* lk-book: the reader's own marks (globals.css, data-f). */}
      <ul className="lk-book flex flex-col" data-testid="vibe-word-list">
        {words.map((h) => (
          <li key={h.w}>
            <button
              type="button"
              className="flex min-h-11 w-full items-baseline gap-2 py-1 text-start"
              data-testid="vibe-word"
              data-kind={h.kind}
              data-word={h.w}
              onClick={() => openWord(h)}
            >
              <span data-f={h.fam} className="text-lg">
                {h.w}
              </span>
              <span className={`text-xs ${DIM}`}>{langName(firstHeard(h.w, lines)?.lang)}</span>
              <span className={`ms-auto text-xs ${DIM}`}>
                {desk.has(h.w) ? t.added : label[h.kind]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  return {
    list,
    card,
    famOf: (w: string) => heardOf(w).fam,
    openAt: (w: string, where: string) => openWord(heardOf(w), where),
  };
}

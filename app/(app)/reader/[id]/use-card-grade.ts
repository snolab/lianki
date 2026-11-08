"use client";

// Grading from the reader's selection card (lib/read/batch-grade.ts holds the
// rules, POST /api/read/[id]/batch-grade the writes): what the handle offers
// for the selected unit, the grade, its hold and its one undo.
//
// - **Probe.** When a word, phrase, sentence or hand-made range is selected,
//   the server says what each of its sentences and words is now (due, new,
//   not due, no card); the plan follows (handlePlan). A paragraph needs none:
//   it is graded as its swipe grades it (`gradePara`, the reader's own path).
// - **Grade.** One batch per grade, held GRADE_HOLD_MS (as a swipe's) and then
//   sent in one call; sent on leaving the page too. The selection's affected
//   words and sentences flash once in the grade's colour (pulse while the
//   knob is dragged past a level); the underlines refresh when it lands.
// - **Undo.** The last batch: dropped while held, else taken back by the
//   server to exactly the states before. Drag up, the toast, U or ⌘Z.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeByok, type ByokActive } from "@/lib/byok/config";
import { GRADE_HOLD_MS } from "@/lib/read/reader-server";
import { glossSettled, withTabGloss } from "@/lib/read/select-gloss-fetch";
import type { GradeReceipt } from "@/lib/read/reader-adapter";
import {
  batchOf,
  commitPending,
  gradeIntervals,
  handlePlan,
  intervalLabel,
  type HandlePlan,
  type SentenceNext,
  type SentenceProbe,
  type WordProbe,
} from "@/lib/read/batch-grade";
import { formatInterval } from "@/lib/words/schedule";
import type { Unit } from "@/lib/read/reader-select";
import type { SwipeRating } from "@/lib/words/swipe";
import type { RangeWord } from "./reader-word-review";

type Probe = {
  sentences: SentenceProbe;
  words: WordProbe[];
  sentenceNext?: SentenceNext;
};

/** Where a batch shows: the sentences and words to flash, by line. */
export type FlashTargets = { sids: string[]; words: string[]; lines: number[] };

type Entry =
  | {
      kind: "batch";
      id: string;
      body: Record<string, unknown>;
      state: "held" | "sending" | "sent" | "undone";
      timer?: ReturnType<typeof setTimeout>;
      /** Undo asked while it was on its way: taken back once it lands. */
      undoAfter?: boolean;
      /** A new word's commit: the words, to carry the meaning its tap found. */
      commit?: { words: RangeWord[]; own: ByokActive | null };
      flash: FlashTargets;
      what: string;
      at: number;
    }
  | { kind: "para"; receipt: GradeReceipt; what: string; at: number; flash: FlashTargets };

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const localDay = () => new Date().toLocaleDateString("en-CA");

const post = (url: string, body: unknown, keepalive = false) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive,
  }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));

/** The elements a batch touches among the rows mounted now. */
export function flashElements(
  root: ParentNode,
  f: FlashTargets,
  sentenceOf: (sid: string) => { line: number; s: number } | null,
  tokenWords: (line: number) => Map<number, string>,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const sid of f.sids) {
    const p = sentenceOf(sid);
    if (p)
      out.push(...root.querySelectorAll<HTMLElement>(`[data-line="${p.line}"] [data-s="${p.s}"]`));
  }
  if (f.words.length) {
    const ws = new Set(f.words);
    for (const l of f.lines) {
      const tw = tokenWords(l);
      for (const el of root.querySelectorAll<HTMLElement>(`[data-line="${l}"] [data-t]`))
        if (ws.has(tw.get(Number(el.dataset.t)) ?? "")) out.push(el);
    }
  }
  return out;
}

export function useCardGrade(o: {
  id: string;
  /** Grading is there (signed in, reader v2 on the server, the book's hash). */
  on: boolean;
  unit: Unit | null;
  /** Bumped when cards were made or graded elsewhere: probe again. */
  tick: number;
  /** The unit's sentences (sentence ids as the server cuts them). */
  sidsOf: (u: Unit) => string[];
  /** The unit's words as the endpoints take them (a word or phrase: itself). */
  wordsOf: (u: Unit) => Promise<RangeWord[]>;
  /** The lines the unit covers (flash). */
  linesOf: (u: Unit) => number[];
  /** A paragraph graded as its swipe grades it; resolves to its receipt. */
  gradePara: (u: Extract<Unit, { kind: "para" }>, r: SwipeRating) => Promise<GradeReceipt | null>;
  /** Take a paragraph grade back (held: dropped; sent: reverted). */
  revertPara: (receipt: GradeReceipt) => void;
  openReview: (u: Unit) => void;
  famChanged: () => void;
  /** Mark the batch's targets (pulse while dragging, flash on grade / undo). */
  mark: (f: FlashTargets, how: "pulse" | "off" | SwipeRating | "undo") => void;
  /** The batch's name for the hint and toast ("这 3 句 + 12 个词"). */
  describe: (plan: Extract<HandlePlan, { mode: "grade" }>, r: SwipeRating) => string;
  onFailed: () => void;
}) {
  const base = `/api/read/${encodeURIComponent(o.id)}/batch-grade`;
  const [probe, setProbe] = useState<{ key: string; p: Probe } | null>(null);
  const [openedAt, setOpenedAt] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [stack, setStack] = useState<Entry[]>([]);
  const entries = useRef<Entry[]>([]);
  const words = useRef<RangeWord[]>([]);
  const cfg = useRef(o);
  cfg.current = o;

  const u = o.unit;
  const key = u ? JSON.stringify(u) : "";
  // A paragraph is probed too: its sentences' intervals for the hint.
  const probed = u && u.kind !== "chapter" && u.kind !== "book";
  useEffect(() => {
    setOpenedAt(performance.now());
    setNext(null);
  }, [key]);
  useEffect(() => {
    if (!o.on || !u || !probed) return;
    let live = true;
    // Combo clicks move the unit quickly: probe the one he stays on.
    const t = setTimeout(async () => {
      const ws = u.kind === "sentence" || u.kind === "para" ? [] : await cfg.current.wordsOf(u);
      if (!live) return;
      words.current = ws;
      const p = (await post(base, {
        probe: { sentences: cfg.current.sidsOf(u), words: ws },
      }).catch(() => null)) as Probe | null;
      if (live && p) setProbe({ key, p });
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.on, key, o.tick, base]);

  const sids = useMemo(() => (u && probed ? o.sidsOf(u) : []), [key, probed, o.sidsOf]);
  const plan: HandlePlan = useMemo(() => {
    if (!o.on || !u) return { mode: "none" };
    const p = probe?.key === key ? probe.p : null;
    const base = handlePlan(u.kind, p, sids, Date.now());
    // Committed: its due and the undo show until the probe finds the real card.
    return base.mode === "grade" && base.preview && commitPending(stack, base.make[0]?.w)
      ? { mode: "none" }
      : base;
  }, [o.on, u, probe, key, sids, stack]);
  /** Each grade's next interval, as /words labels it ("3d", "1d–5d" over a batch). */
  const intervals = useMemo((): Record<SwipeRating, string | null> | null => {
    const p = probe?.key === key ? probe.p : null;
    if (plan.mode !== "grade" || !p) return null;
    const spans = gradeIntervals(plan, p, Date.now(), sids);
    const out = {} as Record<SwipeRating, string | null>;
    for (const r of [1, 2, 3, 4] as const) out[r] = intervalLabel(spans[r], formatInterval);
    return out;
  }, [plan, probe, key, sids]);

  const sync = () => setStack([...entries.current]);
  const send = useCallback(
    (e: Extract<Entry, { kind: "batch" }>, keepalive = false) => {
      if (e.state !== "held") return;
      clearTimeout(e.timer);
      e.state = "sending";
      const c = e.commit;
      const go = () =>
        post(
          base,
          c ? { ...e.body, words: withTabGloss(cfg.current.id, c.words, c.own) } : e.body,
          keepalive,
        );
      // The tap's model call still on its way: wait for it, or the commit would pay for
      // a second one. Leaving the page cannot wait, and sends what is known.
      (c && !keepalive ? glossSettled(cfg.current.id, c.words, c.own).then(go) : go())
        .then(() => {
          e.state = "sent";
          if (e.undoAfter) return undoSent(e);
          cfg.current.famChanged();
        })
        .catch(() => {
          // Not graded: it leaves the undo stack, and he is told.
          e.state = "undone";
          entries.current = entries.current.filter((x) => x !== e);
          sync();
          cfg.current.onFailed();
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base],
  );
  const undoSent = (e: Extract<Entry, { kind: "batch" }>) =>
    void post(base, { undo: e.id, day: localDay() })
      .then(() => {
        e.state = "undone";
        cfg.current.famChanged();
      })
      .catch(() => cfg.current.onFailed());

  // Leaving the page sends what is held (as the reader's own grades).
  useEffect(() => {
    const flush = () => {
      for (const e of entries.current) if (e.kind === "batch" && e.state === "held") send(e, true);
    };
    const hidden = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      flush();
    };
  }, [send]);

  /** Grade the selection (`r` names the grade: the mirror is already applied). */
  const grade = useCallback(
    (r: SwipeRating): boolean => {
      const c = cfg.current;
      const unit = c.unit;
      if (!unit || plan.mode !== "grade" || plan.disabled) return false;
      const what = c.describe(plan, r);
      if (plan.target === "para" && unit.kind === "para") {
        const lines = c.linesOf(unit);
        void c.gradePara(unit, r).then((receipt) => {
          if (!receipt) return;
          entries.current = [
            ...entries.current,
            { kind: "para", receipt, what, at: Date.now(), flash: { sids: [], words: [], lines } },
          ];
          sync();
        });
        return true;
      }
      const b = batchOf(plan, r);
      const wanted = new Set([...b.words, ...b.make].map((x) => x.w));
      const ws = words.current.filter((x) => wanted.has(x.w));
      const flash: FlashTargets = {
        sids: b.sentences,
        words: [...wanted],
        lines: c.linesOf(unit),
      };
      const id = newId();
      const own = plan.preview ? activeByok() : null;
      const e: Extract<Entry, { kind: "batch" }> = {
        kind: "batch",
        id,
        body: {
          clientId: id,
          rating: r,
          sentences: b.sentences,
          words: ws,
          day: localDay(),
          swipedAt: new Date().toISOString(),
          ...(own ? { own: true } : {}),
        },
        ...(plan.preview ? { commit: { words: ws, own } } : {}),
        state: "held",
        flash,
        what,
        at: Date.now(),
      };
      e.timer = setTimeout(() => send(e), GRADE_HOLD_MS);
      entries.current = [...entries.current, e];
      sync();
      c.mark(flash, r);
      const p = probe?.key === key ? probe.p : null;
      const due =
        plan.target === "word" || plan.target === "phrase"
          ? [...plan.words, ...plan.make][0]?.next?.[r]
          : plan.target === "sentence"
            ? p?.sentenceNext?.[sids[0] ?? ""]?.[r]
            : undefined;
      setNext(due ?? null);
      if (b.openReview) c.openReview(unit);
      return true;
    },
    [plan, probe, key, send, sids],
  );

  /** Take the last grade given here back. False: nothing to undo. */
  const undo = useCallback((): boolean => {
    const e = entries.current.at(-1);
    if (!e) return false;
    entries.current = entries.current.slice(0, -1);
    sync();
    setNext(null);
    cfg.current.mark(e.flash, "undo");
    if (e.kind === "para") {
      cfg.current.revertPara(e.receipt);
      return true;
    }
    if (e.state === "held") {
      clearTimeout(e.timer);
      e.state = "undone";
    } else if (e.state === "sending") e.undoAfter = true;
    else if (e.state === "sent") undoSent(e);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const last = stack.at(-1) ?? null;
  return {
    plan,
    intervals,
    openedAt,
    /** The due the last grade gave (word, phrase or sentence), shown briefly. */
    next,
    clearNext: () => setNext(null),
    canUndo: !!last,
    lastWhat: last?.what ?? null,
    /** When the last grade here was given (ms), against the reader's own undo. */
    lastAt: last?.at ?? 0,
    grade,
    undo,
    preview: (r: SwipeRating | null, undoing: boolean) => {
      const c = cfg.current;
      if (undoing && last) return c.mark(last.flash, "pulse");
      if (!c.unit || plan.mode !== "grade" || plan.target === "para") return c.mark(EMPTY, "off");
      if (!r) return c.mark(EMPTY, "off");
      const b = batchOf(plan, r);
      c.mark(
        {
          sids: b.sentences,
          words: [...b.words, ...b.make].map((x) => x.w),
          lines: c.linesOf(c.unit),
        },
        "pulse",
      );
    },
  };
}

const EMPTY: FlashTargets = { sids: [], words: [], lines: [] };

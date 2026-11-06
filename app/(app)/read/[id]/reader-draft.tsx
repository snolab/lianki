"use client";

// The speech draft in the reader (lib/read/live-polish.ts, the second choice of
// 整理): the whole text in order, passage by passage, each with its one answer.
// Over the book, which stays where it was: the original is one tap away and
// nothing is saved. Answers are kept for this tab, so reopening asks for nothing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import {
  draftShown,
  draftSlots,
  failSlot,
  nextDraftBatch,
  settleSlot,
  type DraftSlot,
  type LivePolished,
} from "@/lib/read/live-polish";
import { LiveTail } from "./reader-stream";

/** Calls in flight at once. */
const LANES = 3;
/** How long the text is still before an unfinished passage is asked for too. */
const REST_MS = 8000;
/** How long to wait when over the route's limit, and after a failed call. */
const BUSY_MS = 60_000;
const RETRY_MS = 5000;

/** This tab's answers, by the passage's text. */
const answers = new Map<string, Exclude<LivePolished, null>>();

export function useSpeechDraft(id: string, lines: readonly string[], growing: boolean) {
  const [slots, setSlots] = useState<DraftSlot[]>([]);
  const [resting, setResting] = useState(false);
  const [wake, setWake] = useState(0);
  const lanes = useRef(0);
  const pausedUntil = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setSlots((prev) =>
      draftSlots(prev, lines, growing).map((x) => {
        const hit = x.state === "wait" ? answers.get(x.raw) : undefined;
        return hit ? settleSlot(x, hit, true) : x;
      }),
    );
    setResting(false);
    const timer = setTimeout(() => setResting(true), REST_MS);
    return () => clearTimeout(timer);
  }, [lines, growing]);

  const again = useCallback((ms: number) => {
    setTimeout(() => mounted.current && setWake((n) => n + 1), ms);
  }, []);

  useEffect(() => {
    if (lanes.current >= LANES || Date.now() < pausedUntil.current) return;
    const take = nextDraftBatch(slots, resting);
    if (!take.length) return;
    const raws = take.map((i) => slots[i].raw);
    const before = slots
      .slice(Math.max(0, take[0] - 3), take[0])
      .map((x) => x.text ?? x.raw)
      .join("\n");
    lanes.current++;
    const onSlots = (f: (x: DraftSlot, k: number) => DraftSlot) =>
      setSlots((now) =>
        now.map((x, i) => {
          const k = take.indexOf(i);
          return k >= 0 && x.raw === raws[k] ? f(x, k) : x;
        }),
      );
    onSlots((x) => ({ ...x, state: "busy" }));
    void (async () => {
      let busy = false;
      try {
        const r = await fetch(`/api/read/${id}/polish-live`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ passages: raws, before }),
        });
        busy = r.status === 429;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as { passages: LivePolished[] };
        d.passages.forEach((a, k) => {
          if (a) answers.set(raws[k], a);
        });
        onSlots((x, k) => settleSlot(x, d.passages[k] ?? null, take.length === 1));
      } catch (err) {
        console.error("read: speech draft failed", err);
        if (busy) pausedUntil.current = Date.now() + BUSY_MS;
        onSlots((x) => failSlot(x, !busy));
        again(busy ? BUSY_MS : RETRY_MS);
      } finally {
        lanes.current--;
        setWake((n) => n + 1);
      }
    })();
  }, [slots, resting, id, wake, again]);

  return slots;
}

export function SpeechDraft({
  id,
  lines,
  tail,
  lang,
  normLang,
  to,
  title,
  mirror,
  onClose,
}: {
  id: string;
  lines: readonly string[];
  /** The live text not saved yet; null when the text is not being followed. */
  tail: string | null;
  lang: string;
  normLang: string;
  to: string;
  title: string;
  mirror: boolean;
  onClose: () => void;
}) {
  const t = useIntlayer("read-polish");
  const all = useMemo(
    () => (tail ? [...lines, ...tail.split("\n")] : [...lines]).filter((l) => l.trim()),
    [lines, tail],
  );
  const slots = useSpeechDraft(id, all, tail !== null);
  const shown = useMemo(() => draftShown(slots), [slots]);
  const flagText = { none: t.draftNone, fail: t.draftFailed, thin: t.draftThin };
  const left = slots.length - shown.length;
  const flagged = shown.filter((x) => x.flag).length;
  return (
    <div
      className="fixed inset-0 z-40 overflow-y-auto bg-[var(--background)] pb-[50vh]"
      data-testid="read-draft"
    >
      <div className="lk-glass sticky top-0 z-10 flex items-center gap-3 px-4 py-2 text-sm">
        <span className="font-medium">{t.draft}</span>
        <span className="min-w-0 flex-1 truncate text-xs opacity-70" data-testid="read-draft-count">
          {shown.length}/{slots.length}
          {left > 0 && ` · ${t.draftWorking.value}`}
          {flagged > 0 && ` · ${t.draftFlagged.value} ${flagged}`}
        </span>
        <button
          type="button"
          className="shrink-0 underline"
          data-testid="read-draft-close"
          onClick={onClose}
        >
          {t.draftOriginal}
        </button>
      </div>
      <p className="mx-auto mb-4 mt-3 w-full max-w-[38em] px-5 text-xs opacity-70">{t.draftNote}</p>
      <LiveTail
        id={id}
        text={shown.map((x) => x.text).join("\n")}
        lang={lang}
        normLang={normLang}
        to={to}
        lines={[]}
        title={title}
        busy
        mirror={mirror}
        draft={{ flags: shown.map((x) => (x.flag ? flagText[x.flag] : null)) }}
      />
    </div>
  );
}

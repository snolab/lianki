"use client";

/**
 * /read/<id>?streamingFrom=google-docs (docs/connections.md, "Live stream"):
 * lianki-push brings each live edit, shown at once as the tail under the book
 * (only the new words are cut and looked up), and says when the book was saved;
 * then the book is fetched and the tail keeps only what it does not hold yet.
 * Nothing polls. A live doc opens at its newest words; the Reader stays mounted,
 * so the place on the page is kept, and someone at the end follows the new text
 * down. Scrolling up stops the following.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useIntlayer } from "next-intlayer";
import { fill } from "@/lib/nav/nav-core";
import { activeByok } from "@/lib/byok/config";
import { fetchGloss } from "@/lib/read/select-gloss-fetch";
import type { SwipeRating } from "@/lib/words/swipe";
import { NewWordStrip, useGradeWords } from "./reader-grade-handle";
import { OwnKeyTag } from "./reader-select-card";
import { MadeToast } from "./reader-word-review";
import {
  EMPTY_TAIL,
  applyTailOps,
  unsavedTail,
  type Tail,
  type TailOp,
} from "@/lib/read/gdoc-tail";
import { gdocIdOf } from "@/lib/gdoc/url";
import { COMBO_MS } from "@/lib/read/reader-select";
import { cutPara, learningBand, type Fam } from "@/lib/read/reader-model";
import {
  tailHolds,
  tailHtml,
  latestPlan,
  tailNext,
  tailPlan,
  tailRange,
  type TailUnit,
} from "@/lib/read/tail-select";
import { SETTLE_MS } from "./use-reader-select";
import { TranslatedText } from "./translated-text";
import { useSelectTranslate } from "./use-select-translate";

export type StreamState = "connecting" | "live" | "offline";

const atEnd = () =>
  window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40;

const followDown = (follow: boolean) => {
  if (follow)
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
};

/**
 * To the page's end and staying there while the rows above measure themselves,
 * until the height rests, or the reader scrolls for themselves.
 */
export function settleAtEnd(beforeScroll: () => void) {
  let lastHeight = -1;
  let rests = 0;
  let frames = 0;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const ev of ["wheel", "touchstart", "keydown"]) window.removeEventListener(ev, stop);
  };
  const step = () => {
    const height = document.documentElement.scrollHeight;
    rests = height === lastHeight ? rests + 1 : 0;
    lastHeight = height;
    beforeScroll();
    window.scrollTo({ top: height });
    if (rests < 10 && ++frames < 240) frame = requestAnimationFrame(step);
    else stop();
  };
  for (const ev of ["wheel", "touchstart", "keydown"])
    window.addEventListener(ev, stop, { passive: true });
  frame = requestAnimationFrame(step);
}

export function useBookStream<M extends { lines: string[] }>(
  id: string,
  on: boolean,
  setMaterial: (m: M) => void,
): { state: StreamState; tail: string } {
  const [state, setState] = useState<StreamState>("connecting");
  const [tail, setTail] = useState("");
  const tailRef = useRef<Tail>(EMPTY_TAIL);
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    let fetching = false;
    let again = false;
    const refetch = async () => {
      if (fetching) {
        again = true;
        return;
      }
      fetching = true;
      try {
        const follow = atEnd();
        const res = await fetch(`/api/read/${id}`);
        if (res.ok && !stopped) {
          const m = (await res.json()) as M;
          setMaterial(m);
          const text = unsavedTail(m.lines.slice(-200).join("\n"), tailRef.current.text);
          tailRef.current = { ...tailRef.current, text };
          setTail(text);
          followDown(follow);
        }
      } catch (err) {
        console.error("read: live text failed to load", err);
      }
      fetching = false;
      if (again && !stopped) {
        again = false;
        void refetch();
      }
    };
    const connect = () => {
      setState((s) => (s === "live" ? "offline" : s));
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/version/read-stream?book=${encodeURIComponent(id)}`,
      );
      ws.onopen = () => {
        // Anything said while this socket was away is caught up on here.
        if (tries > 0) void refetch();
        tries = 0;
        setState("live");
      };
      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(String(e.data)) as { book?: string; ops?: TailOp[] };
          if (d.book !== id) return;
          if (!d.ops) return void refetch();
          const follow = atEnd();
          tailRef.current = applyTailOps(tailRef.current, d.ops);
          setTail(tailRef.current.text);
          followDown(follow);
        } catch {}
      };
      ws.onclose = () => {
        if (stopped) return;
        setState("offline");
        tries++;
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(tries, 5)));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [id, on, setMaterial]);
  return { state, tail };
}

type Hits = Record<string, [number, 0 | 1]>;

type WordCard = {
  word: string;
  w: string;
  ex: string;
  fam?: Fam;
  term?: string;
  back?: string | null;
  /** Its meaning came from the user's own AI (docs/byok.md). */
  own?: boolean;
  state: "looking" | "ready";
  /** performance.now() when it opened: the opening tap is no press on its knob. */
  openedAt: number;
  adding?: boolean;
  /** The batch that added it, for its undo. */
  added?: string;
};

const noPreview = () => {};

const postJson = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * The text not saved yet, under the book, with the book's selection rules
 * (lib/read/tail-select.ts). Words keep their span as the tail grows, so only
 * new ones mount (and flash), and only words not asked about before go to
 * /api/words/familiarity. A word's meaning and card need it in the book, so a
 * tap on one written since the last save saves first.
 */
/** How long the text is still before an unfinished sentence is translated too. */
const REST_MS = 1500;

export function LiveTail({
  id,
  text,
  lang,
  normLang,
  to,
  lines,
  title,
  sourceUrl,
  busy = false,
  mirror = false,
  draft,
}: {
  id: string;
  text: string;
  lang: string;
  normLang: string;
  to: string;
  lines: readonly string[];
  title: string;
  sourceUrl?: string;
  /** Something in the book is selected: its card has the screen. */
  busy?: boolean;
  /** The swipe's sides are swapped (Settings). */
  mirror?: boolean;
  /** The speech draft's text, not the doc's: its words may be in no save, and a paragraph may carry a flag. */
  draft?: { flags: readonly (ReactNode | null)[] };
}) {
  const t = useIntlayer("read-gdoc-stream");
  const tg = useIntlayer("read-grade-handle");
  const tr = useIntlayer("read-word-review");
  const { grades } = useGradeWords();
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const ts = useIntlayer("read-select");
  const [fam, setFam] = useState<Map<string, Fam>>(() => new Map());
  const [unit, setUnit] = useState<TailUnit | null>(null);
  const [card, setCard] = useState<WordCard | null>(null);
  const asked = useRef(new Set<string>());
  const root = useRef<HTMLDivElement>(null);
  const cardEl = useRef<HTMLDivElement>(null);
  const lastTap = useRef(0);
  const unitRef = useRef(unit);
  unitRef.current = unit;

  const paraTexts = useMemo(() => text.split("\n").filter((p) => p.trim()), [text]);
  const paras = useMemo(
    () => paraTexts.map((p) => cutPara(p, lang, normLang)),
    [paraTexts, lang, normLang],
  );
  const fresh = paras
    .flatMap((p) => p.sentences.flatMap((x) => x.segs.map((g) => g.w)))
    .filter((w): w is string => !!w && !asked.current.has(w));
  const wanted = [...new Set(fresh)].join("\n");
  useEffect(() => {
    if (!wanted) return;
    const words = wanted.split("\n").slice(0, 600);
    for (const w of words) asked.current.add(w);
    postJson("/api/words/familiarity", { lang: normLang, words })
      .then((r) => (r.ok ? (r.json() as Promise<{ hits: Hits }>) : null))
      .then((d) => {
        if (!d) return;
        setFam((prev) => {
          const next = new Map(prev);
          for (const w of words) {
            const h = d.hits[w];
            next.set(w, !h ? "u" : h[1] ? "k" : learningBand(h[0]));
          }
          return next;
        });
      })
      .catch(() => {});
  }, [wanted, normLang]);

  // Translation: the reader's own, unit by unit. A selection's plan is rebuilt
  // only when the unit changes, so new text arriving does not ask again.
  const unitPlan = useMemo(
    () => tailPlan(unit, paras),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unit],
  );
  // Nothing selected: the newest sentences, from the book once the tail is saved.
  const [dismissed, setDismissed] = useState(false);
  const [resting, setResting] = useState(false);
  useEffect(() => {
    setResting(false);
    const timer = setTimeout(() => setResting(true), REST_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const lastLine = lines[lines.length - 1];
  const latestParas = useMemo(
    () => (paras.length ? paras : lastLine?.trim() ? [cutPara(lastLine, lang, normLang)] : []),
    [paras, lastLine, lang, normLang],
  );
  // Nobody is reading a hidden tab: following it would only spend.
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  const following = !unit && !card && !dismissed && !busy && !hidden;
  const latest = following ? latestPlan(latestParas, resting) : null;
  const latestKey = latest ? JSON.stringify(latest) : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const latestStable = useMemo(() => latest, [latestKey]);
  const plan = unitPlan ?? latestStable;
  const trans = useSelectTranslate(id, to, lang && lang !== "und" ? lang : undefined, plan);

  /** Bring the book up to date, for a word written since the last save. */
  const save = useCallback(async () => {
    const docId = gdocIdOf(sourceUrl);
    if (!docId) return false;
    const r = await postJson("/api/read/gdoc/stream", {
      docId,
      html: tailHtml(lines, text),
      title,
    });
    return r.ok;
  }, [sourceUrl, lines, text, title]);

  /** A book route, saving first once if it says the word is not in the book. */
  const isDraft = !!draft;
  const onBook = useCallback(
    async (path: string, body: unknown) => {
      if (isDraft) return postJson(`/api/read/${id}/${path}`, { ...(body as object), draft: true });
      let r = await postJson(`/api/read/${id}/${path}`, body);
      if (r.status === 400 && (await save())) r = await postJson(`/api/read/${id}/${path}`, body);
      return r;
    },
    [id, save, isDraft],
  );

  const openWord = useCallback(
    async (word: string, w: string, ex: string) => {
      const f = fam.get(w);
      setCard({ word, w, ex, fam: f, state: "looking", openedAt: performance.now() });
      // The meaning, at once (owner's card, 2026-11-06 18:18 JST): charged through
      // chargeAi or asked of his own AI, once per tab; the word is still only a preview.
      // No meaning (none found, or the route refused): the word shows, and can be added.
      const g = await fetchGloss(id, w, ex, activeByok(), {
        post: (body) => onBook("gloss", body),
      });
      setCard((c) =>
        c?.w === w
          ? { ...c, term: g?.term ?? word, back: g?.back ?? null, own: g?.own, state: "ready" }
          : c,
      );
    },
    [fam, id, onBook],
  );

  /** The slider's grade adds the word: its card and that grade, one batch, one undo. */
  const commit = async (rating: SwipeRating) => {
    if (!card) return;
    const { w, ex, term, back, fam: was } = card;
    const clientId = crypto.randomUUID();
    const day = new Date().toLocaleDateString("en-CA");
    setCard({ ...card, adding: true });
    const same = (f: (c: WordCard) => WordCard) => setCard((c) => (c?.w === w ? f(c) : c));
    try {
      const r = await onBook("batch-grade", {
        clientId,
        rating,
        // The meaning the tap found: nothing is asked or charged for it again.
        words: [back ? { w, ex, term, back } : { w, ex }],
        day,
        swipedAt: new Date().toISOString(),
        ...(activeByok() ? { own: true } : {}),
      });
      if (!r.ok) throw new Error(String(r.status));
      setFam((prev) => new Map(prev).set(w, "l1"));
      same((c) => ({ ...c, adding: false, added: clientId, fam: "l1" }));
      setToast({
        text: fill(tg.added.value, { grade: grades[rating] }),
        undo: () =>
          void onBook("batch-grade", { undo: clientId, day }).then((u) => {
            if (!u.ok) return setToast({ text: tg.failed.value });
            setFam((prev) => {
              const next = new Map(prev);
              if (was) next.set(w, was);
              else next.delete(w);
              return next;
            });
            same((c) => ({ ...c, added: undefined, fam: was, openedAt: performance.now() }));
            setToast({ text: tg.undone.value });
          }),
      });
    } catch {
      same((c) => ({ ...c, adding: false }));
      setToast({ text: tg.failed.value });
    }
  };

  const close = useCallback(() => {
    setUnit(null);
    setCard(null);
  }, []);
  /** The card's ×: on the card that follows the text, it stops following. */
  const dismiss = () => {
    if (!unit && !card) setDismissed(true);
    close();
  };

  const onTap = (e: React.MouseEvent) => {
    if (getSelection()?.isCollapsed === false) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tail-t]");
    const now = performance.now();
    if (!el) return close();
    const p = Number(el.dataset.tailP);
    const s = Number(el.dataset.tailS);
    const tok = Number(el.dataset.tailT);
    const combo = now - lastTap.current <= COMBO_MS;
    lastTap.current = now;
    const up = unit && combo && tailHolds(unit, p, s, tok) ? tailNext(unit) : null;
    if (up) {
      setCard(null);
      return setUnit(up);
    }
    if (combo && unit && tailHolds(unit, p, s, tok)) return;
    setUnit({ kind: "word", p, s, t: tok });
    const w = el.dataset.tailW;
    if (w) void openWord(el.textContent ?? "", w, paras[p]?.sentences[s]?.text ?? "");
    else setCard(null);
  };

  // A hand selection, left to the browser; once settled it is whole sentences.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      const sel = getSelection();
      const r = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!r || !root.current?.contains(r.commonAncestorContainer)) return;
      const at = (n: Node) => {
        const e = (n.nodeType === 1 ? (n as HTMLElement) : n.parentElement)?.closest<HTMLElement>(
          "[data-tail-s]",
        );
        return e ? { p: Number(e.dataset.tailP), s: Number(e.dataset.tailS) } : null;
      };
      const a = at(r.startContainer);
      const b = at(r.endContainer);
      if (!a || !b) return;
      const u = tailRange(a, b);
      if (JSON.stringify(u) !== JSON.stringify(unitRef.current)) {
        setCard(null);
        setUnit(u);
      }
    };
    const on = () => {
      clearTimeout(timer);
      timer = setTimeout(settle, SETTLE_MS);
    };
    document.addEventListener("selectionchange", on);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", on);
    };
  }, []);

  // A tap outside the tail and its card clears the selection, as in the book.
  useEffect(() => {
    const on = (e: MouseEvent) => {
      const t = e.target as Node;
      if (root.current?.contains(t) || cardEl.current?.contains(t)) return;
      if (getSelection()?.isCollapsed === false) return;
      setUnit(null);
      setCard(null);
    };
    document.addEventListener("click", on);
    return () => document.removeEventListener("click", on);
  }, []);

  // Double and triple clicks are the combo's, not the browser's selection.
  const noNativeCombo = (e: React.MouseEvent) => {
    if (e.detail > 1) e.preventDefault();
  };

  const [above, setAbove] = useState(false);
  useEffect(() => {
    if (!unit) return;
    const el = root.current?.querySelector("[data-sel]");
    if (el) setAbove(el.getBoundingClientRect().top > window.innerHeight / 2);
  }, [unit]);

  const open = !!card || !!plan;
  if (!paras.length && !open) return null;
  const blocks = trans.translation?.blocks ?? [];
  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        ref={root}
        className="lk-book mx-auto w-full max-w-[38em] px-5"
        data-testid="read-live-tail"
        onClick={onTap}
        onMouseDown={noNativeCombo}
      >
        {paras.map((para, p) => (
          <p key={p} className="mb-4">
            {draft?.flags[p] && (
              <span
                className="mb-1 block select-none text-xs text-[oklch(0.55_0.17_25)]"
                data-testid="read-draft-flag"
              >
                {draft.flags[p]}
              </span>
            )}
            {para.sentences.map((x, s) =>
              x.segs.map((g, j) => {
                const f = g.w ? fam.get(g.w) : undefined;
                const on = unit && tailHolds(unit, p, s, g.t);
                const isWordUnit = unit?.kind === "word";
                return (
                  <span
                    key={`${s}.${j}`}
                    className={draft ? undefined : "lk-live-new"}
                    data-tail-p={p}
                    data-tail-s={s}
                    data-tail-t={g.t >= 0 ? g.t : undefined}
                    data-tail-w={g.w ?? undefined}
                    data-f={f && f !== "k" ? f : undefined}
                    data-sel={on && (!isWordUnit || g.t >= 0) ? "" : undefined}
                  >
                    {g.text}
                  </span>
                );
              }),
            )}
          </p>
        ))}
      </div>
      {toast && (
        <MadeToast
          text={toast.text}
          undoLabel={tr.undo.value}
          onUndo={toast.undo}
          onDone={() => setToast(null)}
        />
      )}
      {open && (
        <div
          ref={cardEl}
          className={`fixed inset-x-3 z-50 mx-auto max-h-[calc(40vh+1lh)] max-w-[34em] overflow-auto rounded-2xl bg-base-100/90 p-4 shadow-lg backdrop-blur ${above ? "top-3" : "bottom-3"}`}
          data-testid="read-live-card"
          onScroll={(e) => {
            const b = e.currentTarget;
            if (trans.more && b.scrollTop + b.clientHeight >= b.scrollHeight - 20) trans.more();
          }}
        >
          <button
            type="button"
            className="float-end opacity-60"
            aria-label={String(ts.clear.value ?? ts.clear)}
            onClick={dismiss}
          >
            ×
          </button>
          {card && (
            <>
              <p className="text-xl font-semibold">{card.term ?? card.word}</p>
              <p className="mt-1">
                {card.state === "looking" ? t.lookingUp : (card.back ?? t.noMeaning)}
                {card.own && <OwnKeyTag label={ts.ownKey} />}
              </p>
              <p className="mt-2 text-sm opacity-60">{card.ex}</p>
              {card.state === "ready" &&
                (card.added ? (
                  <p className="mt-2 text-sm opacity-70">{t.added}</p>
                ) : (
                  !card.adding &&
                  (!card.fam || card.fam === "u" || card.fam === "n") && (
                    <NewWordStrip
                      intervals={null}
                      mirror={mirror}
                      openedAt={card.openedAt}
                      canUndo={false}
                      lastWhat={null}
                      onPreview={noPreview}
                      onCommit={(r) => void commit(r)}
                      onUndo={noPreview}
                    />
                  )
                ))}
            </>
          )}
          {plan && (
            <div data-testid="read-live-translation">
              {!unit && <p className="mb-1 text-xs opacity-60">{t.latest}</p>}
              {blocks.every((b) => b.every((x) => x === null || x === false)) && !trans.failed ? (
                <p className="opacity-60">{ts.translating}</p>
              ) : (
                blocks.map((b, i) => (
                  <p key={i} className="mb-2 whitespace-pre-line">
                    {b.map((x, j) =>
                      x === false ? null : (
                        <span key={j} className={`me-1 ${x === null ? "opacity-60" : ""}`}>
                          <TranslatedText text={x ?? "…"} />
                        </span>
                      ),
                    )}
                  </p>
                ))
              )}
              {trans.failed && (
                <button type="button" className="text-sm underline" onClick={trans.retry}>
                  {ts.translateFailed}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function StreamBadge({ state }: { state: StreamState }) {
  const t = useIntlayer("read-gdoc-stream");
  return (
    <p
      className="fixed left-1/2 top-2 z-40 -translate-x-1/2 rounded-full bg-base-200/80 px-3 py-1 text-xs backdrop-blur"
      data-testid="read-stream-badge"
      data-state={state}
    >
      {state === "live" ? t.live : t.offline}
    </p>
  );
}

"use client";

// The reader v2's rows (ReaderV2.tsx): a heading, or an item — a run of whole
// sentences graded with a sideways swipe, exactly as a /words slip (the swipe
// core, lib/words/swipe-core.tsx; both swipe variants; the mirror setting).
//
// The book as it is: each paragraph a <p>, its sentences and words spans in
// one pass, flat — no boxes, no line numbers. A split paragraph's pieces
// read as one paragraph (no gap between them). The left rail is the item's
// familiarity (thin, a strength, never a box); it joins the paragraphs of
// one item.
//
// Stable addresses for later layers (the combo-click selection, deep links,
// docs/books-plan.md): every row `data-block` (its index) and `data-item`
// (its id), every paragraph `data-line`, every sentence `data-s` (its index
// in the paragraph), every word `data-t` (its token index in the paragraph)
// and `data-f` (its familiarity, read by the marks' CSS only). The words of a
// deck phrase sit in one `data-ph="<t0>-<t1>"` span with `data-pf` (the
// phrase card's familiarity): a second, lower mark layer under the words'.

import { memo, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { useIntlayer } from "next-intlayer";
import {
  type Block,
  type Fam,
  type Para,
  type Piece,
  type Seg,
  itemCoverage,
  pieceSentences,
  railLevel,
} from "@/lib/read/reader-model";
import { phraseAtToken, type PhraseSpan } from "@/lib/read/select-meaning";
import {
  SWIPE_CORE_IFACE,
  type SwipeRowValue,
  SwipeRowProvider,
  useSwipeFeel,
  useSwipeGesture,
} from "@/lib/words/swipe-core";
import { type SwipeRating, SWIPE_ROW_PX } from "@/lib/words/swipe";
import { showReveal, type SwipeLogRow, useNativeSlip } from "@/lib/words/native-slip-gesture";
import { SwipeGrades } from "@/lib/words/islands/SwipeGrades";
import { SwipeCue } from "@/lib/words/islands/SwipeCue";

/** The swipe's travel unit: a /words row's (lib/words/swipe.ts). */
export const READ_SWIPE_A = SWIPE_ROW_PX;
/** Held still this long: a hold, not a tap or a swipe (as /words). */
const HOLD_MS = 500;

// ── Text ────────────────────────────────────────────────────────────────

/** The EPUB's inline emphasis, as its own elements (a closed set, never HTML). */
function emphasise(node: ReactNode, kinds: Seg["k"], key: number): ReactNode {
  if (!kinds) return node;
  return kinds.reduceRight<ReactNode>((inner, k, i) => {
    const Tag = k;
    return <Tag key={`${key}k${i}`}>{inner}</Tag>;
  }, node);
}

function segNode(g: Seg, fam: Map<string, Fam> | null, key: number): ReactNode {
  if (g.t < 0) {
    // In-paragraph line breaks of the book (verse, letters) stay line breaks.
    if (!g.text.includes("\n")) return emphasise(g.text, g.k, key);
    const parts = g.text.split("\n");
    return parts.flatMap((p, i) => (i ? [<br key={`${key}b${i}`} />, p] : [p]));
  }
  const f = g.w && fam ? fam.get(g.w) : undefined;
  return emphasise(
    <span key={key} data-t={g.t} data-f={f === "k" ? undefined : f}>
      {g.parts ? g.parts.map((x, i) => emphasise(x.text, x.k, i)) : g.text}
    </span>,
    g.k,
    key,
  );
}

/**
 * A sentence's segments, the words of each deck phrase in it wrapped in one
 * `data-ph` span (the spaces and marks between them too) for the phrase layer
 * under the words' own marks. A phrase across a sentence end gets one wrapper
 * on each side.
 */
function sentenceNodes(
  segs: readonly Seg[],
  fam: Map<string, Fam> | null,
  phrases: readonly PhraseSpan[] | null,
): ReactNode[] {
  if (!phrases?.length) return segs.map((g, k) => segNode(g, fam, k));
  const out: ReactNode[] = [];
  let open: { ph: PhraseSpan; nodes: ReactNode[]; key: number } | null = null;
  let between: ReactNode[] = [];
  const close = () => {
    if (open) {
      const { ph, nodes, key } = open;
      out.push(
        <span key={`ph${key}`} data-ph={`${ph.t0}-${ph.t1}`} data-pf={ph.m.f ?? "n"}>
          {nodes}
        </span>,
      );
    }
    open = null;
    out.push(...between);
    between = [];
  };
  segs.forEach((g, k) => {
    const node = segNode(g, fam, k);
    if (g.t < 0) {
      (open ? between : out).push(node);
      return;
    }
    const ph = phraseAtToken(phrases, g.t);
    if (open && open.ph === ph) {
      open.nodes.push(...between, node);
      between = [];
      return;
    }
    close();
    if (ph) open = { ph, nodes: [node], key: k };
    else out.push(node);
  });
  close();
  return out;
}

function PieceText({
  para,
  piece,
  fam,
  phrases,
  lang,
  last,
  join,
}: {
  para: Para;
  piece: Piece;
  fam: Map<string, Fam> | null;
  phrases: readonly PhraseSpan[] | null;
  lang: string;
  last: boolean;
  join?: "br" | "sp";
}) {
  const ss = pieceSentences(para, piece);
  const cont = piece.s0 > 0;
  const open = piece.s1 >= 0 && piece.s1 < para.sentences.length;
  return (
    <p
      data-line={piece.line}
      lang={lang}
      className="lk-para"
      data-cont={cont ? "" : undefined}
      data-open={open ? "" : undefined}
      data-last={last ? "" : undefined}
      data-join={join}
    >
      {ss.map((st, i) => (
        <span key={piece.s0 + i} data-s={piece.s0 + i}>
          {sentenceNodes(st.segs, fam, phrases)}
        </span>
      ))}
    </p>
  );
}

// ── Rows ────────────────────────────────────────────────────────────────

export type RowCommon = {
  index: number;
  block: Block;
  para: (line: number) => Para;
  lineText: (line: number) => string;
  fam: Map<string, Fam> | null;
  /** A paragraph's deck phrases (memoised per line), for the phrase layer. */
  phrases: (line: number) => readonly PhraseSpan[] | null;
  /** A line that continues the paragraph before (the EPUB's <br>, or a long one split at import). */
  joinOf: (line: number) => "br" | "sp" | undefined;
  isHeading: (line: number) => boolean;
  /** Bumped when the word map arrives (memo key). */
  famV: number;
  lang: string;
  /** The item's last grade (rail tint), or null. */
  grade: SwipeRating | null;
  touch: boolean;
  variant: "js" | "native";
  mirror: boolean;
  onSwipe: (index: number, r: SwipeRating, el: HTMLElement) => void;
  onTap: (index: number) => void;
  /**
   * The level a sliding item shows (−2…2, the default side's, before the
   * mirror; 0: on its way or home): the Easy hint follows it (ReaderV2).
   */
  onLevel?: (index: number, k: number) => void;
  /** The list's one grade strip (js variant): put under the sliding item. */
  underlay: RefObject<HTMLDivElement | null>;
  scrolling: () => boolean;
  /** One /words-style swipe telemetry row (WordsClient logSwipe's shape). */
  log?: (row: SwipeLogRow) => void;
};

export const BlockRow = memo(function BlockRow(p: RowCommon) {
  const b = p.block;
  if (b.kind === "heading")
    return (
      <h2 data-line={b.line} lang={p.lang} className="lk-head">
        {p.lineText(b.line)}
      </h2>
    );
  if (!p.touch) return <DeskItem {...p} />;
  return p.variant === "native" ? <NativeItem {...p} /> : <TouchItem {...p} />;
});

function ItemBody({ p }: { p: RowCommon }) {
  const b = p.block as Extract<Block, { kind: "item" }>;
  const paras = b.pieces.map((pc) => p.para(pc.line));
  // The server's familiarity (words and his grades) when it gave one.
  const cov =
    b.fam !== undefined
      ? b.fam
      : p.fam
        ? itemCoverage(
            b.pieces.flatMap((pc, i) => pieceSentences(paras[i], pc)),
            p.fam,
          )
        : null;
  return (
    <>
      <span
        aria-hidden
        className="lk-rail"
        data-rail={railLevel(cov)}
        data-grade={p.grade ?? undefined}
      />
      {b.pieces.map((pc, i) =>
        p.isHeading(pc.line) ? (
          // A heading the server put into an item stays a heading.
          <h2 key={`${pc.line}.${pc.s0}`} data-line={pc.line} lang={p.lang} className="lk-head">
            {p.lineText(pc.line)}
          </h2>
        ) : (
          <PieceText
            key={`${pc.line}.${pc.s0}`}
            para={paras[i]}
            piece={pc}
            fam={p.fam}
            phrases={p.phrases(pc.line)}
            lang={p.lang}
            last={i === b.pieces.length - 1}
            join={pc.s0 === 0 ? p.joinOf(pc.line) : undefined}
          />
        ),
      )}
    </>
  );
}

const itemAttrs = (p: RowCommon) => {
  const b = p.block as Extract<Block, { kind: "item" }>;
  return { "data-item": b.id, "data-block": p.index };
};

/** Desktop: no swipe (keys 1–4 grade the current item); a click is a tap. */
function DeskItem(p: RowCommon) {
  return (
    <div {...itemAttrs(p)} className="lk-item" onClick={() => p.onTap(p.index)}>
      <ItemBody p={p} />
    </div>
  );
}

/** The js swipe (variant A): the core moves the item; its lift is the /words cue. */
function TouchItem(p: RowCommon) {
  const a = READ_SWIPE_A;
  const { feel, reducedMotion } = useSwipeFeel(SWIPE_CORE_IFACE);
  const node = useRef<HTMLElement | null>(null);
  const core = useSwipeGesture({
    a,
    feel,
    reducedMotion,
    holdMs: HOLD_MS,
    scrolling: p.scrolling,
    onTap: () => p.onTap(p.index),
    onSwipe: (r) => node.current && p.onSwipe(p.index, r, node.current),
    onSlide: (row) => {
      node.current = row;
      const u = p.underlay.current;
      const list = u?.parentElement;
      if (!u || !list) return;
      const lr = list.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      u.style.top = `${rr.top - lr.top}px`;
      u.style.height = `${rr.height}px`;
      u.style.left = `${rr.left - lr.left}px`;
      u.style.width = `${rr.width}px`;
      u.style.setProperty("--a", `${a}px`);
      showReveal(u, 0);
      u.style.visibility = "visible";
      p.onLevel?.(p.index, 0);
    },
    onLevel: (k) => {
      navigator.vibrate?.(Math.abs(k) === 2 ? 12 : 6);
      showReveal(p.underlay.current, k);
      p.onLevel?.(p.index, k);
    },
    onRelease: (r) =>
      p.log?.({ finger: r.finger, v: r.v, projected: r.projected, rating: r.rating, a }),
  });
  // The strip hides again once the item is home.
  const slid = useRef(false);
  useLayoutEffect(() => {
    if (core.phase === "idle" && p.underlay.current) p.underlay.current.style.visibility = "hidden";
    // Home again after a slide: the Easy hint goes.
    if (core.phase !== "idle") slid.current = true;
    else if (slid.current) {
      slid.current = false;
      p.onLevel?.(p.index, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core.phase, p.underlay]);
  const value: SwipeRowValue = {
    iface: 1,
    variant: "js",
    phase: core.phase,
    feel,
    reducedMotion,
    card: null,
  };
  return (
    <SwipeRowProvider value={value}>
      <div
        {...itemAttrs(p)}
        ref={(el) => {
          node.current = el;
          core.bind.ref(el);
        }}
        className="lk-item"
        data-moving={core.phase !== "idle" ? "" : undefined}
        data-swipe-phase={feel.lift > 0 ? core.phase : undefined}
        style={{ touchAction: "pan-y" }}
        onPointerDown={core.bind.onPointerDown}
        onPointerMove={core.bind.onPointerMove}
        onPointerUp={core.bind.onPointerUp}
        onPointerCancel={core.bind.onPointerCancel}
      >
        <ItemBody p={p} />
        <SwipeCue />
      </div>
    </SwipeRowProvider>
  );
}

/**
 * The New swipe (variant B, lib/words/swipe-ab.ts): the item is the face of
 * its own horizontal scroller with snap points at the levels; the browser
 * does the gesture (lib/words/native-slip-gesture.ts, shared with /words).
 */
function NativeItem(p: RowCommon) {
  const a = READ_SWIPE_A;
  const scroller = useRef<HTMLDivElement>(null);
  const face = useRef<HTMLDivElement>(null);
  const { feel, reducedMotion } = useSwipeFeel(SWIPE_CORE_IFACE);
  // Rows mount as the list scrolls: each starts centred before it is painted.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = 2 * a;
  }, [a]);
  const phase = useNativeSlip(scroller, a, {
    onTap: () => p.onTap(p.index),
    onSwipe: (r) => face.current && p.onSwipe(p.index, r, face.current),
    onReveal: (k) => p.onLevel?.(p.index, k),
    scrolling: p.scrolling,
    feel,
    reducedMotion,
    holdMs: HOLD_MS,
    log: p.log,
  });
  const value: SwipeRowValue = {
    iface: 1,
    variant: "native",
    phase,
    feel,
    reducedMotion,
    card: null,
  };
  return (
    <SwipeRowProvider value={value}>
      <div
        {...itemAttrs(p)}
        className="lk-item-native"
        data-moving={phase !== "idle" ? "" : undefined}
        data-swipe-phase={feel.lift > 0 ? phase : undefined}
        style={{ ["--a" as string]: `${a}px` }}
      >
        <SwipeCue />
        <div
          aria-hidden
          className="lk-item-strip"
          data-swipe-strip
          data-mirror={p.mirror ? "" : undefined}
        >
          <GradeStrip mirror={p.mirror} />
        </div>
        <div ref={scroller} className="lk-item-scroller">
          <div className="lk-item-track">
            {[0, 1, 2, 3, 4].map((k) => (
              <i key={k} className="slip-snap" style={{ left: k * a }} />
            ))}
            <div ref={face} className="lk-item lk-item-face">
              <ItemBody p={p} />
            </div>
          </div>
        </div>
      </div>
    </SwipeRowProvider>
  );
}

/** What a sliding item uncovers; the grade names in the app's language (words-page). */
export function GradeStrip({ mirror }: { mirror: boolean }) {
  const text = useIntlayer("words-page");
  return (
    <SwipeGrades
      again={text.again.value}
      hard={text.hard.value}
      good={text.good.value}
      easy={text.easy.value}
      mirror={mirror}
    />
  );
}

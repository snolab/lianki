// The reader v2's data from the server (lib/read/reader-api.ts, PR #480):
// items as runs of whole sentences with the backend's sentence cuts, a swipe
// graded per sentence (FSRS on each), the synced position. Pure where it can
// be (blocksFromItems, itemGrade), so it is unit-tested without a server
// (unit/read-reader-model.test.ts).
//
// High-water mark: only items he graded move it (a fling never does), once
// their grade is sent (an undone grade never moves it).
//
// Undo. The grade API has no take-back, so a grade waits here for
// GRADE_HOLD_MS before it is sent (or until the page is hidden): Undo inside
// that window simply drops it. A grade already sent cannot be undone.

import type {
  GradeRequest,
  ItemsResponse,
  ProgressPut,
  ProgressResponse,
  ReadItem,
  SentenceState,
} from "./reader-api";
import { parseSentenceId, sentenceId } from "./reader-api";
import type { SwipeRating } from "@/lib/words/swipe";
import type { Block, Piece } from "./reader-model";
import type { GradeReceipt, Loaded, ReaderBook, ReaderData } from "./reader-adapter";
import { type Anchor, loadAnchor, newestAnchor, saveAnchor } from "./reader-pos";

/** How long a grade waits before it is sent: the time Undo has. */
export const GRADE_HOLD_MS = 8000;

/** One item's last grade: the latest of its sentences' last ratings. */
export function itemGrade(
  item: Pick<ReadItem, "sentences">,
  bookHash: string,
  cards: Record<string, SentenceState>,
): SwipeRating | null {
  let best: SentenceState | null = null;
  for (const [line, index] of item.sentences) {
    const c = cards[sentenceId(bookHash, line, index)];
    if (c && (!best || c.lastAt > best.lastAt)) best = c;
  }
  return best ? best.lastRating : null;
}

/**
 * The server's items as the reader's blocks, in reading order: each item's
 * sentences grouped into pieces by line; a line no item covers that is a
 * heading becomes a heading block. Also every line's sentence cuts, so the
 * page cuts paragraphs exactly where the server did.
 */
export function blocksFromItems(
  res: Pick<ItemsResponse, "items" | "bookHash" | "cards">,
  headings: ReadonlySet<number>,
  lineCount: number,
): {
  blocks: Block[];
  cuts: Map<number, [number, number][]>;
  sids: Map<string, string[]>;
  grades: Record<string, SwipeRating>;
} {
  const cuts = new Map<number, [number, number][]>();
  for (const it of res.items)
    for (const [line, index, start, end] of it.sentences) {
      const list = cuts.get(line) ?? [];
      list[index] = [start, end];
      cuts.set(line, list);
    }
  for (const [line, list] of cuts) cuts.set(line, list.filter(Boolean));
  const sids = new Map<string, string[]>();
  const grades: Record<string, SwipeRating> = {};
  const items = res.items
    .filter((it) => it.sentences.length)
    .map((it) => {
      const pieces: Piece[] = [];
      for (const [line, index] of it.sentences) {
        const last = pieces[pieces.length - 1];
        if (last && last.line === line && last.s1 === index) last.s1 = index + 1;
        else pieces.push({ line, s0: index, s1: index + 1 });
      }
      // A piece that runs to its line's end reads -1 (to the end).
      for (const p of pieces) if (p.s1 >= (cuts.get(p.line)?.length ?? 0)) p.s1 = -1;
      sids.set(
        it.key,
        it.sentences.map(([l, i]) => sentenceId(res.bookHash, l, i)),
      );
      const g = itemGrade(it, res.bookHash, res.cards);
      if (g) grades[it.key] = g;
      const block: Block = { kind: "item", id: it.key, pieces, fam: it.fam.value };
      return { line: it.sentences[0][0], s: it.sentences[0][1], block };
    });
  const covered = new Set(cuts.keys());
  const heads = [...headings]
    .filter((l) => l < lineCount && !covered.has(l))
    .map((line) => ({ line, s: -1, block: { kind: "heading", line } as Block }));
  const blocks = [...items, ...heads]
    .sort((a, b) => a.line - b.line || a.s - b.s)
    .map((x) => x.block);
  return { blocks, cuts, sids, grades };
}

/**
 * Grades past their Undo window that the server has not acknowledged yet,
 * kept on the device (local `lk:read-unsent`, a queue like /words'
 * `lk:swipe-unsent`, not UI state), so going offline or closing the page
 * loses none: each open of the book sends them again (the clientId makes a
 * resend grade once).
 */
export const UNSENT_KEY = "lk:read-unsent";
/** A ceiling only against a runaway: far more grades than a reading session gives. */
const UNSENT_MAX = 5000;
type Unsent = { m: string; req: GradeRequest };
const unsent = {
  read(): Unsent[] {
    try {
      const v = JSON.parse(localStorage.getItem(UNSENT_KEY) ?? "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  },
  write(list: Unsent[]) {
    try {
      if (list.length) localStorage.setItem(UNSENT_KEY, JSON.stringify(list.slice(-UNSENT_MAX)));
      else localStorage.removeItem(UNSENT_KEY);
    } catch {}
  },
  add(m: string, req: GradeRequest) {
    const list = unsent.read().filter((u) => u.req.clientId !== req.clientId);
    list.push({ m, req });
    unsent.write(list);
  },
  drop(clientId: string | undefined) {
    unsent.write(unsent.read().filter((u) => u.req.clientId !== clientId));
  },
};

type Pending = {
  req: GradeRequest;
  timer: ReturnType<typeof setTimeout>;
  /** A request is on its way: no longer undoable, kept until it succeeds. */
  inflight: boolean;
  /** The last line of the graded item (the high-water mark). */
  line: number;
  /** An Easy grade's words, still being gathered: joined to the request before it is sent. */
  words?: Promise<EasyWords | null | undefined>;
  onSent?: () => void;
};

type EasyWords = NonNullable<GradeRequest["easyWords"]>;

export function serverReaderData(
  materialId: string,
  bookHash: string,
  /** The Undo window (tests shorten it). */
  holdMs = GRADE_HOLD_MS,
): ReaderData {
  const base = `/api/read/${encodeURIComponent(materialId)}`;
  let sids = new Map<string, string[]>();
  const last = new Map<string, SwipeRating[]>();
  const pending = new Map<string, Pending>();
  /** The synced high-water mark, and lines of grades sent (kept). */
  let highLine = -1;
  const high = () =>
    Math.max(highLine, ...[...pending.values()].filter((p) => p.inflight).map((p) => p.line));

  // A grade stays pending until the server has it; a failure is tried again
  // later (the clientId makes a resend grade once).
  const send = (clientId: string, keepalive = false) => {
    const p = pending.get(clientId);
    if (!p) return;
    clearTimeout(p.timer);
    // An Easy grade's words ride in the same request: wait for them (the
    // grade is no longer undoable from here, as any grade being sent).
    if (p.words) {
      const words = p.words;
      p.words = undefined;
      p.inflight = true;
      void words
        .catch(() => null)
        .then((w) => {
          if (w?.words.length) p.req.easyWords = w;
          p.inflight = false;
          send(clientId, keepalive);
        });
      return;
    }
    if (!p.inflight) unsent.add(materialId, p.req);
    p.inflight = true;
    void fetch(`${base}/grade`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p.req),
      keepalive,
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        pending.delete(clientId);
        unsent.drop(clientId);
        highLine = Math.max(highLine, p.line);
        p.onSent?.();
      })
      .catch((err) => {
        console.error("read: grade failed, trying again", err);
        p.timer = setTimeout(() => send(clientId), holdMs);
      });
  };
  const flush = () => {
    for (const id of [...pending.keys()]) send(id, true);
  };

  return {
    source: "server",
    async load(book: ReaderBook): Promise<Loaded> {
      const r = await fetch(`${base}/items?g=paragraph&from=0&to=${book.lines.length}`);
      if (!r.ok) throw new Error(`items: HTTP ${r.status}`);
      const res = (await r.json()) as ItemsResponse;
      // Grades a page closed or went offline before sending: send them now.
      // Through the same retry loop as a fresh grade.
      for (const u of unsent.read().filter((x) => x.m === materialId)) {
        const id = u.req.clientId;
        if (!id || pending.has(id)) continue;
        const line = Math.max(-1, ...u.req.sentences.map((x) => parseSentenceId(x)?.line ?? -1));
        pending.set(id, { req: u.req, timer: setTimeout(() => {}, 0), inflight: true, line });
        send(id);
      }
      const out = blocksFromItems(res, book.headings, book.lines.length);
      sids = out.sids;
      for (const [k, g] of Object.entries(out.grades)) last.set(k, [g]);
      return { blocks: out.blocks, cuts: out.cuts, grades: out.grades };
    },
    lastGrade: (id) => last.get(id)?.at(-1) ?? null,
    async grade(_b, item, rating, info) {
      const clientId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const req: GradeRequest = {
        sentences: sids.get(item.id) ?? [],
        rating,
        granularity: "paragraph",
        swipedAt: new Date().toISOString(),
        ...(info?.shownAt ? { shownAt: new Date(info.shownAt).toISOString() } : {}),
        clientId,
      };
      if (req.sentences.length)
        pending.set(clientId, {
          req,
          timer: setTimeout(() => send(clientId), holdMs),
          inflight: false,
          line: Math.max(...item.pieces.map((p) => p.line)),
          ...(rating === 4 && info?.easyWords ? { words: info.easyWords } : {}),
          onSent: info?.onSent,
        });
      const l = last.get(item.id) ?? [];
      l.push(rating);
      last.set(item.id, l);
      return { itemId: item.id, rating, at: Date.now(), clientId };
    },
    canUndo: (r) => !!r.clientId && pending.get(r.clientId)?.inflight === false,
    async undo(_b, r) {
      if (!r.clientId) return;
      const p = pending.get(r.clientId);
      if (!p || p.inflight) return;
      clearTimeout(p.timer);
      pending.delete(r.clientId);
      const l = last.get(r.itemId);
      const i = l?.lastIndexOf(r.rating) ?? -1;
      if (l && i >= 0) l.splice(i, 1);
    },
    async revert(b, r) {
      if (!r.clientId) return;
      const p = pending.get(r.clientId);
      if (p && !p.inflight) return this.undo(b, r);
      // Sent (or on its way): the server restores its sentences (batch-grade undo).
      const l = last.get(r.itemId);
      const i = l?.lastIndexOf(r.rating) ?? -1;
      if (l && i >= 0) l.splice(i, 1);
      const res = await fetch(`${base}/batch-grade`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ undo: r.clientId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    async anchor(id) {
      const local = loadAnchor(id);
      try {
        const r = await fetch(`${base}/progress`);
        if (!r.ok) return local;
        const p = (await r.json()) as ProgressResponse;
        if (p.highLine !== null) highLine = p.highLine;
        const synced: Anchor | null = p.anchor
          ? { line: p.anchor.line, off: p.anchor.offset, at: Date.parse(p.anchor.at) || 0 }
          : null;
        // The same position as this device's copy keeps its piece (s).
        const pick = newestAnchor(local, synced);
        return pick === synced && local && local.line === synced?.line
          ? { ...synced, s: local.s }
          : pick;
      } catch {
        return local;
      }
    },
    saveAnchor(id, a, opts) {
      saveAnchor(id, a);
      const body: ProgressPut = {
        line: a.line,
        offset: a.off,
        at: new Date(a.at).toISOString(),
        // Only grades the server has move it (an undone one never does).
        ...(high() >= 0 ? { highLine: high() } : {}),
      };
      const json = JSON.stringify(body);
      if (opts?.leaving && typeof navigator !== "undefined" && navigator.sendBeacon) {
        navigator.sendBeacon(`${base}/progress`, json);
        return;
      }
      void fetch(`${base}/progress`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: json,
      }).catch(() => {});
    },
    flush,
  };
}

// The live end of a Google Doc (docs/connections.md, "Live stream"). The Docs
// page receives each edit on Google's own channel (its /bind stream), before
// the export has it: an insert {"ty":"is","ibi":<index>,"s":"<text>"}, a delete
// {"ty":"ds","si":<from>,"ei":<to>}. It is an undocumented format, so a chunk
// that holds neither simply gives nothing, and the export still saves the doc.
//
// A live doc is treated as append only: edits at the end grow the tail, a
// revision inside the tail applies, and anything earlier waits for the save.

export type TailOp = { i: number; s: string } | { si: number; ei: number };

export interface Tail {
  text: string;
  /** The doc's next index, learned from the first insert. */
  end: number | null;
}

export const EMPTY_TAIL: Tail = { text: "", end: null };

const OP = /\{"ty":"is","ibi":(\d+),"s":"((?:[^"\\]|\\.)*)"\}|\{"ty":"ds","si":(\d+),"ei":(\d+)\}/g;

/**
 * The edits in a chunk of the channel, and how much of it was read: what comes
 * after the last edit may be one still arriving, so the next read starts there.
 */
export function parseBindOps(chunk: string): { ops: TailOp[]; consumed: number } {
  const ops: TailOp[] = [];
  let consumed = 0;
  for (const m of chunk.matchAll(OP)) {
    consumed = (m.index ?? 0) + m[0].length;
    if (m[1] === undefined) {
      ops.push({ si: Number(m[3]), ei: Number(m[4]) });
      continue;
    }
    try {
      ops.push({ i: Number(m[1]), s: JSON.parse(`"${m[2]}"`) as string });
    } catch {
      // Not the text it looked like.
    }
  }
  return { ops, consumed };
}

/** Docs marks its own structure with control characters: they read as line breaks. */
const clean = (s: string) => s.replace(/[\u0000-\u0009\u000b-\u001f]+/g, "\n");

export function applyTailOps(tail: Tail, ops: readonly TailOp[]): Tail {
  let { text, end } = tail;
  for (const o of ops) {
    if ("s" in o) {
      end ??= o.i;
      const back = end - o.i;
      end += o.s.length;
      if (back <= 0) text += clean(o.s);
      else if (back <= text.length) {
        const at = text.length - back;
        text = text.slice(0, at) + clean(o.s) + text.slice(at);
      }
    } else if (end !== null) {
      const n = o.ei - o.si + 1;
      const back = end - o.si;
      end -= n;
      if (back > 0 && back <= text.length) {
        const at = text.length - back;
        text = text.slice(0, at) + text.slice(at + n);
      }
    }
  }
  return { text, end };
}

const squeeze = (s: string) => s.replace(/\s+/g, "");

/**
 * What of the tail the saved book does not hold yet. The export lags the
 * channel, so a save usually holds only the tail's start; and the book's lines
 * are cut anew, so spaces and line breaks are not compared.
 */
export function unsavedTail(bookEnd: string, tail: string): string {
  const book = squeeze(bookEnd);
  const t = squeeze(tail);
  if (!t) return "";
  if (book.includes(t)) return "";
  // The longest start of the tail that the book ends with. A few characters
  // can match by chance, so a shorter overlap does not count.
  let overlap = 0;
  for (let k = Math.min(book.length, t.length); k >= 4; k--) {
    if (book.endsWith(t.slice(0, k))) {
      overlap = k;
      break;
    }
  }
  if (!overlap) return tail;
  // Back to the tail's own characters, its line breaks kept.
  let seen = 0;
  for (let i = 0; i < tail.length; i++) {
    if (/\s/.test(tail[i])) continue;
    if (seen === overlap) return tail.slice(i);
    seen++;
  }
  return "";
}

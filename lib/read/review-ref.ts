// The paragraph word review in the URL (docs/ui-state.md; owner, 2026-11-05
// 01:30 JST: a refresh in the review dropped him back to the plain reader).
// `/read/<id>?review=<ref>` names what the review covers, so a refresh, Back
// and Forward and a shared link open it again. Its position (the card in focus,
// the list's scroll) is per tab, in sessionStorage, keyed by `reviewKey`.
//
// The ref uses the same addresses as the reader's deep links
// (lib/read/reader-select.ts): line and token indices in the book's `lines`.
// They stay the same when the content is loaded again, or when the same text
// is imported again.
//
// - `p<line>`: the paragraph. A word, a phrase or a sentence reviews its
//   paragraph, so they all write the paragraph's ref (one URL per review).
// - `r<l0>.<t0>-<l1>.<t1>`: a range he selected by hand, its own words.
// - `u<line>`: the wider review a passage's Hard grade opens
//   (lib/read/review-scope.ts): its chapter up to the passage ending on `line`.

import { RANGE_MAX_LINES, type Unit } from "./reader-select";

export const REVIEW_PARAM = "review";

/** What a review covers: a paragraph, or a range he selected by hand. */
export type ReviewTarget =
  | { kind: "para"; line: number }
  | { kind: "range"; l0: number; t0: number; l1: number; t1: number }
  | { kind: "upto"; line: number };

/** The ref of the chapter-up-to-here review (review-scope.ts), the passage ending on `line`. */
export const uptoRef = (line: number): string => `u${line}`;

/** The ref of the review a unit's card opens, or null when its card has no review. */
export function reviewRef(u: Unit): string | null {
  switch (u.kind) {
    case "word":
    case "phrase":
    case "sentence":
    case "para":
      return `p${u.line}`;
    case "range":
      return `r${u.l0}.${u.t0}-${u.l1}.${u.t1}`;
    default:
      return null;
  }
}

const N = "(0|[1-9]\\d{0,6})";
const PARA = new RegExp(`^p${N}$`);
const RANGE = new RegExp(`^r${N}\\.${N}-${N}\\.${N}$`);
const UPTO = new RegExp(`^u${N}$`);

/** The review a ref names, or null for anything else (as decodeUnit checks a range). */
export function decodeReviewRef(ref: string | null | undefined): ReviewTarget | null {
  if (!ref) return null;
  let m = PARA.exec(ref);
  if (m) return { kind: "para", line: +m[1] };
  m = UPTO.exec(ref);
  if (m) return { kind: "upto", line: +m[1] };
  m = RANGE.exec(ref);
  if (!m) return null;
  const [l0, t0, l1, t1] = [+m[1], +m[2], +m[3], +m[4]];
  if (l1 < l0 || (l1 === l0 && t1 <= t0) || l1 - l0 > RANGE_MAX_LINES) return null;
  return { kind: "range", l0, t0, l1, t1 };
}

/** The ref in a URL's query, if it names a review. */
export function reviewOfHref(href: string): string | null {
  const ref = new URL(href, "https://x.invalid").searchParams.get(REVIEW_PARAM);
  return decodeReviewRef(ref) ? ref : null;
}

/**
 * The same address with `?review=` set to `ref`, or without it for null:
 * path, query and fragment, the origin left out. Other parameters stay.
 */
export function withReview(href: string, ref: string | null): string {
  const u = new URL(href, "https://x.invalid");
  if (ref) u.searchParams.set(REVIEW_PARAM, ref);
  else u.searchParams.delete(REVIEW_PARAM);
  return `${u.pathname}${u.search}${u.hash}`;
}

/** The key the review's position is kept under in this tab (sessionStorage). */
export const reviewKey = (book: string, ref: string) => `review:${book}:${ref}`;

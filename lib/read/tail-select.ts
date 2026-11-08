// Selecting in a live Google Doc's tail (app/(app)/reader/[id]/reader-stream.tsx):
// the book's rules, for text not saved into the book yet. A tap is the word, the
// next taps of a combo its sentence and paragraph; a hand selection grows to
// whole sentences. Whole sentences are what is translated (select-translate.ts).
import type { Sentence } from "./reader-model";
import type { TransPlan } from "./select-translate";
import { normText } from "./translate";

export type TailUnit =
  | { kind: "word"; p: number; s: number; t: number }
  | { kind: "sentence"; p: number; s: number }
  | { kind: "para"; p: number }
  | { kind: "range"; p0: number; s0: number; p1: number; s1: number };

export type TailParas = readonly { sentences: readonly Sentence[] }[];

/** One tap further in a combo; the paragraph is as far as a tail goes. */
export function tailNext(u: TailUnit): TailUnit | null {
  if (u.kind === "word") return { kind: "sentence", p: u.p, s: u.s };
  if (u.kind === "sentence") return { kind: "para", p: u.p };
  return null;
}

/** Whether the token at (p, s, t) is inside the unit. */
export function tailHolds(u: TailUnit, p: number, s: number, t: number): boolean {
  if (u.kind === "word") return u.p === p && u.t === t;
  if (u.kind === "sentence") return u.p === p && u.s === s;
  if (u.kind === "para") return u.p === p;
  if (p < u.p0 || p > u.p1) return false;
  if (p === u.p0 && s < u.s0) return false;
  return !(p === u.p1 && s > u.s1);
}

/** A hand selection between two sentences, whichever way it was dragged. */
export function tailRange(
  a: { p: number; s: number },
  b: { p: number; s: number },
): Extract<TailUnit, { kind: "range" }> {
  const [x, y] = a.p < b.p || (a.p === b.p && a.s <= b.s) ? [a, b] : [b, a];
  return { kind: "range", p0: x.p, s0: x.s, p1: y.p, s1: y.s };
}

/** What a unit translates as: its whole sentences, a block per paragraph. A word is not translated. */
export function tailPlan(u: TailUnit | null, paras: TailParas): TransPlan | null {
  if (!u || u.kind === "word") return null;
  const [p0, s0, p1, s1] =
    u.kind === "sentence"
      ? [u.p, u.s, u.p, u.s]
      : u.kind === "para"
        ? [u.p, 0, u.p, Infinity]
        : [u.p0, u.s0, u.p1, u.s1];
  const plan: TransPlan = [];
  for (let p = p0; p <= p1; p++) {
    const ss = paras[p]?.sentences ?? [];
    const block = ss.flatMap((x, s) => {
      const text = normText(x.text);
      const inside = (p > p0 || s >= s0) && (p < p1 || s <= s1);
      return inside && text ? [{ level: "sentence" as const, line: p, s, text }] : [];
    });
    if (block.length) plan.push(block);
  }
  return plan.length ? plan : null;
}

/** How many of the newest sentences the card follows when nothing is selected. */
export const LATEST_SENTENCES = 3;

const FINISHED = /\p{Sentence_Terminal}["'”’」』)）]*\s*$/u;

/**
 * Nothing selected: the card follows the newest whole sentences. A sentence
 * still being written would ask again at every word, so it joins only once the
 * text rests (`resting`).
 */
export function latestPlan(paras: TailParas, resting: boolean): TransPlan | null {
  for (let p = paras.length - 1; p >= 0; p--) {
    const ss = paras[p].sentences;
    const block = ss.flatMap((x, s) => {
      const text = normText(x.text);
      const done = s < ss.length - 1 || resting || FINISHED.test(x.text);
      return text && done ? [{ level: "sentence" as const, line: p, s, text }] : [];
    });
    if (block.length) return [block.slice(-LATEST_SENTENCES)];
  }
  return null;
}

/** The markup a save sends: the book's lines and the tail, as the Docs parser reads them. */
export function tailHtml(lines: readonly string[], tail: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const all = [...lines, ...tail.split("\n")].filter((l) => l.trim());
  return `<html><body>${all.map((l) => `<p>${esc(l)}</p>`).join("")}</body></html>`;
}

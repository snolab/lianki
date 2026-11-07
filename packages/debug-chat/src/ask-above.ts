/**
 * The up-arrow over the chat's log: an ask card still open that has scrolled
 * off above the view (owner, 2026-11-06 15:32 JST, iPhone: "liagent 提问滑过屏幕，
 * 如果上面有未回答的问题，我们要显示一个向上箭头按钮，点击跳到未回答提问").
 *
 * The decisions, pure. The DOM side is ask-above-dom.ts: an IntersectionObserver
 * says which cards are above; the messages say which are still open, and the
 * hub's `answered` event (from any device) lands there as `answer`, so an answer
 * clears the card in the same render.
 */
import { type Ask, type AskAnswer, askState } from "./ask";

/**
 * A card ending this close under the log's top edge counts as gone: the log's
 * fade has already dissolved it (log-surface.ts FADE).
 */
export const ABOVE_INSET_PX = 24;
/** A jump puts the question this far under the top edge, clear of the fade (2.5rem). */
export const JUMP_INSET_PX = 44;
/** The button's height, and the gap between it and the bar. */
export const JUMP_H_PX = 32;
export const JUMP_GAP_PX = 4;
/** The button's end edge stays this far from the log's end: scroll-down's slot. */
export const JUMP_END_PX = 32;

/** The button's width: the arrow alone, or the count beside it. */
export const jumpWidth = (count: number) => (count > 1 ? (count > 9 ? 60 : 52) : 40);

/**
 * The room the newest run of lines keeps beside the button, at the log's end
 * (owner, 2026-11-07 18:10 JST: "滚动不在正确的位置，它的下面半个窗口是空的": a
 * whole empty row under the last line left the bottom of the 3-line log
 * blank). Not a row: room at the end side of the newest run, that run at
 * least the button's height, so the button covers no line or pill and the
 * newest line still sits at the log's bottom.
 */
export const jumpRoom = (count: number) => ({
  end: JUMP_END_PX + jumpWidth(count) + 6,
  minHeight: JUMP_H_PX + JUMP_GAP_PX,
});

/** The ids of the lines whose ask can still be answered, oldest first. */
export function openAskIds(
  messages: readonly { id: string; ask?: Ask; answer?: AskAnswer }[],
  now: number,
): string[] {
  return messages.filter((m) => m.ask && askState(m, now) === "open").map((m) => m.id);
}

/**
 * Whether a card IntersectionObserver reports is above the view: out of it, with
 * its bottom over the view's top. A card below the view (he scrolled up) is not,
 * and neither is one whose pills are still showing.
 */
export function isAbove(e: { isIntersecting: boolean; bottom: number; rootTop: number }): boolean {
  return !e.isIntersecting && e.bottom <= e.rootTop;
}

/** The open asks above the view, oldest first: `above` may hold ones answered since. */
export const asksAbove = (open: readonly string[], above: ReadonlySet<string>): string[] =>
  open.filter((id) => above.has(id));

/** The one a tap goes to: the nearest above the view is the newest of them. */
export const nearestAbove = (list: readonly string[]): string | null => list.at(-1) ?? null;

/** The scrollTop that puts a line JUMP_INSET_PX under the log's top edge. */
export function jumpTop(d: { scrollTop: number; lineTop: number; rootTop: number }): number {
  return Math.max(0, Math.round(d.scrollTop + d.lineTop - d.rootTop - JUMP_INSET_PX));
}

/** The button's label: `{count}` in the string is how many are above. */
export const jumpLabel = (template: string, count: number) =>
  template.replaceAll("{count}", String(count));

/**
 * Which agent lines are read aloud (docs/dev-debug-widget.md, "Quiet
 * lines"). Every agent line is shown; on top of voice.ts's own rules (the
 * mic, the speaker toggle, the focus rule) only two things keep one silent:
 *
 * 1. A hidden page (another tab, the app in the background, the screen
 *    locked: `document.visibilityState` "hidden") never speaks: the browser
 *    would not let it. The newest line kept silent this way is read once
 *    the page is visible again (voice.ts gateVoice), and the others show a
 *    "not read aloud" note.
 * 2. A quiet line (`say --quiet`: FYI, progress, deploy notices) is never
 *    read.
 * 3. A withdrawn ask card (eval.ts withdraw) is never read: by its
 *    `ask.withdrawnAt`, or by its id once the page heard {type:"withdrawn"}
 *    (markWithdrawn), for a line kept to read later from before it was.
 *
 * There is no time of day in it. Pure: unit/speak-rules.test.ts.
 */

/** What a line says about being read aloud (ChatMessage's fields). */
export type SpeakMeta = { id?: unknown; quiet?: unknown; ask?: unknown };

/** Quiet: `say --quiet`. An ask card is read like any other line. */
export const isQuiet = (m: SpeakMeta) => m.quiet === true;

/** Why a line is not read aloud: null = read it (by voice.ts's own rules). */
export type Silence = "hidden" | "quiet" | "withdrawn";

/** The ids of ask lines withdrawn while this page was open (shared by every copy of this module). */
const withdrawnIds = (): Set<string> => {
  const g = globalThis as unknown as { __lkWithdrawn?: Set<string> };
  return (g.__lkWithdrawn ??= new Set());
};
/** The page heard {type:"withdrawn"} for line `id`: it is never read from now on. */
export function markWithdrawn(id: string) {
  const s = withdrawnIds();
  s.add(id);
  if (s.size > 200) s.delete(s.values().next().value as string);
}
/** A withdrawn ask card (its own mark, or one the page heard about). */
export const isWithdrawn = (m: SpeakMeta) =>
  (typeof m.ask === "object" &&
    m.ask !== null &&
    (m.ask as { withdrawnAt?: unknown }).withdrawnAt !== undefined) ||
  (typeof m.id === "string" && withdrawnIds().has(m.id));

export function silenceFor(m: SpeakMeta, at: { hidden: boolean }): Silence | null {
  if (isQuiet(m)) return "quiet";
  if (isWithdrawn(m)) return "withdrawn";
  if (at.hidden) return "hidden";
  return null;
}

/** The page is hidden or the screen is locked (true without a document: never speak there). */
export const pageHidden = () =>
  typeof document === "undefined" || document.visibilityState === "hidden";

/** silenceFor with this page's visibility. */
export const silenceHere = (m: SpeakMeta = {}) => silenceFor(m, { hidden: pageHidden() });

/**
 * A key an older build saved on his devices (a time-of-day setting that is
 * gone). Removed once on load, so nothing of it is left behind.
 */
export const RETIRED_KEYS = ["lk:agent-quiet-hours"] as const;

/** Remove the retired keys from `store` (localStorage by default); safe to call any number of times. */
export function dropRetiredKeys(store?: Pick<Storage, "removeItem"> | null) {
  let s = store;
  if (s === undefined)
    try {
      s = globalThis.localStorage ?? null;
    } catch {
      s = null;
    }
  for (const k of RETIRED_KEYS)
    try {
      s?.removeItem(k);
    } catch {}
}

/**
 * One place in the page that hears "not enough credits" from any paid route
 * (lib/payments/metered.ts answers 402 with the `x-lianki-credits: needed`
 * header) and tells the user once, in their language, with a top-up link
 * (app/components/NoCreditsNotice.tsx).
 *
 * It wraps the page's own `fetch` once and only looks at the status and that
 * header — never the body, the URL's query or anything sent — so every paid
 * feature (reader, self-intro, word audio, the chat's mic, the labs) is
 * covered without each page learning about credits. Calls still get their
 * Response unchanged.
 */

/** The response header a credit refusal carries. */
export const CREDITS_HEADER = "x-lianki-credits";
export const CREDITS_NEEDED = "needed";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type WatchWin = { fetch: FetchLike };

const MARK = Symbol.for("lianki.no-credits-watch");

/** Is this a credit refusal? */
export const isNoCredits = (res: Pick<Response, "status" | "headers">) =>
  res.status === 402 && res.headers.get(CREDITS_HEADER) === CREDITS_NEEDED;

/**
 * Wrap `win.fetch` so `onNeeded` runs on each credit refusal. Returns the
 * undo; installing twice wraps once (the second call only adds its listener).
 */
export function installNoCreditsWatch(win: WatchWin, onNeeded: () => void): () => void {
  const host = win as WatchWin & { [MARK]?: Set<() => void> };
  let listeners = host[MARK];
  if (!listeners) {
    const set = new Set<() => void>();
    listeners = set;
    host[MARK] = set;
    const real = win.fetch.bind(win);
    win.fetch = async (input, init) => {
      const res = await real(input, init);
      if (isNoCredits(res)) for (const f of set) f();
      return res;
    };
  }
  listeners.add(onNeeded);
  return () => void listeners.delete(onNeeded);
}

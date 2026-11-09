/**
 * One place in the page that hears "not enough credits" from any paid route
 * (lib/payments/metered.ts answers 402 with the `x-lianki-credits: needed`
 * header) and tells the user once, in their language, with a top-up link
 * (app/components/NoCreditsNotice.tsx).
 *
 * It wraps the page's own `fetch` once and only looks at the status and the
 * headers (the kind, and the need / have / recommended numbers) — never the body, the URL's query or anything sent — so every paid
 * feature (reader, self-intro, word audio, the chat's mic, the labs) is
 * covered without each page learning about credits. Calls still get their
 * Response unchanged.
 */

/** The response header a credit refusal carries. */
export const CREDITS_HEADER = "x-lianki-credits";
export const CREDITS_NEEDED = "needed";
/** A paid feature paused (its price table outrun): "temporarily unavailable". */
export const CREDITS_PAUSED = "paused";
/** Whole credits: the minimum to start, the balance, the recommended to finish (lib/payments/metered.ts). */
export const CREDITS_NEED_HEADER = "x-lianki-credits-need";
export const CREDITS_HAVE_HEADER = "x-lianki-credits-have";
export const CREDITS_RECOMMENDED_HEADER = "x-lianki-credits-recommended";

/** The numbers a refusal carries, when it does. */
export type CreditsNumbers = { need: number; have: number; recommended: number };

/** A refusal's numbers from its headers (never the body); null when they are missing. */
export function creditsNumbers(res: Pick<Response, "headers">): CreditsNumbers | null {
  const n = (h: string) => {
    const v = res.headers.get(h);
    const x = v === null ? NaN : Number(v);
    return Number.isFinite(x) && x >= 0 ? x : null;
  };
  const need = n(CREDITS_NEED_HEADER);
  const have = n(CREDITS_HAVE_HEADER);
  if (need === null || have === null) return null;
  return { need, have, recommended: Math.max(need, n(CREDITS_RECOMMENDED_HEADER) ?? need) };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type WatchWin = { fetch: FetchLike };

const MARK = Symbol.for("lianki.no-credits-watch");

/** Is this a credit refusal? */
export const isNoCredits = (res: Pick<Response, "status" | "headers">) =>
  res.status === 402 && res.headers.get(CREDITS_HEADER) === CREDITS_NEEDED;

/** Which refusal: not enough credits (402), or the feature paused (503). */
export type CreditsRefusal = "needed" | "paused";
export function creditsRefusal(res: Pick<Response, "status" | "headers">): CreditsRefusal | null {
  if (isNoCredits(res)) return "needed";
  if (res.status === 503 && res.headers.get(CREDITS_HEADER) === CREDITS_PAUSED) return "paused";
  return null;
}

/**
 * Wrap `win.fetch` so `onNeeded` runs on each credit refusal (with which one).
 * Returns the undo; installing twice wraps once (the second call only adds its listener).
 */
export function installNoCreditsWatch(
  win: WatchWin,
  onNeeded: (kind: CreditsRefusal, numbers: CreditsNumbers | null) => void,
): () => void {
  type L = (kind: CreditsRefusal, numbers: CreditsNumbers | null) => void;
  const host = win as WatchWin & { [MARK]?: Set<L> };
  let listeners = host[MARK];
  if (!listeners) {
    const set = new Set<L>();
    listeners = set;
    host[MARK] = set;
    const real = win.fetch.bind(win);
    win.fetch = async (input, init) => {
      const res = await real(input, init);
      const kind = creditsRefusal(res);
      if (kind) {
        const numbers = kind === "needed" ? creditsNumbers(res) : null;
        for (const f of set) f(kind, numbers);
      }
      return res;
    };
  }
  listeners.add(onNeeded);
  return () => void listeners.delete(onNeeded);
}

/** The numbers line, or null without numbers (or without its strings). */
export function needText(
  s: { needLine?: string; needShort?: string },
  n: CreditsNumbers | null,
): string | null {
  if (!n) return null;
  const fill = (t: string, v: Record<string, number>) =>
    Object.entries(v).reduce((o, [k, x]) => o.replaceAll(`{${k}}`, String(x)), t);
  if (n.recommended > n.need && s.needLine)
    return fill(s.needLine, { need: n.need, recommended: n.recommended, have: n.have });
  if (s.needShort) return fill(s.needShort, { need: n.need, short: Math.max(0, n.need - n.have) });
  return null;
}

/**
 * Where this page sits: the top window, a frame inside the same origin, or a
 * frame inside some other site. A lianki.com page framed by another site must
 * never open the owner's cookie socket nor show pairing / Allow UI: the
 * parent could clickjack an eval grant (docs/dev-debug-widget.md, "The frame").
 * Unknown counts as foreign.
 */
export type FrameContext = "top" | "same" | "foreign";

type WinLike = {
  self?: unknown;
  top?: unknown;
  location?: { origin?: string; ancestorOrigins?: ArrayLike<string> };
};

export function frameContext(w: WinLike | undefined = globalThis as WinLike): FrameContext {
  try {
    if (!w || w.self === w.top) return "top";
    const own = w.location?.origin;
    const anc = w.location?.ancestorOrigins;
    if (anc && own) {
      for (let i = 0; i < anc.length; i++) if (anc[i] !== own) return "foreign";
      return anc.length > 0 ? "same" : "foreign";
    }
    // No ancestorOrigins (Firefox): reading a cross-origin top's origin throws.
    const top = w.top as { location?: { origin?: string } } | undefined;
    return top?.location?.origin === own ? "same" : "foreign";
  } catch {
    return "foreign";
  }
}

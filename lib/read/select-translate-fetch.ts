// The selection card's translation, one unit at a time (the hook:
// app/(app)/read/[id]/use-select-translate.ts). From our API (POST
// /api/read/[id]/translate — its shared cache, limiter and charge), or, with
// the user's own AI on (docs/byok.md), from this browser straight to their
// provider with their key: no Lianki credits, and the answer stays in this
// tab (`own:` keys) — never written to the shared read_translation cache,
// because our API is not called at all.
//
// A unit already translated in this tab is never asked for again, and one on
// its way is not asked for twice (a re-selection while it comes joins it).

import { transKey } from "./select-translate";
import { cleanTranslation, translateMessages } from "./translate";
import { activeByok, type ByokActive } from "@/lib/byok/config";
import { byokComplete, type ByokDeps } from "@/lib/byok/call";

/**
 * Translations of this tab, by transKey (`own:` + transKey for the user's own
 * AI): the device's side of the cache.
 */
export const translated = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

/** The cache key a unit is kept under, by who translated it. */
export const transKeyOf = (own: ByokActive | null, to: string, text: string) =>
  own ? `own:${transKey(to, text)}` : transKey(to, text);

/** The answer's ceiling, as the server's (lib/read/translate-server.ts). */
const maxTokens = (chars: number) => Math.min(8000, 200 + chars * 2);

/** One unit by the user's own AI, from this browser (lib/byok/call.ts). */
export async function translateOwn(
  own: ByokActive,
  to: string,
  from: string | undefined,
  text: string,
  deps?: ByokDeps,
): Promise<string | null> {
  const r = await byokComplete(
    own,
    translateMessages(text, to, from ?? null),
    { maxTokens: maxTokens(text.length), temperature: 0.2 },
    deps,
  );
  return r.ok ? cleanTranslation(r.text) || null : null;
}

export function fetchPiece(
  id: string,
  to: string,
  from: string | undefined,
  text: string,
  own: ByokActive | null = activeByok(),
) {
  const k = transKeyOf(own, to, text);
  const hit = translated.get(k);
  if (hit !== undefined) return Promise.resolve(hit);
  let p = inflight.get(k);
  if (!p) {
    p = (
      own
        ? translateOwn(own, to, from, text)
        : fetch(`/api/read/${id}/translate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, to, from }),
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((d: { text?: string } | null) => d?.text || null)
    )
      .then((out) => {
        if (out) translated.set(k, out);
        return out;
      })
      .catch(() => null)
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

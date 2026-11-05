"use client";

// The selection card's own translation (lib/read/select-translate.ts): the
// plan's units fetched from our API (POST /api/read/[id]/translate — its
// shared cache, limiter and charge), a few at a time, each shown as it lands.
// A unit already translated in this tab is never asked for again, and one
// on its way is not asked for twice (a re-selection while it comes joins it).
// Asked only once the selection rests (the combo interval), so the levels a
// quick combo passes through cost nothing.
//
// No Translate button (owner, 2026-11-05 02:11 JST): past the bound, the
// card asks for the next stretch by itself (`more`: when he scrolls the
// translation to its end, or when what came fits without scrolling), and a
// failure is retried by a tap on its own error line (`retry`).

import { useCallback, useEffect, useMemo, useState } from "react";
import { COMBO_MS } from "@/lib/read/reader-select";
import {
  AUTO_TRANSLATE_CHARS,
  autoPieces,
  transKey,
  type TransPiece,
  type TransPlan,
} from "@/lib/read/select-translate";
import { cleanTranslation, translateMessages } from "@/lib/read/translate";
import { activeByok, type ByokActive } from "@/lib/byok/config";
import { byokComplete } from "@/lib/byok/call";
import type { CardTranslation } from "./reader-select-card";

// With the user's own AI on (docs/byok.md), each unit goes from this browser
// straight to their provider with their key instead: no Lianki credits, and
// the answer stays in this tab (`own:` keys) — never written to the shared
// read_translation cache, because our API is not called at all.

/**
 * Translations of this tab, by transKey (`own:` + transKey for the user's own
 * AI): the device's side of the cache.
 */
const done = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

/** The cache key a unit is kept under, by who translated it. */
const keyOf = (own: ByokActive | null, to: string, text: string) =>
  own ? `own:${transKey(to, text)}` : transKey(to, text);

/** The answer's ceiling, as the server's (lib/read/translate-server.ts). */
const maxTokens = (chars: number) => Math.min(8000, 200 + chars * 2);

/** One unit by the user's own AI, from this browser (lib/byok/call.ts). */
export async function translateOwn(
  own: ByokActive,
  to: string,
  from: string | undefined,
  text: string,
  deps?: Parameters<typeof byokComplete>[3],
): Promise<string | null> {
  const r = await byokComplete(
    own,
    translateMessages(text, to, from ?? null),
    { maxTokens: maxTokens(text.length), temperature: 0.2 },
    deps,
  );
  return r.ok ? cleanTranslation(r.text) || null : null;
}

/** Requests in flight for one selection: the units still come in reading order, quickly. */
const LANES = 3;

export function fetchPiece(
  id: string,
  to: string,
  from: string | undefined,
  text: string,
  own: ByokActive | null = activeByok(),
) {
  const k = keyOf(own, to, text);
  const hit = done.get(k);
  if (hit !== undefined) return Promise.resolve(hit);
  let p = inflight.get(k);
  if (!p && own) {
    p = translateOwn(own, to, from, text)
      .then((out) => {
        if (out) done.set(k, out);
        return out;
      })
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  if (!p) {
    p = fetch(`/api/read/${id}/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, to, from }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { text?: string } | null) => {
        if (!d?.text) return null;
        done.set(k, d.text);
        return d.text;
      })
      .catch(() => null)
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

export function useSelectTranslate(
  id: string,
  to: string,
  from: string | undefined,
  plan: TransPlan | null,
) {
  /** The user's own AI, read when the plan changes (a settings change applies to the next selection). */
  const own = useMemo(() => (plan ? activeByok() : null), [plan]);
  const key = useCallback((p: TransPiece) => keyOf(own, to, p.text), [own, to]);
  /** A unit's text; null on its way; false not asked (past the bound) or failed. */
  const [got, setGot] = useState<Record<string, string | null | false>>({});
  const [failed, setFailed] = useState(false);
  /** Stretches of the bound asked for (1: the first, by itself); and retries of failures. */
  const [room, setRoom] = useState(1);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    setRoom(1);
    setTries(0);
  }, [plan]);
  useEffect(() => {
    setFailed(false);
    if (!plan) return setGot({});
    let live = true;
    const all = plan.flat();
    const want = autoPieces(plan, AUTO_TRANSLATE_CHARS * room);
    const init: Record<string, string | null | false> = {};
    for (const p of all) init[key(p)] = done.get(key(p)) ?? (want.has(p) ? null : false);
    setGot(init);
    const queue = all.filter((p) => want.has(p) && !done.has(key(p)));
    let next = 0;
    const lane = async () => {
      while (live && next < queue.length) {
        const p = queue[next++];
        const out = await fetchPiece(id, to, from, p.text, own);
        if (!live) return;
        if (out === null) setFailed(true);
        setGot((g) => ({ ...g, [key(p)]: out ?? false }));
      }
    };
    // A combo passes through smaller units on its way up: only the one it
    // rests on is asked for (a further stretch or a retry asks at once).
    const start = () => {
      for (let i = 0; i < Math.min(LANES, queue.length); i++) void lane();
    };
    const first = room === 1 && tries === 0;
    const timer = queue.length ? setTimeout(start, first ? COMBO_MS : 0) : null;
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [plan, room, tries, id, to, from, key, own]);

  const translation = useMemo<CardTranslation | null>(
    () =>
      plan ? { blocks: plan.map((b) => b.map((p) => got[key(p)] ?? false)), own: !!own } : null,
    [plan, got, key, own],
  );
  const pending = Object.values(got).includes(null);
  /** Pieces past what is asked for (never a failed one: that is `retry`'s). */
  const rest =
    !!plan && !failed && !pending && plan.some((b) => b.some((p) => got[key(p)] === false));
  const more = useCallback(() => setRoom((n) => n + 1), []);
  const retry = useCallback(() => setTries((n) => n + 1), []);
  return { translation, failed, more: rest ? more : null, retry };
}

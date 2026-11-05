"use client";

// The selection card's own translation (lib/read/select-translate.ts): the
// plan's units fetched one by one (lib/read/select-translate-fetch.ts: our
// API, or the user's own AI from this browser — docs/byok.md), a few at a
// time, each shown as it lands. Asked only once the selection rests (the
// combo interval), so the levels a quick combo passes through cost nothing.
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
  type TransPiece,
  type TransPlan,
} from "@/lib/read/select-translate";
import { fetchPiece, transKeyOf, translated } from "@/lib/read/select-translate-fetch";
import { activeByok } from "@/lib/byok/config";
import type { CardTranslation } from "./reader-select-card";

/** Requests in flight for one selection: the units still come in reading order, quickly. */
const LANES = 3;

export function useSelectTranslate(
  id: string,
  to: string,
  from: string | undefined,
  plan: TransPlan | null,
) {
  /** The user's own AI, read when the plan changes (a settings change applies to the next selection). */
  const own = useMemo(() => (plan ? activeByok() : null), [plan]);
  const key = useCallback((p: TransPiece) => transKeyOf(own, to, p.text), [own, to]);
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
    for (const p of all) init[key(p)] = translated.get(key(p)) ?? (want.has(p) ? null : false);
    setGot(init);
    const queue = all.filter((p) => want.has(p) && !translated.has(key(p)));
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

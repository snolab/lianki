"use client";

// The selection card's own translation (lib/read/select-translate.ts): the
// plan's units fetched from our API (POST /api/read/[id]/translate — its
// shared cache, limiter and charge), a few at a time, each shown as it lands.
// A unit already translated in this tab is never asked for again, and one
// on its way is not asked for twice (a re-selection while it comes joins it).
// Asked only once the selection rests (the combo interval), so the levels a
// quick combo passes through cost nothing.

import { useCallback, useEffect, useMemo, useState } from "react";
import { COMBO_MS } from "@/lib/read/reader-select";
import { autoPieces, transKey, type TransPiece, type TransPlan } from "@/lib/read/select-translate";
import type { CardTranslation } from "./reader-select-card";

/** Translations of this tab, by transKey: the device's side of the cache. */
const done = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

/** Requests in flight for one selection: the units still come in reading order, quickly. */
const LANES = 3;

function fetchPiece(id: string, to: string, from: string | undefined, text: string) {
  const k = transKey(to, text);
  const hit = done.get(k);
  if (hit !== undefined) return Promise.resolve(hit);
  let p = inflight.get(k);
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
  const key = useCallback((p: TransPiece) => transKey(to, p.text), [to]);
  /** A unit's text; null on its way; false not asked (past the bound) or failed. */
  const [got, setGot] = useState<Record<string, string | null | false>>({});
  const [failed, setFailed] = useState(false);
  /** Taps on Translate for this plan: each asks for every unit not there yet. */
  const [asks, setAsks] = useState(0);
  useEffect(() => setAsks(0), [plan]);

  useEffect(() => {
    setFailed(false);
    if (!plan) return setGot({});
    let live = true;
    const all = plan.flat();
    const want = asks > 0 ? new Set(all) : autoPieces(plan);
    const init: Record<string, string | null | false> = {};
    for (const p of all) init[key(p)] = done.get(key(p)) ?? (want.has(p) ? null : false);
    setGot(init);
    const queue = all.filter((p) => want.has(p) && !done.has(key(p)));
    let next = 0;
    const lane = async () => {
      while (live && next < queue.length) {
        const p = queue[next++];
        const out = await fetchPiece(id, to, from, p.text);
        if (!live) return;
        if (out === null) setFailed(true);
        setGot((g) => ({ ...g, [key(p)]: out ?? false }));
      }
    };
    // A combo passes through smaller units on its way up: only the one it
    // rests on is asked for (a tap on Translate asks at once).
    const start = () => {
      for (let i = 0; i < Math.min(LANES, queue.length); i++) void lane();
    };
    const timer = queue.length ? setTimeout(start, asks > 0 ? 0 : COMBO_MS) : null;
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [plan, asks, id, to, from, key]);

  const translation = useMemo<CardTranslation | null>(
    () => (plan ? { blocks: plan.map((b) => b.map((p) => got[key(p)] ?? false)) } : null),
    [plan, got, key],
  );
  const missing = !!plan && plan.some((b) => b.some((p) => got[key(p)] === false));
  const more = useCallback(() => setAsks((n) => n + 1), []);
  return { translation, failed, more: missing ? more : null };
}

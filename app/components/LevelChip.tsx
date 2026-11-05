"use client";

/**
 * The learner level chip next to the avatar in the top bar (docs/levels.md,
 * "Showing it"): the 20px badge, with the level name beside it from `sm` up
 * (phones get the badge alone, so the bar is not crowded). Links to /profile,
 * where the level card is. Rendered by AppShell only for a signed-in user when
 * the server says levels are on (`levelsOn`).
 *
 * One GET /api/levels/me per tab, kept in memory for a short while (business
 * data stays out of sessionStorage, docs/ui-state.md); no polling — a page
 * load after that reads it again.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import type { LevelId } from "@/lib/levels";
import type { LevelView } from "@/lib/level-progress";
import { LevelBadge } from "./level-badge";

const TTL_MS = 60_000;
let cached: { at: number; p: Promise<LevelView | null> } | null = null;

/** The caller's level, fetched at most once per TTL per tab; null when hidden or failing. */
export function fetchMyLevel(now = Date.now()): Promise<LevelView | null> {
  if (cached && now - cached.at < TTL_MS) return cached.p;
  const p = fetch("/api/levels/me", { credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<LevelView>) : null))
    .catch(() => null);
  cached = { at: now, p };
  return p;
}

export function LevelChip() {
  const [level, setLevel] = useState<LevelId | null>(null);
  const names = useIntlayer("learner-levels");
  const ui = useIntlayer("learner-level-ui");
  useEffect(() => {
    let live = true;
    void fetchMyLevel().then((v) => {
      if (live && v?.level) setLevel(v.level);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!level) return null;
  const name = names[level].value;
  return (
    <Link
      href="/profile"
      data-level-chip={level}
      aria-label={ui.chipLabel.value.replace("{level}", name)}
      title={name}
      className="inline-flex items-center justify-center gap-1 h-7 w-7 -mx-1 sm:mx-0 sm:w-auto sm:px-1 sm:pe-2 rounded-full sm:border border-[var(--glass-line)] text-xs font-medium hover:opacity-80 transition-opacity shrink-0"
    >
      <LevelBadge level={level} size={20} />
      <span aria-hidden="true" className="hidden sm:inline max-w-[6rem] truncate">
        {name}
      </span>
    </Link>
  );
}

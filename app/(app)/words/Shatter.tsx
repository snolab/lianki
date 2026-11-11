"use client";

import { type CSSProperties, useMemo } from "react";
import { crackPattern, SHATTER_H, SHATTER_W } from "@/lib/words/shatter";

/**
 * Cracked glass over a slip that can no longer be swiped (flag `words.shatter`,
 * lib/words/shatter.ts): its countdown ended and it reads "↓ back". Drawn under
 * the slip's text (z-index −1 inside the slip's stacking context) and above
 * its paper, so the text keeps its contrast.
 *
 * `live`: the countdown ended while this row was on screen — the cracks run
 * out from the impact once (CSS, ~0.6 s). A row mounted already ended (scrolled
 * back in, a reload) shows the cracks at rest. Reduced motion: at rest always.
 * Idle, it is a static SVG: no timer, no frame callback.
 */
export function Shatter({ seed, live }: { seed: string; live: boolean }) {
  const g = useMemo(() => crackPattern(seed), [seed]);
  const lines = (cls: string) => (
    <g className={cls}>
      {g.rays.map((p, k) => (
        <path key={`r${k}`} d={p} />
      ))}
      {g.ring.map((p, k) => (
        <path key={`g${k}`} d={p} />
      ))}
      {g.twigs.map((p, k) => (
        <path key={`t${k}`} d={p} />
      ))}
    </g>
  );
  return (
    <span
      aria-hidden
      className={`lk-shatter ${live ? "lk-shatter-live" : ""}`}
      data-shatter={live ? "live" : "rest"}
      style={
        {
          "--crack-x": `${(g.at.x * 100).toFixed(1)}%`,
          "--crack-y": `${(g.at.y * 100).toFixed(1)}%`,
        } as CSSProperties
      }
    >
      <svg viewBox={`0 0 ${SHATTER_W} ${SHATTER_H}`} preserveAspectRatio="none">
        {lines("lk-crack-shade")}
        {lines("lk-crack-glint")}
      </svg>
      {live && <i className="lk-shatter-hit" />}
    </span>
  );
}

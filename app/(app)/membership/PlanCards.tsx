"use client";

// Material skins for the Free / Pro plan cards on /membership (presentation
// only). Preview: /membership?card=paper|wood|marble; without the parameter
// the page is unchanged. Styles: ./plan-cards.css; textures:
// public/membership/*.svg (scripts/gen-membership-materials.ts).

import { useEffect, useState } from "react";
import "./plan-cards.css";

export const PLAN_SKINS = ["paper", "wood", "marble"] as const;
export type PlanSkin = (typeof PLAN_SKINS)[number];

/** The ?card= preview skin, or null for the current cards. */
export function usePlanSkin(): PlanSkin | null {
  const [skin, setSkin] = useState<PlanSkin | null>(null);
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("card");
    setSkin(PLAN_SKINS.find((s) => s === v) ?? null);
  }, []);
  return skin;
}

/** Shared SVG filters: dry brush (飞白) for the stroke, a rough edge for marks. */
export function PlanDefs() {
  return (
    <svg aria-hidden width="0" height="0" className="absolute">
      <filter id="lk-plan-feibai" x="0" y="-40%" width="100%" height="180%">
        <feTurbulence type="fractalNoise" baseFrequency=".015 .9" numOctaves="2" seed="5" />
        <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  9 0 0 0 -5.1" result="gaps" />
        <feComposite in="SourceGraphic" in2="gaps" operator="out" result="dry" />
        <feTurbulence type="fractalNoise" baseFrequency=".5" numOctaves="2" seed="8" />
        <feDisplacementMap in="dry" scale="1.6" />
      </filter>
      <filter id="lk-plan-rough" x="-10%" y="-10%" width="120%" height="120%">
        <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="2" />
        <feDisplacementMap in="SourceGraphic" scale=".9" />
      </filter>
    </svg>
  );
}

// Hand-drawn brush tick and cross, filled shapes (tapered like a brush).
const TICK =
  "M3.2 12.6c1.3-.9 2.5-.4 3.4.7l2.6 3.3c2.9-4.6 6.6-8.7 11.3-11.9.5-.3 1 .2.6.6-4.2 3.9-7.5 8.6-10.3 13.6-.5.9-1.6 1-2.2.2L3 14.2c-.4-.5-.3-1.2.2-1.6z";
const CROSS = [
  "M5 5.6c.6-.7 1.6-.6 2.2 0l11.6 12c.5.5.3 1.4-.4 1.6-.6.2-1.2 0-1.6-.4L4.9 7.6c-.5-.6-.5-1.4.1-2z",
  "M18.6 4.6c.5.4.6 1.1.2 1.6L7.4 19.2c-.5.6-1.4.7-2 .1-.5-.5-.5-1.2-.1-1.7L16.9 4.7c.5-.5 1.2-.5 1.7-.1z",
];

export function PlanMark({ no }: { no?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="lk-plan-mark" data-no={no || undefined}>
      <g filter="url(#lk-plan-rough)">
        {(no ? CROSS : [TICK]).map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

/** A dry-brush sweep under the title (paper only; hidden by CSS elsewhere). */
export function PlanStroke() {
  return (
    <svg aria-hidden viewBox="0 0 200 16" preserveAspectRatio="none" className="lk-plan-stroke">
      <path
        filter="url(#lk-plan-feibai)"
        d="M2 9c20-5 60-7 110-6 30 .6 60 2 86 4 1.5.1 1.6 2 .1 2.2-40 2.6-90 3.4-140 3.2-20 0-40-.6-54-1.4C1 10.8.6 9.5 2 9z"
      />
    </svg>
  );
}

/** The material behind a card's text: the sheet carries the shadow, the face
 * the texture (and on paper the deckled mask), so the text casts no shadow. */
export function PlanSurface() {
  return (
    <span aria-hidden className="lk-plan-sheet">
      <span className="lk-plan-face" />
    </span>
  );
}

/** The brand seal (public/icon.svg) — stamped on paper, inlaid in wood and stone. */
export function PlanChop() {
  return (
    <span aria-hidden className="lk-plan-chop">
      {/* oxlint-disable-next-line nextjs/no-img-element -- a 6KB SVG, no optimisation to gain */}
      <img src="/icon.svg" alt="" width={56} height={56} />
    </span>
  );
}

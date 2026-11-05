/**
 * Learner level badges (lib/levels.ts, docs/levels.md): one hand-drawn lotus
 * stage per level, in ink and seal red — seed in the mud → roots → a stem
 * through the water → a bud → the open flower → the full lotus in an ensō
 * halo. The same badge serves every locale; the level's name is never drawn
 * in it (it comes from the "learner-levels" dictionary and sits beside it).
 *
 * Colours: ink is `currentColor` (or `--lk-badge-ink`), seal is
 * `--lk-badge-seal`, falling back to `--brand` — both already flip for dark
 * mode in app/globals.css. Shapes are filled brush strokes sized so the
 * thinnest still covers about a pixel at 20px. `locked` draws the same
 * silhouette in faint ink only: a level not reached yet.
 *
 * Original artwork, drawn for Lianki (no third-party art).
 */
import type { CSSProperties, ReactNode } from "react";
import type { LevelId } from "@/lib/levels";

type Paint = { ink: string; seal: string };

/** Ground (mud) and water: the same two brush strokes on every badge. */
const GROUND =
  "M4 41 C12 38.6 20 39.6 26 39.2 C33 38.8 39 39.4 44 40.6 C39 42.8 32 42.2 25 42.6 C17 43 10 43.2 4 41Z";
const WATER =
  "M5 25 C12 23 17 25.4 24 24.2 C31 23 36 25 43 24 C36 26.8 31 25.2 24 26.4 C17 27.6 12 25.6 5 25Z";
const ROOTS = [
  "M22.6 40.4 C21 42.8 18.4 44.6 15.4 45.8 C18.8 45.4 22 43.6 24.2 41Z",
  "M23.6 41 C24 43 23.4 45 22.8 47 C24.6 45.4 25.6 43.4 25.4 41Z",
  "M25 40.6 C27.2 42.6 30 44.2 33 45 C30.4 43.2 27.8 41.6 26.6 40Z",
];
const PAD_LEFT = "M6.5 24.8 C9.5 21.2 17.5 21 21 24.4 C17 26 10.5 26.2 6.5 24.8Z";
const PAD_RIGHT = "M27 24.4 C30.5 21 38.5 21.2 41.5 24.8 C37.5 26.2 31 26 27 24.4Z";

function Seed({ cy, r, p }: { cy: number; r: number; p: Paint }) {
  return (
    <ellipse
      cx={24}
      cy={cy}
      rx={r * 0.75}
      ry={r}
      transform={`rotate(-25 24 ${cy})`}
      fill={p.seal}
    />
  );
}

function Ground({ p, roots }: { p: Paint; roots: number }) {
  return (
    <>
      <path d={GROUND} fill={p.ink} />
      {ROOTS.slice(0, roots).map((d) => (
        <path key={d} d={d} fill={p.ink} />
      ))}
    </>
  );
}

const Water = ({ p }: { p: Paint }) => <path d={WATER} fill={p.ink} opacity={0.5} />;

/** A tapered stem from the mud up to `top`. */
const Stem = ({ top, p }: { top: number; p: Paint }) => (
  <path
    d={`M22.9 40 C23.2 33 23.7 ${top + 6} 24.3 ${top} C24.8 ${top + 6} 25.3 33 25.5 40Z`}
    fill={p.ink}
  />
);

const STAGES: Record<LevelId, (p: Paint) => ReactNode> = {
  // 1 Seed — a seed resting in the mud, deep under the water.
  lv1: (p) => (
    <>
      <Water p={p} />
      <Ground p={p} roots={0} />
      <Seed cy={34.2} r={6} p={p} />
      <circle cx={13} cy={45.2} r={1} fill={p.ink} opacity={0.6} />
      <circle cx={34.5} cy={45.6} r={0.9} fill={p.ink} opacity={0.6} />
    </>
  ),
  // 2 Root — roots down into the mud, a first sprout reaching for the water.
  lv2: (p) => (
    <>
      <Water p={p} />
      <path d="M24.4 33 C25.4 30.4 25 28.8 23.2 27.6 C26 28.2 27.4 30.2 26.4 33.4Z" fill={p.ink} />
      <Ground p={p} roots={3} />
      <Seed cy={36.4} r={4} p={p} />
    </>
  ),
  // 3 Stem — the stem through the water, a young leaf unrolling, a pad afloat.
  lv3: (p) => (
    <>
      <Water p={p} />
      <path d={PAD_RIGHT} fill={p.ink} />
      <Stem top={12} p={p} />
      <path d="M24.3 12 C20.4 10.8 17.4 13 17.8 16.8 C20.2 14.8 22.4 14.4 24.3 12Z" fill={p.ink} />
      <Ground p={p} roots={3} />
      <circle cx={24.2} cy={39.2} r={2.2} fill={p.seal} />
    </>
  ),
  // 4 Bud — a closed bud held up on its stem, sepals in ink.
  lv4: (p) => (
    <>
      <Water p={p} />
      <path d={PAD_LEFT} fill={p.ink} />
      <Stem top={17.5} p={p} />
      <Ground p={p} roots={3} />
      <path d="M24.3 18.2 C19.2 16.8 19 10 24 3.6 C29.2 10 29.2 16.8 24.3 18.2Z" fill={p.seal} />
      <path
        d="M24.3 18.6 C21.6 18.2 20 16.8 19.4 14.6 C21.2 16 22.8 16.6 24.3 16.6Z"
        fill={p.ink}
      />
      <path
        d="M24.3 18.6 C27 18.2 28.6 16.8 29.2 14.6 C27.4 16 25.8 16.6 24.3 16.6Z"
        fill={p.ink}
      />
    </>
  ),
  // 5 Bloom — the flower opening: three petals, pads on both sides.
  lv5: (p) => (
    <>
      <Water p={p} />
      <path d={PAD_LEFT} fill={p.ink} />
      <path d={PAD_RIGHT} fill={p.ink} />
      <Stem top={20} p={p} />
      <Ground p={p} roots={3} />
      <path d="M23.6 20.4 C18 20.2 13.6 16.6 12 10.6 C17.6 11.2 22 14.8 23.6 20.4Z" fill={p.seal} />
      <path d="M24.4 20.4 C30 20.2 34.4 16.6 36 10.6 C30.4 11.2 26 14.8 24.4 20.4Z" fill={p.seal} />
      <path d="M24 20.6 C20.4 17.4 20.6 11 24 5.4 C27.4 11 27.6 17.4 24 20.6Z" fill={p.seal} />
    </>
  ),
  // 6 Lotus — the full flower, five petals, inside an ensō halo.
  lv6: (p) => (
    <>
      <circle
        cx={24}
        cy={14.5}
        r={13.5}
        fill="none"
        stroke={p.seal}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeDasharray="74 11"
        transform="rotate(-62 24 14.5)"
        opacity={0.6}
      />
      <Water p={p} />
      <path d={PAD_LEFT} fill={p.ink} />
      <path d={PAD_RIGHT} fill={p.ink} />
      <Stem top={22} p={p} />
      <Ground p={p} roots={3} />
      <path d="M23 22.6 C17.2 22.8 11.4 20.2 8.2 15 C14 15.2 19.8 17.6 23 22.6Z" fill={p.seal} />
      <path d="M25 22.6 C30.8 22.8 36.6 20.2 39.8 15 C34 15.2 28.2 17.6 25 22.6Z" fill={p.seal} />
      <path d="M23.4 22.2 C18.8 20.6 15.8 15 16 8.4 C20.4 11.4 23 16 23.4 22.2Z" fill={p.seal} />
      <path d="M24.6 22.2 C29.2 20.6 32.2 15 32 8.4 C27.6 11.4 25 16 24.6 22.2Z" fill={p.seal} />
      <path d="M24 22.4 C20.4 19 20.6 11.6 24 5.6 C27.4 11.6 27.6 19 24 22.4Z" fill={p.seal} />
    </>
  ),
};

export type LevelBadgeProps = {
  level: LevelId;
  /** Square size in px (20 for a nav chip, 96 on the profile). */
  size?: number;
  /** Not reached yet: the same drawing in faint ink, no seal red. */
  locked?: boolean;
  /** The level's name, as the image's accessible name; without it the badge is decorative. */
  label?: string;
  className?: string;
  style?: CSSProperties;
};

export function LevelBadge({
  level,
  size = 48,
  locked = false,
  label,
  className,
  style,
}: LevelBadgeProps) {
  const ink = "var(--lk-badge-ink, currentColor)";
  const paint: Paint = locked
    ? { ink, seal: ink }
    : { ink, seal: "var(--lk-badge-seal, var(--brand, oklch(0.53 0.207 22.3)))" };
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={className}
      style={style}
      data-level={level}
      data-locked={locked || undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <g opacity={locked ? 0.28 : 1}>{STAGES[level](paint)}</g>
    </svg>
  );
}

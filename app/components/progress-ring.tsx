/**
 * The thin progress ring of a /words list row, shared with /read's books (a
 * book counts as a deck). `pct` 0–100; `passAt` 0–100 draws the pass mark as
 * a short tick across the track. Decorative: the caller labels it.
 */
export function ProgressRingSvg({ pct, passAt }: { pct: number; passAt?: number }) {
  // r = 8 in a 20×20 box: the circumference, for the dash.
  const c = 2 * Math.PI * 8;
  const a = passAt != null ? (passAt / 100) * 2 * Math.PI : null;
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 -rotate-90" aria-hidden>
      <circle
        cx="10"
        cy="10"
        r="8"
        fill="none"
        strokeWidth="2.5"
        className="stroke-[oklch(0.5_0_0/0.18)] dark:stroke-[oklch(0.8_0_0/0.18)]"
      />
      {pct > 0 && (
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${(c * pct) / 100} ${c}`}
          className="stroke-[oklch(0.58_0.14_155)] dark:stroke-[oklch(0.76_0.14_155)]"
        />
      )}
      {a != null && (
        <line
          x1={10 + 6 * Math.cos(a)}
          y1={10 + 6 * Math.sin(a)}
          x2={10 + 10 * Math.cos(a)}
          y2={10 + 10 * Math.sin(a)}
          strokeWidth="1.2"
          data-pass-mark={passAt}
          className="stroke-[oklch(0.35_0_0)] dark:stroke-[oklch(0.92_0_0)]"
        />
      )}
    </svg>
  );
}

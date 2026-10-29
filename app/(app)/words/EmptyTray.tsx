/**
 * A card asleep in an empty tray: fills the list's over-scroll before the
 * first word and after the last. Decoration only (aria-hidden, no text); its
 * colours are the .lk-tray tokens in globals.css, light and dark.
 */
export function EmptyTray({ style }: { style?: React.CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      data-empty-tray
      className="lk-tray pointer-events-none absolute inset-x-0 flex items-center justify-center"
      style={style}
    >
      <svg
        viewBox="0 0 160 120"
        width="160"
        height="120"
        aria-hidden="true"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          d="M20 78 L36 54 H124 L140 78 Z"
          fill="var(--soft)"
          stroke="var(--ink)"
          strokeWidth="2.5"
        />
        <g transform="rotate(-6 80 62)">
          <rect
            x="52"
            y="44"
            width="56"
            height="38"
            rx="6"
            fill="var(--card)"
            stroke="var(--ink)"
            strokeWidth="2.5"
          />
          <path d="M67 60 q4 3 8 0 M85 60 q4 3 8 0" stroke="var(--ink)" strokeWidth="2.2" />
        </g>
        <path
          d="M20 78 H56 a6 6 0 0 1 6 6 a6 6 0 0 0 6 6 H92 a6 6 0 0 0 6 -6 a6 6 0 0 1 6 -6 H140 V96 a6 6 0 0 1 -6 6 H26 a6 6 0 0 1 -6 -6 Z"
          fill="var(--soft)"
          stroke="var(--ink)"
          strokeWidth="2.5"
        />
        <path
          d="M114 30 h8 l-8 9 h8 M128 16 h6 l-6 7 h6"
          stroke="var(--accent)"
          strokeWidth="2.2"
        />
      </svg>
    </div>
  );
}

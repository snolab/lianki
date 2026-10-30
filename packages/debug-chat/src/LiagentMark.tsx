/**
 * The liagent mark (a placeholder until a designer draws one): a rounded
 * speech bubble, tail at the bottom left, holding a lowercase "l" with a
 * spark at its top right, for the agent. currentColor plus one oklch accent,
 * so it reads in light and dark mode; meant for 16–24px.
 */
export function LiagentMark({
  size = 20,
  accent = "oklch(0.72 0.17 150)",
  title,
}: {
  size?: number;
  accent?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {/* The bubble: a rounded square whose bottom-left corner runs out into the tail. */}
      <path d="M7 3h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4h-7l-5 3v-3.6A4 4 0 0 1 3 14V7a4 4 0 0 1 4-4Z" />
      {/* The "l". */}
      <path d="M10.5 6.5v8" />
      {/* The spark: a four-point star at the l's top right. */}
      <path
        d="M15.5 5.6l.55 1.35 1.35.55-1.35.55-.55 1.35-.55-1.35-1.35-.55 1.35-.55Z"
        fill={accent}
        stroke={accent}
        strokeWidth={1}
      />
    </svg>
  );
}

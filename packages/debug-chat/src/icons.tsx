/**
 * The few icons the debug chat draws, so the package needs nothing from the
 * app: Phosphor Icons (https://phosphoricons.com), MIT License, Copyright (c)
 * 2023 Phosphor Icons. "regular" is the normal line, "fill" the on state.
 * `sparkle` is drawn here (a four-point star and a small one), not Phosphor's,
 * and so are `cornersOut` / `cornersIn` (full screen and its way back) and `pause`.
 */
const ICONS = {
  play: {
    regular:
      "M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27ZM80,215.94V40l143.83,88Z",
    fill: "M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z",
  },
  speakerHigh: {
    regular:
      "M155.51,24.81a8,8,0,0,0-8.42.88L77.25,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H77.25l69.84,54.31A8,8,0,0,0,160,224V32A8,8,0,0,0,155.51,24.81ZM32,96H72v64H32ZM144,207.64,88,164.09V91.91l56-43.55Zm54-106.08a40,40,0,0,1,0,52.88,8,8,0,0,1-12-10.58,24,24,0,0,0,0-31.72,8,8,0,0,1,12-10.58ZM248,128a79.9,79.9,0,0,1-20.37,53.34,8,8,0,0,1-11.92-10.67,64,64,0,0,0,0-85.33,8,8,0,1,1,11.92-10.67A79.83,79.83,0,0,1,248,128Z",
    fill: undefined,
  },
  sparkle: {
    regular:
      "M104,40Q112,136,200,144Q112,152,104,248Q96,152,8,144Q96,136,104,40ZM200,8Q204,48,244,52Q204,56,200,96Q196,56,156,52Q196,48,200,8Z",
    fill: undefined,
  },
  arrowUp: {
    regular:
      "M205.66,117.66a8,8,0,0,1-11.32,0L136,59.31V216a8,8,0,0,1-16,0V59.31L61.66,117.66a8,8,0,0,1-11.32-11.32l72-72a8,8,0,0,1,11.32,0l72,72A8,8,0,0,1,205.66,117.66Z",
    fill: undefined,
  },
  /** Full screen: four corners pointing outward (drawn here, rounded 16-unit strokes). */
  cornersOut: {
    regular:
      "M48,40h48a8,8,0,0,1,0,16H56V96a8,8,0,0,1-16,0V48A8,8,0,0,1,48,40ZM208,40H160a8,8,0,0,0,0,16h40V96a8,8,0,0,0,16,0V48A8,8,0,0,0,208,40ZM48,216H96a8,8,0,0,0,0-16H56V160a8,8,0,0,0-16,0v48A8,8,0,0,0,48,216Zm160,0H160a8,8,0,0,1,0-16h40V160a8,8,0,0,1,16,0v48A8,8,0,0,1,208,216Z",
    fill: undefined,
  },
  /** Back from full screen: the same corners, pointing inward. */
  cornersIn: {
    regular:
      "M96,40a8,8,0,0,1,8,8v48a8,8,0,0,1-8,8H48a8,8,0,0,1,0-16H88V48A8,8,0,0,1,96,40Zm64,0a8,8,0,0,0-8,8v48a8,8,0,0,0,8,8h48a8,8,0,0,0,0-16H168V48A8,8,0,0,0,160,40ZM96,216a8,8,0,0,0,8-8V160a8,8,0,0,0-8-8H48a8,8,0,0,0,0,16H88v40A8,8,0,0,0,96,216Zm64,0a8,8,0,0,1-8-8V160a8,8,0,0,1,8-8h48a8,8,0,0,1,0,16H168v40A8,8,0,0,1,160,216Z",
    fill: undefined,
  },
  /** Done (Phosphor "check"). */
  check: {
    regular:
      "M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z",
    fill: undefined,
  },
  /** Paused on someone (drawn here: two rounded bars). */
  pause: {
    regular:
      "M88,48h16a8,8,0,0,1,8,8V200a8,8,0,0,1-8,8H88a8,8,0,0,1-8-8V56A8,8,0,0,1,88,48Zm64,0h16a8,8,0,0,1,8,8V200a8,8,0,0,1-8,8H152a8,8,0,0,1-8-8V56A8,8,0,0,1,152,48Z",
    fill: undefined,
  },
  plus: {
    regular:
      "M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z",
    fill: undefined,
  },
  link: {
    regular:
      "M240,88.23a54.43,54.43,0,0,1-16,37L189.25,160a54.27,54.27,0,0,1-38.63,16h-.05A54.63,54.63,0,0,1,96,119.84a8,8,0,0,1,16,.45A38.62,38.62,0,0,0,150.58,160h0a38.39,38.39,0,0,0,27.31-11.31l34.75-34.75a38.63,38.63,0,0,0-54.63-54.63l-11,11A8,8,0,0,1,135.7,59l11-11A54.65,54.65,0,0,1,224,48,54.86,54.86,0,0,1,240,88.23ZM109,185.66l-11,11A38.41,38.41,0,0,1,70.6,208h0a38.63,38.63,0,0,1-27.29-65.94L78,107.31A38.63,38.63,0,0,1,144,135.71a8,8,0,0,0,16,.45A54.86,54.86,0,0,0,144,96a54.65,54.65,0,0,0-77.27,0L32,130.75A54.62,54.62,0,0,0,70.56,224h0a54.28,54.28,0,0,0,38.64-16l11-11A8,8,0,0,0,109,185.66Z",
    fill: undefined,
  },
  uploadSimple: {
    regular:
      "M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0ZM93.66,77.66,120,51.31V144a8,8,0,0,0,16,0V51.31l26.34,26.35a8,8,0,0,0,11.32-11.32l-40-40a8,8,0,0,0-11.32,0l-40,40A8,8,0,0,0,93.66,77.66Z",
    fill: undefined,
  },
  textAa: {
    regular:
      "M87.24,52.59a8,8,0,0,0-14.48,0l-64,136a8,8,0,1,0,14.48,6.81L39.9,160h80.2l16.66,35.4a8,8,0,1,0,14.48-6.81ZM47.43,144,80,74.79,112.57,144ZM200,96c-12.76,0-22.73,3.47-29.63,10.32a8,8,0,0,0,11.26,11.36c3.8-3.77,10-5.68,18.37-5.68,13.23,0,24,9,24,20v3.22A42.76,42.76,0,0,0,200,128c-22.06,0-40,16.15-40,36s17.94,36,40,36a42.73,42.73,0,0,0,24-7.25,8,8,0,0,0,16-.75V132C240,112.15,222.06,96,200,96Zm0,88c-13.23,0-24-9-24-20s10.77-20,24-20,24,9,24,20S213.23,184,200,184Z",
    fill: undefined,
  },
  gearSix: {
    regular:
      "M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm109.94-52.79a8,8,0,0,0-3.89-5.4l-29.83-17-.12-33.62a8,8,0,0,0-2.83-6.08,111.91,111.91,0,0,0-36.72-20.67,8,8,0,0,0-6.46.59L128,41.85,97.88,25a8,8,0,0,0-6.47-.6A112.1,112.1,0,0,0,54.73,45.15a8,8,0,0,0-2.83,6.07l-.15,33.65-29.83,17a8,8,0,0,0-3.89,5.4,106.47,106.47,0,0,0,0,41.56,8,8,0,0,0,3.89,5.4l29.83,17,.12,33.62a8,8,0,0,0,2.83,6.08,111.91,111.91,0,0,0,36.72,20.67,8,8,0,0,0,6.46-.59L128,214.15,158.12,231a7.91,7.91,0,0,0,3.9,1,8.09,8.09,0,0,0,2.57-.42,112.1,112.1,0,0,0,36.68-20.73,8,8,0,0,0,2.83-6.07l.15-33.65,29.83-17a8,8,0,0,0,3.89-5.4A106.47,106.47,0,0,0,237.94,107.21Zm-15,34.91-28.57,16.25a8,8,0,0,0-3,3c-.58,1-1.19,2.06-1.81,3.06a7.94,7.94,0,0,0-1.22,4.21l-.15,32.25a95.89,95.89,0,0,1-25.37,14.3L134,199.13a8,8,0,0,0-3.91-1h-.19c-1.21,0-2.43,0-3.64,0a8.08,8.08,0,0,0-4.1,1l-28.84,16.1A96,96,0,0,1,67.88,201l-.11-32.2a8,8,0,0,0-1.22-4.22c-.62-1-1.23-2-1.8-3.06a8.09,8.09,0,0,0-3-3.06l-28.6-16.29a90.49,90.49,0,0,1,0-28.26L61.67,97.63a8,8,0,0,0,3-3c.58-1,1.19-2.06,1.81-3.06a7.94,7.94,0,0,0,1.22-4.21l.15-32.25a95.89,95.89,0,0,1,25.37-14.3L122,56.87a8,8,0,0,0,4.1,1c1.21,0,2.43,0,3.64,0a8.08,8.08,0,0,0,4.1-1l28.84-16.1A96,96,0,0,1,188.12,55l.11,32.2a8,8,0,0,0,1.22,4.22c.62,1,1.23,2,1.8,3.06a8.09,8.09,0,0,0,3,3.06l28.6,16.29A90.49,90.49,0,0,1,222.9,142.12Z",
    fill: undefined,
  },
  /**
   * The who-is-here state icons (PresenceStack.tsx), drawn here in Phosphor's manner:
   * `regular` is a centre line stroked 16 units wide with round ends (`line`), `fill` the
   * solid shape (even-odd, so a pupil stays open).
   */
  /** Hears every line live. */
  ear: {
    line: true,
    regular:
      "M72,104A56,56,0,0,1,184,104C184,144,152,152,148,184A36,36,0,0,1,80,196M104,108A24,24,0,0,1,152,108C152,124,136,128,132,140",
    fill: undefined,
  },
  /** Woken only when named. */
  bell: {
    line: true,
    regular: "M64,184V112A64,64,0,0,1,192,112V184L208,200H48ZM104,228H152",
    fill: undefined,
  },
  /** Not listening: a closed eye (a lid and its lashes). */
  eyeClosed: {
    line: true,
    regular:
      "M32,104C64,152,96,168,128,168S192,152,224,104M128,168V200M76,156L56,186M180,156L200,186",
    fill: undefined,
  },
  /** Can read and answer (owner, 2026-11-16: answering means it reads, one icon): a speech bubble. */
  chatBubble: {
    line: true,
    regular: "M48,56H208A16,16,0,0,1,224,72V176A16,16,0,0,1,208,192H112L64,224V192H48A16,16,0,0,1,32,176V72A16,16,0,0,1,48,56Z",
    fill: "M48,48H208A24,24,0,0,1,232,72V176A24,24,0,0,1,208,200H114L56,236V200H48A24,24,0,0,1,24,176V72A24,24,0,0,1,48,48Z",
  },
  /** May operate the page for you (the eval grant): a hand, its finger pointing up. */
  hand: {
    line: true,
    regular:
      "M104,168V48a16,16,0,0,1,32,0V120M136,112a16,16,0,0,1,32,0v16M168,120a16,16,0,0,1,32,0v32a72,72,0,0,1-72,72H120a64,64,0,0,1-52-26L36,152a16,16,0,0,1,26-20l42,36",
    fill: undefined,
  },
} satisfies Record<string, { regular: string; fill?: string; line?: true }>;

export type IconName = keyof typeof ICONS;

/** The stroke that strikes an icon through (not allowed): corner to corner. */
const SLASH = "M40,40L216,216";

export function Icon({
  name,
  weight = "regular",
  slash = false,
}: {
  name: keyof typeof ICONS;
  weight?: "regular" | "fill";
  /** Struck through: the thing it stands for is not allowed (the who-is-here icons). */
  slash?: boolean;
}) {
  const icon: { regular: string; fill?: string; line?: true } = ICONS[name];
  const solid = weight === "fill" && icon.fill;
  return (
    <svg
      data-icon={name}
      data-slash={slash || undefined}
      viewBox="0 0 256 256"
      fill="currentColor"
      width="1em"
      height="1em"
      className="inline-block shrink-0 align-[-0.125em]"
      aria-hidden
    >
      {icon.line && !solid ? (
        <path
          d={icon.regular}
          fill="none"
          stroke="currentColor"
          strokeWidth={16}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path d={solid || icon.regular} fillRule={icon.line ? "evenodd" : undefined} />
      )}
      {slash && (
        <path
          data-slash-line
          d={SLASH}
          fill="none"
          stroke="currentColor"
          strokeWidth={20}
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

/**
 * The mark on a line the agent polished (a voice line it corrected): one
 * slot, so the icon can be swapped here or per host (DebugChat's
 * `polishedIcon`). The default is a sparkle.
 */
export const POLISHED_ICON = <Icon name="sparkle" />;

/** An outline tree (a root and two branches): the state tree's row in the + menu. Drawn here, not Phosphor's. */
export function TreeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="10" width="7" height="4.5" rx="1.5" />
      <rect x="14" y="16.5" width="7" height="4.5" rx="1.5" />
      <path d="M6.5 8v10.75H14M6.5 12.25H14" />
    </svg>
  );
}

/** The + menu's History row: a clock with an arrow running back round it. */
export function HistoryIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3.5 4v4h4" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

/**
 * A disclosure triangle (the Gantt's category rows): pointing to the end when
 * folded, down when open. Drawn, not a glyph: "▸" renders tiny in most fonts
 * and "▶" as an emoji on iOS. Decorative; its button carries the label and
 * aria-expanded.
 */
export function Disclosure({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      data-open={open}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="currentColor"
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        transform: open ? "rotate(90deg)" : undefined,
        transition: "transform 120ms",
      }}
      className="motion-reduce:transition-none rtl:-scale-x-100"
    >
      <path d="M4 2.2 9 6 4 9.8Z" />
    </svg>
  );
}

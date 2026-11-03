/**
 * The few icons the debug chat draws, so the package needs nothing from the
 * app: Phosphor Icons (https://phosphoricons.com), MIT License, Copyright (c)
 * 2023 Phosphor Icons. "regular" is the normal line, "fill" the on state.
 * `sparkle` is drawn here (a four-point star and a small one), not Phosphor's.
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
} satisfies Record<string, { regular: string; fill?: string }>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  weight = "regular",
}: {
  name: keyof typeof ICONS;
  weight?: "regular" | "fill";
}) {
  const icon: { regular: string; fill?: string } = ICONS[name];
  return (
    <svg
      data-icon={name}
      viewBox="0 0 256 256"
      fill="currentColor"
      width="1em"
      height="1em"
      className="inline-block shrink-0 align-[-0.125em]"
      aria-hidden
    >
      <path d={(weight === "fill" && icon.fill) || icon.regular} />
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

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
} satisfies Record<string, { regular: string; fill?: string }>;

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

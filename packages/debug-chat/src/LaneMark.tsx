/**
 * A lane's mark and name tag (voices.ts LANES): drawn from the table's data,
 * an oklch disc with the lane's own drawing, so codex and agy look apart at a
 * glance. Mid-lightness colours: they read on the light and the dark log alike.
 */
import { LANES, type LaneId } from "./voices";

/** The lane's mark as an avatar element (fills the Avatar's round box), or undefined (no mark: as today). */
export function laneAvatar(lane: LaneId) {
  const mark = LANES[lane].mark;
  if (!mark) return undefined;
  return (
    <svg
      data-testid="debug-chat-lane-mark"
      data-lane={lane}
      viewBox="0 0 24 24"
      width="100%"
      height="100%"
      aria-hidden
      style={{ display: "block", background: mark.bg, borderRadius: "9999px" }}
    >
      {mark.paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill ? mark.fg : "none"}
          stroke={mark.fg}
          strokeWidth={p.fill ? 1 : 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

/**
 * The lane's name leading its run of lines, "name：" (`inline`: a small tag, for the
 * floating and compact lines). Main shows the host's agent name when it is
 * given, else nothing. aria-hidden: the sr-only "name:" already says who.
 */
export function LaneTag({
  lane,
  agentName,
  inline = false,
}: {
  lane: LaneId;
  agentName?: string;
  inline?: boolean;
}) {
  const name = LANES[lane].name || agentName;
  if (!name) return null;
  // At the head of a run the name leads the text, "小克：…" (owner, 2026-11-14:
  // "把消息的内容接在你们的名字后面，用冒号分隔"); a full-width colon after a CJK name.
  const colon = /[\u3040-\u30ff\u3400-\u9fff]$/u.test(name) ? "：" : ": ";
  return (
    <span
      aria-hidden
      data-testid="debug-chat-lane"
      data-lane={lane}
      className={
        inline
          ? "me-1 fs-10 font-semibold leading-tight text-gray-500"
          : "font-semibold text-gray-500"
      }
    >
      {name}
      {inline ? "" : colon}
    </span>
  );
}

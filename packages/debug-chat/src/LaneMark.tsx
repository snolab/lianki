/**
 * A lane's mark and name tag (voices.ts LANES): drawn from the table's data,
 * an oklch disc with the lane's own drawing, so codex and agy look apart at a
 * glance. Mid-lightness colours: they read on the light and the dark log alike.
 *
 * Any other agent (an API token's lane, an MCP client) gets a generated mark
 * from its name (svg-avatar.ts autoMark), or the SVG it set for itself (or
 * the owner set for it), fetched by reference and sanitized again here.
 */
import { useEffect, useState } from "react";
import { flashProps } from "./addressed";
import { LANES, type LaneId, type LaneMark, isLaneId } from "./voices";
import type { ChatMessage } from "./wire";
import { speakerAvatar } from "./speaker-avatar";
import { AVATAR_PATH, autoMark, isAvatarRef, sanitizeAvatarSvg, svgDataUrl } from "./svg-avatar";

/** A mark as an avatar element (fills the Avatar's round box). */
export function markSvg(mark: LaneMark, data: Record<string, string>) {
  return (
    <svg
      {...data}
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

/** The lane's mark as an avatar element (fills the Avatar's round box), or undefined (no mark: as today). */
export function laneAvatar(lane: LaneId) {
  const mark = LANES[lane].mark;
  if (!mark) return undefined;
  return markSvg(mark, { "data-testid": "debug-chat-lane-mark", "data-lane": lane });
}

/** The generated mark of an agent with no picture of its own. */
export function autoAvatar(name: string) {
  return markSvg(autoMark(name), { "data-testid": "debug-chat-auto-mark", "data-name": name });
}

/** Another voice's avatar on an owner's voice line (speaker-avatar.ts): the same id, the same disc. */
export function voiceAvatar(voice: string) {
  return markSvg(speakerAvatar(voice), { "data-testid": "debug-chat-voice-mark", "data-voice": voice });
}

/** Fetched avatars, by reference: the sanitized SVG's data URL, or null (missing or refused). */
const fetched = new Map<string, Promise<string | null>>();
function loadAvatar(ref: string): Promise<string | null> {
  let p = fetched.get(ref);
  if (!p) {
    p = fetch(`${AVATAR_PATH}${ref}`, { credentials: "omit" })
      .then((r) => (r.ok ? r.text() : null))
      .then((svg) => {
        if (svg === null) return null;
        // Sanitized by the hub; checked again before it is drawn.
        const s = sanitizeAvatarSvg(svg);
        return s.ok ? svgDataUrl(s.svg) : null;
      })
      .catch(() => null);
    fetched.set(ref, p);
  }
  return p;
}

/**
 * An agent's own avatar (by reference), as an <img> of the sanitized SVG
 * (an image never runs script or loads anything else). While it loads, or
 * when it cannot be had, the generated mark from `name`.
 */
export function CustomAvatar({ avatar, name }: { avatar: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (isAvatarRef(avatar)) void loadAvatar(avatar).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [avatar]);
  if (!url) return autoAvatar(name);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      data-testid="debug-chat-custom-avatar"
      src={url}
      alt=""
      aria-hidden
      width="100%"
      height="100%"
      style={{ display: "block", borderRadius: "9999px", objectFit: "cover" }}
    />
  );
}

/** Any agent's picture: its own SVG, else its lane's mark, else the generated one. */
export function agentAvatar(p: { name: string; lane?: LaneId; avatar?: string }) {
  if (p.avatar && isAvatarRef(p.avatar)) return <CustomAvatar avatar={p.avatar} name={p.name} />;
  return (p.lane && laneAvatar(p.lane)) || autoAvatar(p.name);
}

/**
 * The "MCP" badge: this participant came through an MCP client. Matches the
 * name tag (10px, semibold), a hairline oklch outline.
 */
export function McpBadge({ inline = false }: { inline?: boolean }) {
  return (
    <span
      data-testid="debug-chat-mcp"
      className={`${inline ? "me-1" : "ms-1"} inline-block rounded-sm border border-[oklch(0.62_0.08_250)] px-0.5 align-[1px] fs-9 font-semibold leading-tight text-[oklch(0.5_0.1_250)] dark:border-[oklch(0.6_0.08_250)] dark:text-[oklch(0.78_0.08_250)]`}
    >
      MCP
    </span>
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
  mcp = false,
}: {
  lane: LaneId;
  agentName?: string;
  inline?: boolean;
  mcp?: boolean;
}) {
  const name = LANES[lane].name || agentName;
  if (!name) return mcp ? <McpBadge inline={inline} /> : null;
  return <NameTag name={name} lane={lane} inline={inline} mcp={mcp} />;
}

/**
 * A line's tag: its lane's name tag, or a token agent's name (`name`: the
 * one its avatar is drawn with, the owner's choice first), with the MCP
 * badge when it came through MCP. Nothing for other lines.
 */
export function LineTag({
  m,
  name,
  agentName,
  inline = false,
}: {
  m: Pick<ChatMessage, "lane" | "via" | "client" | "tokenLane">;
  name?: string;
  agentName?: string;
  inline?: boolean;
}) {
  const mcp = m.client === "mcp";
  if (isLaneId(m.lane))
    return <LaneTag lane={m.lane} agentName={agentName} inline={inline} mcp={mcp} />;
  if (m.via === "token") {
    const n = name || m.tokenLane;
    return n ? <NameTag name={n} inline={inline} mcp={mcp} /> : null;
  }
  return null;
}

/**
 * A token line as the log shows it: a `【name】` prefix of a lane that is not
 * in LANES comes off the text (its name tag says it). Known lanes already
 * lost theirs (withLane); what is read aloud is not this.
 */
export function withTokenName<M extends { via?: string; tokenLane?: string; text: string }>(m: M): M {
  if (m.via !== "token" || !m.tokenLane || typeof m.text !== "string") return m;
  const head = `【${m.tokenLane}】`;
  return m.text.startsWith(head) ? { ...m, text: m.text.slice(head.length).trimStart() } : m;
}

/** A name tag (a lane's, or any token agent's), with the MCP badge after it. */
export function NameTag({
  name,
  lane,
  inline = false,
  mcp = false,
}: {
  name: string;
  lane?: string;
  inline?: boolean;
  mcp?: boolean;
}) {
  // At the head of a run the name leads the text, "小克：…" (owner, 2026-11-14:
  // "把消息的内容接在你们的名字后面，用冒号分隔"); a full-width colon after a CJK name.
  const colon = /[\u3040-\u30ff\u3400-\u9fff]$/u.test(name) ? "：" : ": ";
  return (
    <span
      aria-hidden
      data-testid="debug-chat-lane"
      data-lane={lane ?? name}
      className={
        inline
          ? "me-1 fs-10 font-semibold leading-tight text-gray-500"
          : "font-semibold text-gray-500"
      }
    >
      {name}
      {mcp && <McpBadge />}
      {inline ? "" : colon}
    </span>
  );
}

/**
 * The lanes an owner line called by name (addressed.ts), as small marks after
 * it: kept, so the log shows who was called. `pulse`: the line just arrived,
 * they pulse once (FLASH_MS) in their lane's colour. Each is labelled for
 * screen readers by `label` ("Addressed: {name}", chat-ui-locales.ts).
 */
export function AddressedMarks({
  lanes,
  label,
  pulse = false,
}: {
  lanes: readonly LaneId[];
  label: string;
  pulse?: boolean;
}) {
  return (
    <>
      {lanes.map((lane) => (
        <span
          key={lane}
          role="img"
          data-testid="debug-chat-addressed"
          aria-label={label.replace("{name}", LANES[lane].name || lane)}
          title={LANES[lane].name || lane}
          className="ms-1 inline-block size-3 rounded-full align-middle"
          {...(pulse ? flashProps(lane) : {})}
        >
          {laneAvatar(lane)}
        </span>
      ))}
    </>
  );
}

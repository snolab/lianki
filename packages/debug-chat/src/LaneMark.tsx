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
import { laneSpec, type LaneId, type LaneMark, isLaneId } from "./voices";
import { childLane, childShownName, parentShownName } from "./child-lane";
import type { ChatMessage } from "./wire";
import { speakerAvatar } from "./speaker-avatar";
import { HOUSE_PATH, clusterAvatar as clusterLook } from "./cluster-avatar";
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
  const mark = laneSpec(lane).mark;
  if (!mark) return undefined;
  return markSvg(mark, { "data-testid": "debug-chat-lane-mark", "data-lane": lane });
}

/**
 * A lane's subagent (a child token, child-lane.ts): the parent lane's mark,
 * with its index in a small disc of the lane's ink at the lower right.
 */
export function childAvatar(lane: LaneId, index: string) {
  const mark = laneSpec(lane).mark;
  if (!mark) return undefined;
  return (
    <svg
      data-testid="debug-chat-child-mark"
      data-lane={lane}
      data-index={index}
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
          transform="translate(-2 -2) scale(0.9)"
        />
      ))}
      <circle cx="18" cy="18" r="6" fill={mark.fg} stroke={mark.bg} strokeWidth={1} />
      <text
        x="18"
        y="18"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={index.length > 1 ? 6 : 8}
        fontWeight={700}
        fill={mark.bg}
      >
        {index}
      </text>
    </svg>
  );
}

/** The generated mark of an agent with no picture of its own. */
export function autoAvatar(name: string) {
  return markSvg(autoMark(name), { "data-testid": "debug-chat-auto-mark", "data-name": name });
}

/** Another voice's avatar on an owner's voice line (speaker-avatar.ts): the same id, the same disc. */
export function voiceAvatar(voice: string) {
  return markSvg(speakerAvatar(voice), { "data-testid": "debug-chat-voice-mark", "data-voice": voice });
}

/**
 * One voice in the room (cluster-avatar.ts): its letter, or a house for a
 * household voice, on a disc of its own colour. Named by the Avatar around it.
 */
export function clusterAvatar(cluster: string) {
  const c = clusterLook(cluster);
  return (
    <svg
      data-testid="debug-chat-cluster-mark"
      data-cluster={cluster}
      viewBox="0 0 24 24"
      width="100%"
      height="100%"
      aria-hidden
      style={{ display: "block", background: c.bg, borderRadius: "9999px" }}
    >
      {c.kind === "household" ? (
        <path d={HOUSE_PATH} fill={c.fg} stroke={c.fg} strokeWidth={1} strokeLinejoin="round" />
      ) : (
        <text
          x="12"
          y="12"
          textAnchor="middle"
          dominantBaseline="central"
          fill={c.fg}
          fontSize={c.letter.length > 1 ? 9 : 13}
          fontWeight={700}
          fontFamily="system-ui, sans-serif"
        >
          {c.letter}
        </text>
      )}
    </svg>
  );
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
  const name = laneSpec(lane).name || agentName;
  if (!name) return mcp ? <McpBadge inline={inline} /> : null;
  return <NameTag name={name} lane={lane} inline={inline} mcp={mcp} />;
}

/** The hub's label on a Learning Partner reply (lib/partner-ai-config.ts PARTNER_AI_LABEL). */
export const PARTNER_LINE_LABEL = "Learning Partner AI";

/**
 * A line's tag: its lane's name tag, or a token agent's name (`name`: the
 * one its avatar is drawn with, the owner's choice first), with the MCP
 * badge when it came through MCP. Nothing for other lines. A Learning
 * Partner reply on the main lane (his thread, workers/push/src/owner-ai.ts)
 * is tagged `partnerName` (the feature's name in the page's language), not
 * the host's agent name: the owner saw Li's replies labelled "Claude"
 * (2026-11-15 04:2x JST).
 */
export function LineTag({
  m,
  name,
  agentName,
  partnerName,
  inline = false,
}: {
  m: Pick<ChatMessage, "lane" | "via" | "client" | "tokenLane"> & { label?: string };
  name?: string;
  agentName?: string;
  partnerName?: string;
  inline?: boolean;
}) {
  const mcp = m.client === "mcp";
  if (m.lane === "main" && m.label === PARTNER_LINE_LABEL)
    return <NameTag name={partnerName || m.label} lane="main" inline={inline} mcp={mcp} />;
  if (isLaneId(m.lane))
    return <LaneTag lane={m.lane} agentName={agentName} inline={inline} mcp={mcp} />;
  if (m.via === "token") {
    // A lane's subagent shows as 「小克·子1」; its tag says whose it is (child-lane.ts).
    const child = childLane(m.tokenLane);
    const n = name || (m.tokenLane ? childShownName(m.tokenLane) : undefined);
    return n ? (
      <NameTag
        name={n}
        inline={inline}
        mcp={mcp}
        {...(child ? { parent: parentShownName(child) } : {})}
      />
    ) : null;
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
  parent,
}: {
  name: string;
  lane?: string;
  inline?: boolean;
  mcp?: boolean;
  /** A subagent's lane (its parent's shown name): the tag's tooltip names it. */
  parent?: string;
}) {
  // At the head of a run the name leads the text, "小克：…" (owner, 2026-11-14:
  // "把消息的内容接在你们的名字后面，用冒号分隔"); a full-width colon after a CJK name.
  const colon = /[\u3040-\u30ff\u3400-\u9fff]$/u.test(name) ? "：" : ": ";
  return (
    <span
      aria-hidden
      data-testid="debug-chat-lane"
      data-lane={lane ?? name}
      {...(parent ? { "data-parent": parent, title: parent } : {})}
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
          aria-label={label.replace("{name}", laneSpec(lane).name || lane)}
          title={laneSpec(lane).name || lane}
          className="ms-1 inline-block size-3 rounded-full align-middle"
          {...(pulse ? flashProps(lane) : {})}
        >
          {laneAvatar(lane)}
        </span>
      ))}
    </>
  );
}

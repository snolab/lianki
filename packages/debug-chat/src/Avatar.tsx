import { type ReactNode, isValidElement, useState } from "react";
import { type AvatarSource, avatarSrcs, avatarView } from "./avatar-rules";
import { avatarColors, initialOf } from "./wire";


/**
 * A small round avatar, `size` px square whatever loads (no layout shift):
 * a picture (no referrer, which Google's need; lazy), an element, or the
 * name's initial on an oklch circle whose hue comes from `seed`. Labelled
 * with `name` (alt / aria-label) and titled with it for a hover tooltip.
 */
export function Avatar({
  src,
  name,
  seed,
  initialFrom,
  size = 18,
  hidden = false,
}: {
  src?: AvatarSource;
  name: string;
  /** Whose initial the fallback shows, when not `name`'s. */
  initialFrom?: string;
  /** A stable id for the fallback colour (a Sender id); defaults to the name. */
  seed?: string;
  size?: number;
  /** aria-hidden: the line already says who in an sr-only span. */
  hidden?: boolean;
}) {
  const srcs = avatarSrcs(src);
  // Re-keyed on the list, so a new list starts from its first URL again.
  return (
    <AvatarInner
      key={srcs.join(" ")}
      srcs={srcs}
      node={isValidElement(src) ? src : null}
      name={name}
      letter={initialOf(initialFrom ?? name)}
      seed={seed || name}
      size={size}
      hidden={hidden}
    />
  );
}

function AvatarInner({
  srcs,
  node,
  name,
  letter,
  seed,
  size,
  hidden,
}: {
  srcs: string[];
  node: ReactNode;
  name: string;
  letter: string;
  seed: string;
  size: number;
  hidden: boolean;
}) {
  const [failed, setFailed] = useState(0);
  // Inline styles, not utilities: the avatar keeps its size and shape on any
  // host page, with or without the widget's CSS (no layout shift either way).
  const box = {
    width: size,
    height: size,
    minWidth: size,
    flexShrink: 0,
    borderRadius: "9999px",
    overflow: "hidden",
  } as const;
  const center = {
    ...box,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  } as const;
  const aria = hidden ? { "aria-hidden": true as const } : {};
  const view = avatarView(srcs, failed, !!node);
  if (view.kind === "img")
    return (
      <img
        data-testid="debug-chat-avatar"
        data-avatar="img"
        src={view.src}
        alt={name}
        title={name}
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed((f) => f + 1)}
        style={{ ...box, display: "block", objectFit: "cover" }}
        {...aria}
      />
    );
  if (view.kind === "node")
    return (
      <span
        data-testid="debug-chat-avatar"
        data-avatar="node"
        role="img"
        aria-label={name}
        title={name}
        style={center}
        {...aria}
      >
        {node}
      </span>
    );
  const { bg, fg } = avatarColors(seed);
  return (
    <span
      data-testid="debug-chat-avatar"
      data-avatar="initial"
      role="img"
      aria-label={name}
      title={name}
      style={{
        ...center,
        background: bg,
        color: fg,
        fontSize: Math.round(size * 0.55),
        fontWeight: 600,
        lineHeight: 1,
        userSelect: "none",
      }}
      {...aria}
    >
      {letter}
    </span>
  );
}

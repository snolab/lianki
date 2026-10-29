"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type Assignee,
  FRONTIER_ROWS,
  type Frontier,
  LONG_PRESS_MS,
  avatarColor,
  countBadge,
  initialOf,
  shortId,
  shownAgentId,
} from "./frontier-view";
import { LINE_HALO } from "./log-surface";
import { createLongPress } from "./tap-gesture";

/** The full-id popover's glass (a popover, not a line: it keeps a fill). */
const GLASS = "color-mix(in oklch, var(--background) 85%, transparent)";

/** Draws an assignee's avatar at `size` px (the host's real Avatar, once it has one). */
export type RenderAvatar = (a: Assignee, size: number) => ReactNode;

/** An assignee's avatar, about 16px: the host's renderer, else their initial on a hashed colour. */
function AvatarSlot({ a, render }: { a: Assignee; render?: RenderAvatar }) {
  const label = `${a.type === "agent" ? "Agent" : "Person"}: ${a.name}`;
  if (render)
    return (
      <span role="img" aria-label={label} title={a.name} className="inline-flex size-4 shrink-0">
        {render(a, 16)}
      </span>
    );
  return (
    <span
      role="img"
      aria-label={label}
      title={a.name}
      data-testid="debug-chat-frontier-avatar"
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] leading-none font-semibold text-white"
      style={{ background: avatarColor(a.name) }}
    >
      {initialOf(a.name)}
    </span>
  );
}

/**
 * An agent's id at the line's far right: its last 6 characters, monospace
 * and muted. The full id is in the title and the label, and a long press on
 * a touch screen shows it in a small popover. Text only.
 */
function AgentId({ id }: { id: string }) {
  const [shown, setShown] = useState(false);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const press = useRef<ReturnType<typeof createLongPress> | null>(null);
  press.current ??= createLongPress({ ms: LONG_PRESS_MS, onLong: () => setShown(true) });
  useEffect(
    () => () => {
      press.current?.cancel();
      clearTimeout(hide.current);
    },
    [],
  );
  const end = () => {
    if (press.current?.up()) {
      clearTimeout(hide.current);
      hide.current = setTimeout(() => setShown(false), 2_000);
    }
  };
  return (
    <span
      data-testid="debug-chat-frontier-id"
      title={`agent id: ${id}`}
      aria-label={`agent id ${id}`}
      onPointerDown={(e) => e.pointerType !== "mouse" && press.current?.down()}
      onPointerUp={end}
      onPointerLeave={() => press.current?.cancel()}
      onPointerCancel={() => press.current?.cancel()}
      onContextMenu={(e) => e.preventDefault()}
      className="pointer-events-auto relative ms-auto shrink-0 select-none ps-1.5 pe-2 font-mono text-[10px] text-gray-500"
    >
      {shortId(id)}
      {shown && (
        <span
          role="tooltip"
          data-testid="debug-chat-frontier-id-full"
          style={{ background: GLASS }}
          className="absolute end-0 bottom-full mb-1 rounded-md border border-current/25 px-1.5 py-0.5 whitespace-nowrap backdrop-blur-md"
        >
          {id}
        </span>
      )}
    </span>
  );
}

/**
 * The minimized chat's frontier, just above its bar: "✓ last done",
 * "▶ in progress" (with who is on it), "› next". A group's line is its
 * summary and 〔count〕; a tap opens it in place to list its items (title and
 * breadcrumb, scrolling past about 6), another tap closes it. Minimizing
 * again starts with all closed (the lines unmount while expanded).
 */
export function FrontierLines({
  frontier,
  renderAvatar,
  align = "left",
}: {
  frontier: Frontier;
  renderAvatar?: RenderAvatar;
  /** The side the box hangs on (anchor.ts): the lines line up with it. */
  align?: "left" | "center" | "right";
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rows = FRONTIER_ROWS.filter((r) => frontier[r.key]?.text);
  if (!rows.length) return null;
  return (
    <ul data-testid="debug-chat-frontier" className={`flex list-none flex-col gap-0.5 ${align === "right" ? "items-end" : align === "center" ? "items-center" : "items-start"}`}>
      {rows.map((r) => {
        const line = frontier[r.key];
        if (!line) return null;
        const items = line.items ?? [];
        const group = items.length > 0;
        const expanded = group && openKey === r.key;
        const id = r.key === "doing" ? shownAgentId(line.assignee) : null;
        const count = countBadge(line.count);
        return (
          <li
            key={r.key}
            data-testid="debug-chat-frontier-line"
            data-status={r.key}
            data-expanded={expanded || undefined}
            // Text only, with a strong halo: no background, no box.
            style={{ textShadow: LINE_HALO }}
            className="pointer-events-auto max-w-full min-w-0"
          >
            <div className="flex min-w-0 items-center">
              <button
                type="button"
                aria-expanded={group ? expanded : undefined}
                aria-label={`${r.label}: ${line.text}${count ? `, ${line.count} items` : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => group && setOpenKey(expanded ? null : r.key)}
                className={`flex min-w-0 items-center gap-1 py-0.5 text-start ${id ? "" : "pe-1"} ${group ? "" : "cursor-default"}`}
              >
                <span aria-hidden className="w-3 shrink-0 text-center opacity-70">
                  {r.mark}
                </span>
                {r.key === "doing" && line.assignee && (
                  <AvatarSlot a={line.assignee} render={renderAvatar} />
                )}
                <span className="min-w-0 truncate">{line.text}</span>
                {count && (
                  <span data-testid="debug-chat-frontier-count" className="shrink-0 opacity-70">
                    {count}
                  </span>
                )}
              </button>
              {id && <AgentId id={id} />}
            </div>
            {expanded && (
              <ul
                data-testid="debug-chat-frontier-items"
                className="max-h-[9.75rem] list-none overflow-y-auto overscroll-contain px-2 pb-1"
              >
                {items.map((it, i) => (
                  <li key={`${i}${it.title}`} className="flex min-w-0 items-center gap-1 py-px">
                    {it.assignee && <AvatarSlot a={it.assignee} render={renderAvatar} />}
                    <span className="min-w-0 truncate">
                      {it.title}
                      {it.path && <span className="ms-1 text-[10px] text-gray-500">{it.path}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

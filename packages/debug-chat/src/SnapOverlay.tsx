"use client";
/**
 * The drag overlay (snap-targets.ts, snap-overlay.ts): from the moment a drag
 * of the chat starts, every zone a drop would act on, faint, each with its
 * icon and label; the one under the pointer stronger, and the window's final
 * rect as translucent glass growing out of the window.
 *
 * It renders once when the drag starts and once per zone change, never per
 * pointer move. The preview's growth is a transform (FLIP: laid out at the
 * result, started over the window's rect, animated to none), so a frame
 * costs no layout. Reduced motion: it appears at once.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { growFrom, labelAt, labelStyle, previewStyle, SNAP_ICON, zoneStyle } from "./snap-overlay";
import type { Rect, SnapId, SnapTarget, SnapViewport } from "./snap-targets";

export type SnapOverlayState = {
  vp: SnapViewport;
  targets: SnapTarget[];
  hot: SnapId | null;
  /** The window's rect when the hovered zone was entered (the preview grows from it). */
  from: Rect | null;
};

export function SnapOverlay(p: {
  state: SnapOverlayState | null;
  labels: Record<SnapId, string>;
  ms: number;
  alpha: number;
  reduce: boolean;
}) {
  const preview = useRef<HTMLDivElement | null>(null);
  const s = p.state;
  // The zones fade in on the frame after the drag starts (at once under reduced motion).
  const [shown, setShown] = useState(false);
  const on = !!s;
  useLayoutEffect(() => {
    if (!on) return setShown(false);
    if (p.reduce) return setShown(true);
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [on]);
  const hot = s?.targets.find((t) => t.id === s.hot) ?? null;
  // FLIP: start over the window, then let the transition carry it to its place.
  useLayoutEffect(() => {
    const el = preview.current;
    if (!el || !hot) return;
    if (p.reduce || p.ms <= 0) {
      el.style.transition = "none";
      el.style.transform = "none";
      return;
    }
    el.style.transition = "none";
    el.style.transform = growFrom(s?.from ?? null, hot.result);
    const id = requestAnimationFrame(() => {
      el.style.transition = `transform ${p.ms}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
      el.style.transform = "none";
    });
    return () => cancelAnimationFrame(id);
    // Only a new zone restarts it.
  }, [hot?.id, hot?.result.x, hot?.result.y, hot?.result.w, hot?.result.h]);
  if (!s) return null;
  return (
    <div aria-hidden data-testid="debug-chat-snap" data-hot={s.hot ?? undefined}>
      {s.targets.map((t) => (
        <div
          key={t.id}
          data-testid="debug-chat-snap-zone"
          data-zone={t.id}
          data-hot={t.id === s.hot || undefined}
          style={zoneStyle(t, { hot: t.id === s.hot, shown, ms: p.ms, reduce: p.reduce })}
        />
      ))}
      {hot && (
        <div
          ref={preview}
          key={`preview-${hot.id}`}
          data-testid="debug-chat-snap-preview"
          data-zone={hot.id}
          style={previewStyle(hot.result, { alpha: p.alpha })}
        />
      )}
      {s.targets.map((t) => (
        <div
          key={`label-${t.id}`}
          data-testid="debug-chat-snap-label"
          data-zone={t.id}
          style={{
            ...labelStyle(labelAt(t, s.vp), {
              hot: t.id === s.hot,
              vertical: t.id === "dock-right",
              ms: p.ms,
              reduce: p.reduce,
            }),
            opacity: shown ? 1 : 0,
          }}
        >
          <svg viewBox="0 0 18 18" width={16} height={16} aria-hidden>
            <path
              d={SNAP_ICON[t.id]}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>{p.labels[t.id]}</span>
        </div>
      ))}
    </div>
  );
}

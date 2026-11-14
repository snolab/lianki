"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  clampDockWidth,
  dockBounds,
  dockViewport,
  resizeDockWidth,
  type DockBounds,
} from "./dock-resize";
import { DOCK_WIDTH_VAR, DOCK_RIGHT_VAR } from "./dock-resize";
import { SIDEBAR_MIN_REM, SIDEBAR_W } from "./full-screen";

/** Touch-size hit area centred on the inner border, away from the composer.
 * Pointer presses prevent browser focus transfer and never reach useDrag.
 */
export function DockResize(p: {
  box: () => HTMLElement | null;
  label: string;
  preview: (width: number | null) => void;
  commit: (width: number) => void;
}) {
  const live = useRef(p);
  live.current = p;
  const drag = useRef<{
    id: number;
    x: number;
    width: number;
    current: number;
    moved: boolean;
  } | null>(null);
  const [shown, setShown] = useState(0);
  const [range, setRange] = useState<DockBounds>({ min: 0, max: 0 });
  const limits = (): DockBounds =>
    dockBounds(
      dockViewport(innerWidth, visualViewport).width,
      SIDEBAR_MIN_REM * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16),
    );
  const cancel = () => {
    drag.current = null;
    live.current.preview(null);
  };
  useLayoutEffect(() => {
    const box = live.current.box();
    if (!box) return;
    const measure = () => {
      const b = limits();
      setRange((old) => (old.min === b.min && old.max === b.max ? old : b));
      setShown(box.getBoundingClientRect().width);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const interrupted = () => {
      if (drag.current) cancel();
    };
    window.addEventListener("blur", interrupted);
    document.addEventListener("visibilitychange", interrupted);
    return () => {
      window.removeEventListener("blur", interrupted);
      document.removeEventListener("visibilitychange", interrupted);
    };
  }, []);
  useEffect(
    () => () => {
      if (drag.current) {
        drag.current = null;
        live.current.preview(null);
      }
    },
    [],
  );
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={p.label}
      title={p.label}
      tabIndex={0}
      aria-valuenow={Math.round(shown)}
      aria-valuemin={Math.round(range.min)}
      aria-valuemax={Math.round(range.max)}
      data-testid="debug-chat-dock-resize"
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0 || drag.current) return;
        const box = p.box();
        if (!box) return;
        e.preventDefault();
        e.stopPropagation();
        const width = box.getBoundingClientRect().width;
        drag.current = { id: e.pointerId, x: e.clientX, width, current: width, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
        setShown(width);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        if (!d.moved && Math.abs(e.clientX - d.x) < 2) return;
        d.moved = true;
        d.current = resizeDockWidth(d.width, d.x, e.clientX, limits());
        setShown(d.current);
        p.preview(d.current);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        if (!d.moved) {
          cancel();
          return;
        }
        const width = resizeDockWidth(d.width, d.x, e.clientX, limits());
        drag.current = null;
        p.commit(width);
        p.preview(null);
        setShown(width);
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={(e) => {
        if (drag.current?.id === e.pointerId) cancel();
      }}
      onLostPointerCapture={(e) => {
        if (drag.current?.id === e.pointerId) cancel();
      }}
      onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        const box = p.box();
        if (!box) return;
        e.preventDefault();
        e.stopPropagation();
        const b = limits(),
          step = e.shiftKey ? 20 : 10;
        const width = clampDockWidth(
          e.key === "Home"
            ? b.min
            : e.key === "End"
              ? b.max
              : box.getBoundingClientRect().width + (e.key === "ArrowLeft" ? step : -step),
          b,
        );
        p.commit(width);
        setShown(width);
      }}
      style={{
        position: "absolute",
        top: 48,
        bottom: 80,
        width: 40,
        left: `max(-20px, calc(var(--lk-edge-l, 24px) - (100vw - var(${DOCK_RIGHT_VAR}, 0px) - var(${DOCK_WIDTH_VAR}, ${SIDEBAR_W}))))`,
        cursor: "ew-resize",
        touchAction: "none",
        userSelect: "none",
        zIndex: 4,
      }}
      className="pointer-events-auto rounded focus-visible:outline-2 focus-visible:outline-current"
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 19,
          top: "50%",
          width: 2,
          height: 40,
          borderRadius: 2,
          background: "currentColor",
          opacity: 0.4,
          transform: "translateY(-50%)",
        }}
      />
    </div>
  );
}

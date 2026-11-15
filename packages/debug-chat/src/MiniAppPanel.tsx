import { useEffect, useRef, useState, type ReactNode } from "react";
import { clampMiniAppHeight, miniAppKeyHeight, type MiniAppSizing } from "./mini-app-panel";

export type MiniAppLabels = {
  open: string;
  close: string;
  fullscreen: string;
  exitFullscreen: string;
  resize: string;
  loading: string;
  unavailable: string;
};

/** A CSS fullscreen panel: opening it never invokes the browser's fullscreen API. */
export function MiniAppPanel({
  title,
  labels,
  sizing,
  onClose,
  children,
}: {
  title: string;
  labels: MiniAppLabels;
  sizing: MiniAppSizing;
  onClose: () => void;
  children: ReactNode;
}) {
  const viewportNow = () => ({
    height: window.visualViewport?.height ?? window.innerHeight,
    top: window.visualViewport?.offsetTop ?? 0,
    left: window.visualViewport?.offsetLeft ?? 0,
    width: window.visualViewport?.width ?? window.innerWidth,
  });
  const [viewport, setViewport] = useState(viewportNow);
  const [height, setHeight] = useState(sizing.height);
  const [full, setFull] = useState(false);
  const drag = useRef<{ id: number; y: number; height: number } | null>(null);
  useEffect(() => {
    const resize = () => setViewport(viewportNow());
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
    };
  }, []);
  const shownHeight = clampMiniAppHeight(height, viewport.height, sizing.minHeight);
  return (
    <div
      data-testid="mini-app-overlay"
      className="pointer-events-none fixed inset-0 flex items-end justify-center p-2 pb-[var(--lk-chat-overlay-bottom,5rem)]"
      style={{
        zIndex: "calc(var(--lk-z-chat, 80) + 1)",
        top: viewport.top,
        left: viewport.left,
        width: viewport.width,
        height: viewport.height,
        ...(full ? { padding: 0 } : {}),
      }}
    >
      <section
        role="dialog"
        aria-label={title}
        data-testid="mini-app-panel"
        data-fullscreen={full || undefined}
        className="pointer-events-auto flex min-h-0 w-full max-w-3xl flex-col overflow-hidden rounded-xl border bg-background text-foreground shadow-xl"
        style={{
          height: full ? "100%" : shownHeight,
          maxHeight: "100%",
          ...(full ? { maxWidth: "100%", borderRadius: 0 } : {}),
        }}
        onKeyDown={(e) => {
          if (
            e.key === "Escape" &&
            (e.target as HTMLElement).closest('[role="dialog"]') === e.currentTarget
          ) {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b px-2 py-1">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {!full && (
            <button
              type="button"
              data-testid="mini-app-resize"
              aria-label={labels.resize}
              title={labels.resize}
              aria-valuemin={Math.min(sizing.minHeight, viewport.height)}
              aria-valuemax={viewport.height}
              aria-valuenow={shownHeight}
              role="separator"
              aria-orientation="horizontal"
              className="cursor-ns-resize touch-none px-2 py-1"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                drag.current = { id: e.pointerId, y: e.clientY, height: shownHeight };
                e.currentTarget.setPointerCapture?.(e.pointerId);
                e.preventDefault();
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (d?.id === e.pointerId)
                  setHeight(
                    clampMiniAppHeight(
                      d.height + d.y - e.clientY,
                      viewport.height,
                      sizing.minHeight,
                    ),
                  );
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
              onKeyDown={(e) => {
                const next = miniAppKeyHeight(e.key, shownHeight, viewport.height, sizing);
                if (next === null) return;
                e.preventDefault();
                setHeight(next);
              }}
            >
              <span aria-hidden>↕</span>
            </button>
          )}
          <button
            type="button"
            data-testid="mini-app-fullscreen"
            aria-label={full ? labels.exitFullscreen : labels.fullscreen}
            title={full ? labels.exitFullscreen : labels.fullscreen}
            className="px-2 py-1"
            onClick={() => setFull((value) => !value)}
          >
            <span aria-hidden>{full ? "↙" : "↗"}</span>
          </button>
          <button
            type="button"
            data-testid="mini-app-close"
            aria-label={labels.close}
            title={labels.close}
            className="px-2 py-1"
            onClick={onClose}
          >
            <span aria-hidden>×</span>
          </button>
        </header>
        <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
      </section>
    </div>
  );
}

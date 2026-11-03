/**
 * A stand-in bottom island for scripts/dev/nav-island-chat-qa.mjs: the real
 * reserve and chat-dock hooks (lib/nav/islands/signals.ts) on a box the size
 * of the island, laid out with inline styles (the harness has no app CSS).
 */
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { useBottomReserve, useChatDock } from "@/lib/nav/islands/signals";

function Island() {
  const nav = useRef<HTMLElement>(null);
  useBottomReserve(nav);
  const dock = useChatDock(nav, true);
  return (
    <div
      data-nav-island
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: dock ? `${dock}px` : "calc(env(safe-area-inset-bottom) + 0.625rem)",
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
        zIndex: 35,
      }}
    >
      <nav
        ref={nav}
        data-dock={dock || undefined}
        style={{ width: 280, height: 56, borderRadius: 28, background: "oklch(0.8 0.05 250)" }}
      />
    </div>
  );
}

const host = document.createElement("div");
document.body.append(host);
createRoot(host).render(<Island />);

"use client";

import { useEffect, useState } from "react";
import { installNoCreditsWatch } from "@/lib/payments/no-credits-watch";

export type NoCreditsStrings = { message: string; topUp: string; close: string };

/**
 * "Not enough credits · Get credits", on any page, when a paid route refused
 * (lib/payments/no-credits-watch.ts). Strings come from the server
 * (credits-needed.content.ts). A glass strip over the bottom, never pushing
 * content; dismissed by its ×, shown again by the next refusal.
 */
export function NoCreditsNotice({
  strings,
  href = "/membership",
}: {
  strings: NoCreditsStrings;
  href?: string;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => installNoCreditsWatch(window, () => setShown(true)), []);
  if (!shown) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        insetInline: 16,
        bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
        zIndex: 60,
        maxWidth: 480,
        marginInline: "auto",
        display: "flex",
        gap: 12,
        alignItems: "center",
        padding: "10px 12px",
        borderRadius: 12,
        fontSize: 14,
        lineHeight: 1.4,
        color: "var(--lk-credits-fg, oklch(0.25 0.03 260))",
        background: "var(--lk-credits-bg, oklch(0.97 0.02 85 / 0.92))",
        border: "1px solid oklch(0.8 0.08 85)",
        backdropFilter: "blur(8px)",
        boxShadow: "0 4px 16px oklch(0 0 0 / 0.15)",
      }}
      className="lk-no-credits"
    >
      <span style={{ flex: 1 }}>
        {strings.message}{" "}
        <a href={href} style={{ fontWeight: 600, textDecoration: "underline", color: "inherit" }}>
          {strings.topUp}
        </a>
      </span>
      <button
        type="button"
        aria-label={strings.close}
        title={strings.close}
        onClick={() => setShown(false)}
        style={{
          minWidth: 32,
          minHeight: 32,
          border: 0,
          background: "transparent",
          color: "inherit",
          fontSize: 18,
          cursor: "pointer",
        }}
      >
        ×
      </button>
      <style>{`@media (prefers-color-scheme: dark) { .lk-no-credits { --lk-credits-fg: oklch(0.95 0.02 85); --lk-credits-bg: oklch(0.3 0.04 85 / 0.92); } }`}</style>
    </div>
  );
}

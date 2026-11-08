import type { ReactNode } from "react";

/**
 * The menu's Dev group (owner, 2026-11-08: no internal diagnostics in the
 * user-facing chat UI). It holds the readouts and switches that are for
 * debugging, not for learners: the latency breakdown, the mic's adaptation
 * (dB levels, VAD thresholds) and the echo-cancellation A/B. Collapsed by
 * default, and only on the owner's pages (`owner`, verified by the hub);
 * everyone else never sees it. A native <details>, so it opens with no state.
 */
export function DevMenuGroup({
  owner,
  label,
  children,
}: {
  owner: boolean;
  label: string;
  children?: ReactNode;
}) {
  if (!owner) return null;
  return (
    <details data-testid="debug-menu-dev" className="border-t border-current/15">
      <summary
        data-testid="debug-menu-dev-toggle"
        className="cursor-pointer px-3 py-1.5 text-gray-500 select-none"
      >
        {label}
      </summary>
      {children}
    </details>
  );
}

"use client";

import { useDebugToggle } from "@/app/components/useDebugToggle";

/**
 * Renders its children only in debug mode (lib/debug-client.ts; the 10-tap
 * switch on your name in the profile menu). For diagnostics such as the raw
 * session dump, which is noise to everyone else.
 */
export function DebugOnly({ children }: { children: React.ReactNode }) {
  const [on] = useDebugToggle();
  return on ? <>{children}</> : null;
}

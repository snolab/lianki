"use client";

import type { PublicConfigValues } from "@/lib/config";
import { setPublicConfig } from "@/lib/config-client";

/**
 * Hands the server's public config values (docs/config-store.md) to
 * lib/config-client.ts before its children render, so `publicCfg(key)` reads
 * the live value on the server render and in the browser alike.
 */
export function PublicConfig({
  values,
  children,
}: {
  values: Partial<PublicConfigValues> | null;
  children: React.ReactNode;
}) {
  setPublicConfig(values);
  return children;
}

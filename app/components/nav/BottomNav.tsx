"use client";

/**
 * The `nav.bottom` island's built-in version (docs/bottom-nav.md): nothing
 * yet. The floating bottom island is developed as a hot island and becomes
 * the built-in once the owner approves it; until then production renders
 * exactly what it did before the slot existed.
 */
import type { IslandProps } from "@/lib/islands/contract";

export function BottomNav(_props: IslandProps["nav.bottom"]) {
  return null;
}

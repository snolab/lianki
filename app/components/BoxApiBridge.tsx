"use client";

import { installBoxFetch, type BoxConfig } from "@/lib/box-oauth/client";

/**
 * On a box only: from the first render, the page's /api calls go to lianki.com
 * with the box's token (docs/box-oauth.md). In render, not an effect, so it is
 * in place before any child's effect fetches.
 */
export function BoxApiBridge({ config }: { config: BoxConfig }) {
  if (typeof window !== "undefined") installBoxFetch(config);
  return null;
}

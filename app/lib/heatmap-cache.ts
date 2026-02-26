import { unstable_cache } from "next/cache";
import type { HeatmapData } from "@/types/heatmap";
import { aggregateReviewActivity } from "./heatmap-aggregation";

const CACHE_KEY_PREFIX = "fsrs-heatmap";
const CACHE_REVALIDATE = 3600;

export function getCachedHeatmapData(email?: string): Promise<HeatmapData> {
  // Only calculate for authenticated users
  if (!email) {
    return Promise.resolve({});
  }

  return unstable_cache(
    async () => {
      return await aggregateReviewActivity(email);
    },
    [`${CACHE_KEY_PREFIX}:${email}`],
    {
      revalidate: CACHE_REVALIDATE,
      tags: [getHeatmapCacheTag(email)],
    },
  )();
}

export function getHeatmapCacheTag(email?: string): string {
  return `heatmap-data${email ? `:${email}` : ""}`;
}

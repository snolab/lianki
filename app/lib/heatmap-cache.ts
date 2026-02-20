import { unstable_cache } from "next/cache";
import type { HeatmapData } from "@/types/heatmap";
import { aggregateReviewActivity } from "./heatmap-aggregation";

const CACHE_KEY_PREFIX = "fsrs-heatmap";
const CACHE_REVALIDATE = 3600;

export function getCachedHeatmapData(email?: string): Promise<HeatmapData> {
  return unstable_cache(
    async () => {
      return await aggregateReviewActivity(email);
    },
    [`${CACHE_KEY_PREFIX}:${email || "anonymous"}`],
    {
      revalidate: CACHE_REVALIDATE,
      tags: [getHeatmapCacheTag(email)],
    },
  )();
}

export function getHeatmapCacheTag(email?: string): string {
  return `heatmap-data${email ? `:${email}` : ""}`;
}

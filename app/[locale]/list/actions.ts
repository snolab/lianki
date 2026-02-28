"use server";

import { revalidateTag } from "next/cache";
import { getHeatmapCacheTag } from "@/app/lib/heatmap-cache";
import { authEmail } from "@/app/signInEmail";

export async function invalidateHeatmapCache() {
  const email = await authEmail();
  if (email) {
    revalidateTag(getHeatmapCacheTag(email), "default");
  }
}

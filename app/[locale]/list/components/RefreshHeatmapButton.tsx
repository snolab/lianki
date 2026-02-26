"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useIntlayer } from "next-intlayer";

export default function RefreshHeatmapButton() {
  const { refresh, refreshing, refreshHeatmapTitle } = useIntlayer("list-page");
  const router = useRouter();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      // Trigger server component refresh to fetch fresh data
      router.refresh();
      // Give it a moment to refresh
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <button
      onClick={handleRefresh}
      disabled={isRefreshing}
      className="ml-4 px-3 py-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      title={refreshHeatmapTitle}
    >
      {isRefreshing ? refreshing : refresh}
    </button>
  );
}

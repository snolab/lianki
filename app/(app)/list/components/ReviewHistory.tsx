"use client";

import { useState } from "react";

// Serializable version of ReviewLog — dates may be Date objects or ISO strings
type SerializedReviewLog = {
  rating: number;
  state: number;
  due: Date | string;
  review: Date | string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  last_elapsed_days: number;
  scheduled_days: number;
  learning_steps?: number;
};

type ReviewHistoryProps = {
  logs?: SerializedReviewLog[];
};

const RATING_COLORS = {
  1: "bg-red-500", // Again
  2: "bg-orange-500", // Hard
  3: "bg-yellow-500", // Good
  4: "bg-blue-500", // Easy
} as const;

const RATING_NAMES = {
  1: "Again",
  2: "Hard",
  3: "Good",
  4: "Easy",
} as const;

export function ReviewHistory({ logs = [] }: ReviewHistoryProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  // Get last 6 reviews (most recent first)
  const recentLogs = logs.slice(-6).reverse();

  // Pad to 6 with empty slots
  const paddedLogs = [...Array(6)].map((_, i) => recentLogs[i] || null);

  if (logs.length === 0) {
    return null;
  }

  return (
    <span className="relative inline-block ml-1">
      <span
        className="inline-flex gap-0.5 cursor-help"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        [
        {paddedLogs.map((log, i) =>
          log ? (
            <span
              key={i}
              className={`inline-block w-1.5 h-3 ${RATING_COLORS[log.rating as keyof typeof RATING_COLORS]}`}
              title={`${RATING_NAMES[log.rating as keyof typeof RATING_NAMES]} - ${new Date(log.review).toLocaleDateString()}`}
            />
          ) : (
            <span key={i} className="inline-block w-1.5 h-3 opacity-0">
              _
            </span>
          ),
        )}
        ]
      </span>

      {/* Tooltip */}
      {showTooltip && logs.length > 0 && (
        <div className="absolute z-10 bottom-full left-0 mb-2 w-64 p-3 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg text-sm">
          <div className="font-semibold mb-2">Review History ({logs.length} total)</div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {logs
              .slice()
              .reverse()
              .slice(0, 20)
              .map((log, i) => {
                const date = new Date(log.review);
                return (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span
                      className={`inline-block w-2 h-2 rounded-sm ${RATING_COLORS[log.rating as keyof typeof RATING_COLORS]}`}
                    />
                    <span className="flex-1">
                      {RATING_NAMES[log.rating as keyof typeof RATING_NAMES]}
                    </span>
                    <span className="text-gray-500 dark:text-gray-400">
                      {date.toLocaleDateString()}{" "}
                      {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </span>
  );
}

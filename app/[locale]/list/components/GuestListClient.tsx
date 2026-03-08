"use client";

import { useState, useEffect } from "react";
import { useIntlayer } from "next-intlayer";
import { ems } from "@/app/ems";

type FSRSCard = {
  url: string;
  title: string;
  card: {
    due: Date;
    stability: number;
    difficulty: number;
    elapsed_days: number;
    scheduled_days: number;
    reps: number;
    lapses: number;
    state: number;
    last_review?: Date;
  };
  log?: Array<{
    rating: number;
    state: number;
    due: Date;
    stability: number;
    difficulty: number;
    elapsed_days: number;
    last_elapsed_days: number;
    scheduled_days: number;
    review: Date;
  }>;
  hlc?: string;
  synced?: boolean;
};

export default function GuestListClient({ locale }: { locale: string }) {
  const { totalCards, dueCards, learningActivity } = useIntlayer("list-page");
  const [cards, setCards] = useState<FSRSCard[]>([]);
  const [localCount, setLocalCount] = useState(0);
  const [syncedCount, setSyncedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    loadCardsFromIndexedDB();
  }, []);

  async function loadCardsFromIndexedDB() {
    try {
      // Access the IndexedDB stores created by the userscript
      const { openDB } = await import("idb");
      const db = await openDB("lianki-keyval", 1);

      // Try to get all cards
      const cardStore = db.transaction("keyval", "readonly").objectStore("keyval");
      const allKeys = await cardStore.getAllKeys();

      const cardData: FSRSCard[] = [];
      let synced = 0;

      for (const key of allKeys) {
        if (typeof key === "string" && key.startsWith("card:")) {
          const value = await cardStore.get(key);
          if (value) {
            const card = {
              ...value,
              card: {
                ...value.card,
                due: new Date(value.card.due),
                last_review: value.card.last_review ? new Date(value.card.last_review) : undefined,
              },
              log: value.log?.map((l: any) => ({
                ...l,
                due: new Date(l.due),
                review: new Date(l.review),
              })),
            };
            cardData.push(card);
            if (card.synced) synced++;
          }
        }
      }

      // Sort by due date
      cardData.sort((a, b) => +a.card.due - +b.card.due);

      setCards(cardData);
      setLocalCount(cardData.length);
      setSyncedCount(synced);
      setLoading(false);
    } catch (err) {
      console.error("[Lianki] Failed to load cards from IndexedDB:", err);
      setError("Failed to load local cards. Please make sure the userscript is installed.");
      setLoading(false);
    }
  }

  function dueMs(due: Date) {
    return ems(+due - +new Date(), "short") ?? "0s";
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-32 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-md" />
        <div className="text-gray-500 text-center">Loading local cards...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
        <h3 className="text-yellow-800 dark:text-yellow-200 font-semibold mb-2">Guest Mode</h3>
        <p className="text-yellow-700 dark:text-yellow-300 mb-4">{error}</p>
        <div className="space-y-2 text-sm">
          <p>
            Install the{" "}
            <a href="/lianki.user.js" className="underline font-semibold">
              Lianki userscript
            </a>{" "}
            to use offline mode, or{" "}
            <a href="/sign-in" className="underline font-semibold">
              sign in
            </a>{" "}
            to sync across devices.
          </p>
        </div>
      </div>
    );
  }

  const dueCount = cards.filter((c) => c.card.due <= new Date()).length;
  const syncPercentage = localCount > 0 ? Math.round((syncedCount / localCount) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Sync Status Banner */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-blue-800 dark:text-blue-200 font-semibold mb-1">
              Guest Mode - Local Storage
            </h3>
            <p className="text-blue-700 dark:text-blue-300 text-sm">
              Your cards are stored locally in your browser.{" "}
              <a href="/sign-in" className="underline font-semibold">
                Sign in
              </a>{" "}
              to sync across devices.
            </p>
          </div>
          <div className="flex items-center gap-2 text-blue-800 dark:text-blue-200">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {syncPercentage === 100 ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              )}
            </svg>
            <span className="font-mono font-bold">
              {localCount}/{syncedCount}
            </span>
            {syncPercentage < 100 && <span className="text-xs">({syncPercentage}% synced)</span>}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <p className="text-lg">
          {totalCards} {localCount}
        </p>
        <p className="text-lg">
          {dueCards} {dueCount}
        </p>
      </div>

      {/* Heatmap Placeholder */}
      <section className="my-8">
        <h2 className="text-xl font-semibold mb-4">{learningActivity}</h2>
        <div className="bg-gray-100 dark:bg-gray-800 rounded-md p-4 text-center text-gray-500">
          Sign in to see your learning activity heatmap
        </div>
      </section>

      {/* Card List */}
      <ul className="space-y-2 overflow-x-hidden">
        {cards.length === 0 ? (
          <li className="text-gray-500 text-center py-8">
            No cards yet. Press Alt+F on any webpage to add your first card!
          </li>
        ) : (
          cards.map((note, idx) => {
            const due = dueMs(note.card.due);
            const title = note.title;
            const url = note.url;
            const logs = note.log || [];
            const isSynced = note.synced;

            return (
              <li key={idx} className="break-words overflow-hidden flex items-start gap-2">
                <span className="flex-shrink-0">{due}</span>
                <span className="flex-shrink-0 text-xs">
                  {logs.map((l, i) => (
                    <span
                      key={i}
                      className={
                        l.rating === 1
                          ? "text-red-500"
                          : l.rating === 2
                            ? "text-yellow-500"
                            : l.rating === 3
                              ? "text-green-500"
                              : "text-blue-500"
                      }
                    >
                      •
                    </span>
                  ))}
                </span>
                <a href={url} className="break-all flex-1">
                  {title || url}
                </a>
                {isSynced ? (
                  <span className="flex-shrink-0 text-green-500 text-xs" title="Synced to cloud">
                    ☁️
                  </span>
                ) : (
                  <span className="flex-shrink-0 text-gray-400 text-xs" title="Local only">
                    💾
                  </span>
                )}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

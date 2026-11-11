"use client";

import { useState, useEffect } from "react";
import { Icon } from "@/app/components/icons";
import { VirtualList } from "@/app/components/VirtualList";
import { useIntlayer } from "next-intlayer";
import { dueMs } from "@/app/ems";
import { SyncStatusBanner } from "./SyncStatusBanner";
import { displayTitle } from "@/lib/titles/client";
import { fill } from "@/lib/roadmap/labels";

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

/** A card's site, for the "delete all from this site" button. */
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

export default function GuestListClient() {
  const { totalCards, dueCards, learningActivity } = useIntlayer("list-page");
  const g = useIntlayer("list-ui").guest;
  const [cards, setCards] = useState<FSRSCard[]>([]);
  const [localCount, setLocalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    loadCardsFromIndexedDB();
  }, []);

  async function loadCardsFromIndexedDB() {
    try {
      // Access the IndexedDB stores created by the userscript
      const { openDB } = await import("idb");
      const db = await openDB("lianki-keyval", 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains("keyval")) db.createObjectStore("keyval");
        },
      });

      // Try to get all cards
      const cardStore = db.transaction("keyval", "readonly").objectStore("keyval");
      const allKeys = await cardStore.getAllKeys();

      const cardData: FSRSCard[] = [];

      for (const key of allKeys) {
        if (typeof key === "string" && key.startsWith("card:")) {
          const value = await cardStore.get(key);
          if (value) {
            cardData.push({
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
            });
          }
        }
      }

      // Sort by due date
      cardData.sort((a, b) => +a.card.due - +b.card.due);

      // Filter out cards queued for deletion (userscript processes queue on next load)
      const deleteQueue: { url?: string; domain?: string }[] = JSON.parse(
        localStorage.getItem("__lianki_delete_queue") || "[]",
      );
      const filtered = cardData.filter((c) => {
        for (const q of deleteQueue) {
          if (q.url && c.url === q.url) return false;
          if (q.domain) {
            try {
              if (new URL(c.url).hostname === q.domain) return false;
            } catch {}
          }
        }
        return true;
      });

      setCards(filtered);
      setLocalCount(cardData.length);
      setLoading(false);
    } catch (err) {
      console.error("[Lianki] Failed to load cards from IndexedDB:", err);
      setError(g.loadFailed.value);
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-32 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-md" />
        <div className="text-gray-500 text-center">{g.loading}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
        <h3 className="text-yellow-800 dark:text-yellow-200 font-semibold mb-2">{g.title}</h3>
        <p className="text-yellow-700 dark:text-yellow-300 mb-4">{error}</p>
        <div className="space-y-2 text-sm">
          <p>{g.installHint}</p>
          <p className="flex flex-wrap gap-4">
            <a href="/lianki.user.js" className="underline font-semibold">
              {g.installLink}
            </a>
            <a href="/sign-in" className="underline font-semibold">
              {g.signInLink}
            </a>
          </p>
        </div>
      </div>
    );
  }

  const dueCount = cards.filter((c) => c.card.due <= new Date()).length;

  return (
    <div className="space-y-6">
      {/* Sync Status Banner — guest: Script → Local only */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h3 className="text-blue-800 dark:text-blue-200 font-semibold mb-1">{g.bannerTitle}</h3>
            <p className="text-blue-700 dark:text-blue-300 text-sm">
              {g.bannerText}{" "}
              <a href="/sign-in" className="underline font-semibold">
                {g.signInLink}
              </a>
            </p>
          </div>
          <SyncStatusBanner />
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
          {g.heatmapSignIn}
        </div>
      </section>

      {/* Card List */}
      <VirtualList
        items={cards}
        getKey={(note) => note.url}
        name="list-guest"
        hasMore={false}
        loading={false}
        onReachEnd={() => {}}
        estimateSize={32}
        gap={8}
        className="overflow-x-hidden"
        testId="guest-cards-list"
        empty={<p className="text-gray-500 text-center py-8">{g.empty}</p>}
        renderItem={(note) => {
          const due = dueMs(note.card.due);
          const title = note.title;
          const url = note.url;
          const logs = note.log || [];
          const isSynced = note.synced;

          return (
            <div className="break-words overflow-hidden flex items-start gap-2">
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
                {displayTitle(title, url) || url}
              </a>
              {isSynced ? (
                <span className="flex-shrink-0 text-green-500 text-xs" title={g.synced.value}>
                  <Icon name="cloud" label={g.synced.value} />
                </span>
              ) : (
                <span className="flex-shrink-0 text-gray-400 text-xs" title={g.localOnly.value}>
                  <Icon name="floppyDisk" label={g.localOnly.value} />
                </span>
              )}
              <button
                className="flex-shrink-0 text-gray-400 hover:text-red-500 text-xs px-1"
                title={g.deleteCard.value}
                onClick={() => {
                  const q = JSON.parse(localStorage.getItem("__lianki_delete_queue") || "[]");
                  q.push({ url });
                  localStorage.setItem("__lianki_delete_queue", JSON.stringify(q));
                  setCards((prev) => prev.filter((c) => c.url !== url));
                }}
              >
                <Icon name="trash" label={g.deleteCard.value} />
              </button>
              <button
                className="flex-shrink-0 text-gray-400 hover:text-red-500 text-xs px-1"
                aria-label={fill(g.deleteSite.value, { host: hostOf(url) })}
                title={fill(g.deleteSite.value, { host: hostOf(url) })}
                onClick={() => {
                  let domain: string;
                  try {
                    domain = new URL(url).hostname;
                  } catch {
                    return;
                  }
                  const q = JSON.parse(localStorage.getItem("__lianki_delete_queue") || "[]");
                  q.push({ domain });
                  localStorage.setItem("__lianki_delete_queue", JSON.stringify(q));
                  setCards((prev) =>
                    prev.filter((c) => {
                      try {
                        return new URL(c.url).hostname !== domain;
                      } catch {
                        return true;
                      }
                    }),
                  );
                }}
              >
                <Icon name="trash" />
                <Icon name="globe" />
              </button>
            </div>
          );
        }}
      />
    </div>
  );
}

"use client";

import { useState, useEffect } from "react";

type Props = {
  /** MongoDB card count. Pass null/undefined for guest (no cloud storage). */
  mongoCount?: number | null;
};

function Box({ icon, label, count }: { icon: string; label: string; count: number | null }) {
  return (
    <div className="flex flex-col items-center border border-gray-200 dark:border-gray-700 rounded-md px-3 py-2 min-w-[64px] text-center">
      <span className="text-lg leading-none mb-0.5">{icon}</span>
      <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
      <span className="font-mono font-bold text-sm">{count === null ? "…" : count}</span>
    </div>
  );
}

export function SyncStatusBanner({ mongoCount }: Props) {
  const [gmCount, setGmCount] = useState<number | null>(null);
  const [idbCount, setIdbCount] = useState<number | null>(null);
  const isGuest = mongoCount == null;

  useEffect(() => {
    (async () => {
      try {
        const { openDB } = await import("idb");
        const db = await openDB("lianki-keyval", 1, {
          upgrade(db) {
            if (!db.objectStoreNames.contains("keyval")) db.createObjectStore("keyval");
          },
        });
        const tx = db.transaction("keyval", "readonly");
        const store = tx.objectStore("keyval");
        const [allKeys, gm] = await Promise.all([store.getAllKeys(), store.get("meta:gm-count")]);
        await tx.done;
        db.close();
        setIdbCount(
          allKeys.filter((k) => typeof k === "string" && (k as string).startsWith("card:")).length,
        );
        setGmCount(typeof gm === "number" ? gm : null);
      } catch {
        setIdbCount(0);
      }
    })();
  }, []);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Box icon="💾" label="Script" count={gmCount} />
      <span className="text-gray-400 text-lg">→</span>
      <Box icon="🗂️" label="Local" count={idbCount} />
      {!isGuest && (
        <>
          <span className="text-gray-400 text-lg">→</span>
          <Box icon="☁️" label="Cloud" count={mongoCount} />
        </>
      )}
    </div>
  );
}

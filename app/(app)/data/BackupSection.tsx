"use client";

import { useState } from "react";
import { stringify } from "yaml";
import { EXPORT_VERSION, serializeNoteForExport } from "@/lib/yaml-export";
import YamlImportSection from "../import/YamlImportSection";
import type { LocalCard } from "@/app/lib/localStore";

type Props = {
  heading: string;
  exportLabel: string;
  isLoggedIn: boolean;
  localCards: LocalCard[];
};

function download(filename: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function BackupSection({ heading, exportLabel, isLoggedIn, localCards }: Props) {
  const [busy, setBusy] = useState(false);

  /**
   * Guests have no `/api/export/yaml` to call, so build the same document shape
   * client-side. `lib/yaml-export` is deliberately runtime-free, so the exact
   * serializer the server uses is importable here — a guest backup and a signed-in
   * backup stay one format.
   */
  function exportLocal() {
    setBusy(true);
    try {
      const data = {
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        email: "",
        fsrsNotes: localCards.map((c) =>
          serializeNoteForExport({
            url: c.url,
            title: c.title,
            card: c.card,
            log: c.log ?? [],
            hlc: c.hlc,
          }),
        ),
        roadmapGoals: [],
        preferences: { mobileExcludePatterns: [] },
      };
      const date = new Date().toISOString().slice(0, 10);
      download(`lianki-local-export-${date}.yaml`, stringify(data), "text/yaml;charset=utf-8");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="backup-heading">
      <h2 id="backup-heading" className="text-xl font-semibold mb-3">
        {heading}
      </h2>

      <div className="flex flex-wrap gap-3">
        {isLoggedIn ? (
          <a
            href="/api/export/yaml"
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            ⬇ {exportLabel} — cloud
          </a>
        ) : null}
        <button
          type="button"
          onClick={exportLocal}
          disabled={busy || localCards.length === 0}
          className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          ⬇ {exportLabel} — local ({localCards.length})
        </button>
      </div>
      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
        A cloud export carries your notes, roadmap goals and preferences. A local export carries
        only the cards mirrored into this browser.
      </p>

      {isLoggedIn ? (
        <YamlImportSection />
      ) : (
        <p className="mt-8 border-t pt-8 text-sm text-gray-500 dark:text-gray-400">
          Sign in to restore a backup — importing writes to your cloud account.
        </p>
      )}
    </section>
  );
}

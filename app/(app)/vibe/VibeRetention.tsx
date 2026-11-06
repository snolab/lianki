"use client";

/** How long /vibe transcripts are kept, on /preferences (docs/vibe.md, "Retention"). */
import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import {
  RETENTION_DEFAULT_DAYS,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  checkRetention,
} from "@/lib/vibe/gate";

export function VibeRetention() {
  const t = useIntlayer("vibe-page");
  const [days, setDays] = useState(String(RETENTION_DEFAULT_DAYS));
  const [note, setNote] = useState<"saved" | "failed" | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/vibe/settings")
      .then((r) => (r.ok ? (r.json() as Promise<{ days: number }>) : null))
      .then((b) => {
        if (live && b) setDays(String(b.days));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const save = async () => {
    const n = checkRetention(Number(days));
    if (n === null) return setNote("failed");
    const r = await fetch("/api/vibe/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days: n }),
    }).catch(() => null);
    setNote(r?.ok ? "saved" : "failed");
  };
  return (
    <section
      className="mx-auto mb-10 max-w-4xl px-8"
      data-section="vibe"
      data-testid="vibe-settings"
    >
      <h2 className="mb-4 text-2xl font-semibold">{t.settingsHeading}</h2>
      <label className="flex flex-wrap items-center gap-2">
        <span>{t.retention}</span>
        <input
          type="number"
          inputMode="numeric"
          min={RETENTION_MIN_DAYS}
          max={RETENTION_MAX_DAYS}
          value={days}
          onChange={(e) => {
            setDays(e.target.value);
            setNote(null);
          }}
          onBlur={() => void save()}
          data-testid="vibe-retention"
          className="min-h-11 w-24 rounded-lg border border-[oklch(0.7_0_0)] bg-transparent px-3 dark:border-[oklch(0.45_0_0)]"
        />
        {note && (
          <span className="text-sm" role="status" data-testid="vibe-retention-note">
            {note === "saved" ? t.saved : t.saveFailed}
          </span>
        )}
      </label>
      <p className="mt-2 text-sm text-[oklch(0.45_0_0)] dark:text-[oklch(0.72_0_0)]">
        {t.retentionHelp}
      </p>
    </section>
  );
}

"use client";

/**
 * The optional number on /preferences (docs/vibe.md, "Keeping"): empty is off, the
 * default, and docs stay until deleted. Saved only when the user changed it, so
 * leaving the field never chooses anything by itself.
 */
import { useEffect, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { notePrefWrite } from "@lianki/ui-state/account";
import { RETENTION_MAX_DAYS, RETENTION_MIN_DAYS, checkRetention } from "@/lib/vibe/gate";
import {
  MIN_SHARE_DEFAULT,
  MIN_SHARE_KEY,
  MIN_SHARE_MAX,
  MIN_SHARE_MIN,
  readShare,
} from "@/lib/vibe/translations";

/** A language's share of a conversation before lines are translated into it. */
function TranslateShare() {
  const t = useIntlayer("vibe-page");
  const [pct, setPct] = useState(String(MIN_SHARE_DEFAULT));
  useEffect(() => setPct(String(readShare())), []);
  const save = () => {
    const n = Number(pct);
    if (!Number.isInteger(n) || n < MIN_SHARE_MIN || n > MIN_SHARE_MAX)
      return setPct(String(readShare()));
    try {
      localStorage.setItem(MIN_SHARE_KEY, String(n));
      notePrefWrite();
    } catch {
      // a private window: for this visit only
    }
  };
  return (
    <>
      <label className="mt-6 flex flex-wrap items-center gap-2">
        <span>{t.translateShare}</span>
        <input
          type="number"
          inputMode="numeric"
          min={MIN_SHARE_MIN}
          max={MIN_SHARE_MAX}
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          onBlur={save}
          data-testid="vibe-translate-share"
          className="min-h-11 w-28 rounded-lg border border-[oklch(0.7_0_0)] bg-transparent px-3 dark:border-[oklch(0.45_0_0)]"
        />
      </label>
      <p className="mt-2 text-sm text-[oklch(0.45_0_0)] dark:text-[oklch(0.72_0_0)]">
        {t.translateShareHelp}
      </p>
    </>
  );
}

export function VibeRetention() {
  const t = useIntlayer("vibe-page");
  const [days, setDays] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<"saved" | "failed" | null>(null);
  const stored = useRef("");
  useEffect(() => {
    let live = true;
    void fetch("/api/vibe/settings")
      .then((r) => (r.ok ? (r.json() as Promise<{ days: number | null }>) : null))
      .then((b) => {
        if (!live || !b) return;
        stored.current = b.days === null ? "" : String(b.days);
        setDays(stored.current);
        setLoaded(true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const save = async () => {
    const text = days.trim();
    if (text === stored.current) return;
    const n = text === "" ? null : checkRetention(Number(text));
    if (text !== "" && n === null) return setNote("failed");
    const r = await fetch("/api/vibe/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days: n }),
    }).catch(() => null);
    if (r?.ok) stored.current = text;
    setNote(r?.ok ? "saved" : "failed");
  };
  return (
    <section
      id="vibe"
      className="mx-auto mb-10 max-w-4xl px-8 scroll-mt-6"
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
          disabled={!loaded}
          placeholder={t.retentionOff.value}
          onChange={(e) => {
            setDays(e.target.value);
            setNote(null);
          }}
          onBlur={() => void save()}
          data-testid="vibe-retention"
          className="min-h-11 w-28 rounded-lg border border-[oklch(0.7_0_0)] bg-transparent px-3 dark:border-[oklch(0.45_0_0)]"
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
      <TranslateShare />
    </section>
  );
}

"use client";

// The transcript polish in the reader (docs/books-plan.md, "Import
// pipeline", step 3): the offer when the import's detector found a raw
// speech-to-text transcript (BookMeta.shape.raw), never applied without his
// tap; and the raw text kept beside a polished one, shown on request.

import { useState } from "react";
import { useIntlayer } from "next-intlayer";
import type { BookMeta } from "@/lib/read/book";

/** "No thanks" for this text on this device (a per-viewer convenience, docs/ui-state.md). */
const skipKey = (id: string) => `lk:read-polish-skip:${id}`;

function skipped(id: string): boolean {
  try {
    return localStorage.getItem(skipKey(id)) === "1";
  } catch {
    return false;
  }
}

export function PolishOffer({ id, book }: { id: string; book?: BookMeta | null }) {
  const t = useIntlayer("read-polish");
  const [hidden, setHidden] = useState(() => typeof window !== "undefined" && skipped(id));
  const [state, setState] = useState<"idle" | "working" | "failed">("idle");
  if (!book?.shape?.raw || book.polished || hidden) return null;
  const run = async () => {
    setState("working");
    try {
      const r = await fetch(`/api/read/${id}/polish`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // The text changed: the reader starts again on the polished one.
      window.location.reload();
    } catch (err) {
      console.error("read: polish failed", err);
      setState("failed");
    }
  };
  return (
    <div
      data-testid="read-polish-offer"
      className="mx-auto mb-4 w-full max-w-[38em] rounded-xl border border-[oklch(0.85_0_0)] bg-[oklch(0.97_0.01_250)] px-4 py-3 text-sm dark:border-[oklch(0.35_0_0)] dark:bg-[oklch(0.24_0.02_250)]"
    >
      <p className="font-medium">{t.offer}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="read-polish-run"
          disabled={state === "working"}
          onClick={run}
          className="rounded-lg bg-[oklch(0.55_0.15_250)] px-3 py-1.5 font-medium text-[oklch(0.99_0_0)] disabled:opacity-60"
        >
          {state === "working" ? t.working : t.polish}
        </button>
        <button
          type="button"
          disabled={state === "working"}
          onClick={() => {
            try {
              localStorage.setItem(skipKey(id), "1");
            } catch {
              // a private window: hidden for this visit only
            }
            setHidden(true);
          }}
          className="rounded-lg px-3 py-1.5 opacity-80"
        >
          {t.skip}
        </button>
      </div>
      <p className="mt-2 text-xs opacity-70">{state === "failed" ? t.failed : t.note}</p>
    </div>
  );
}

/** A polished transcript's raw text, behind a toggle (the contents sheet). */
export function RawTranscript({ id, book }: { id: string; book?: BookMeta | null }) {
  const t = useIntlayer("read-polish");
  const [raw, setRaw] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  if (!book?.polished) return null;
  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (raw) return;
    try {
      const r = await fetch(`/api/read/${id}/polish`);
      const d = (await r.json()) as { raw?: string[] | null };
      setRaw(d.raw ?? []);
    } catch {
      setRaw([]);
    }
  };
  return (
    <div className="mt-3" data-testid="read-raw-transcript">
      <button type="button" onClick={toggle} className="text-sm underline opacity-80">
        {open ? t.hideRaw : t.showRaw}
      </button>
      {open && raw && (
        <div className="mt-2 max-h-[50vh] overflow-y-auto text-sm leading-relaxed opacity-70">
          {raw.map((l, i) => (
            <p key={i} className="mb-2">
              {l}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

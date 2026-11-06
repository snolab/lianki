"use client";

// The transcript polish in the reader (docs/books-plan.md, "Import
// pipeline", step 3): the offer when the import's detector found a raw
// speech-to-text transcript (BookMeta.shape.raw), never applied without his
// tap, and when it may show (lib/read/polish-offer.ts); the same action in the
// contents sheet; and the raw text kept beside a polished one, shown on request.

import { useCallback, useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import type { BookMeta } from "@/lib/read/book";
import {
  carryDeviceSkip,
  offerShown,
  polishActionShown,
  readOfferOn,
  readSkipped,
  writeOfferOn,
  writeSkip,
  type OfferState,
} from "@/lib/read/polish-offer";

/** Run the polish; on success the text changed, so the reader starts again on it. */
function usePolishRun(id: string) {
  const [state, setState] = useState<"idle" | "working" | "failed">("idle");
  const run = useCallback(async () => {
    setState("working");
    try {
      const r = await fetch(`/api/read/${id}/polish`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      window.location.reload();
    } catch (err) {
      console.error("read: polish failed", err);
      setState("failed");
    }
  }, [id]);
  return { state, run };
}

export function PolishOffer({
  id,
  book,
  stream,
}: {
  id: string;
  book?: BookMeta | null;
  stream: OfferState["stream"];
}) {
  const t = useIntlayer("read-polish");
  const { state, run } = usePolishRun(id);
  const [offerOn, setOfferOn] = useState(readOfferOn);
  const [skipped, setSkipped] = useState(() => readSkipped(id));
  // His answer from another device or tab lands here while the page is open.
  useEffect(() => {
    carryDeviceSkip(id);
    const read = () => {
      setOfferOn(readOfferOn());
      setSkipped(readSkipped(id));
    };
    read();
    window.addEventListener(PREF_APPLIED_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(PREF_APPLIED_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, [id]);
  if (!offerShown({ book, stream, offerOn, skipped })) return null;
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
          data-testid="read-polish-skip"
          disabled={state === "working"}
          onClick={() => {
            writeSkip(id);
            setSkipped(true);
          }}
          className="rounded-lg px-3 py-1.5 opacity-80"
        >
          {t.skip}
        </button>
        <button
          type="button"
          data-testid="read-polish-never"
          disabled={state === "working"}
          onClick={() => {
            writeOfferOn(false);
            setOfferOn(false);
          }}
          className="rounded-lg px-3 py-1.5 opacity-80"
        >
          {t.never}
        </button>
      </div>
      <p className="mt-2 text-xs opacity-70">{state === "failed" ? t.failed : t.note}</p>
    </div>
  );
}

/** A tidied transcript with parts left as they were: said, never silent. */
export function PolishCoverage({ book }: { book?: BookMeta | null }) {
  const t = useIntlayer("read-polish");
  const p = book?.polished;
  if (!p || p.kept >= p.chunks) return null;
  return (
    <p
      data-testid="read-polish-coverage"
      className="mx-auto mb-4 w-full max-w-[38em] px-5 text-xs opacity-70"
    >
      {t.partial} ({p.kept}/{p.chunks})
    </p>
  );
}

/** The action itself, in the contents sheet: there whether or not the offer is. */
export function PolishAction({ id, book }: { id: string; book?: BookMeta | null }) {
  const t = useIntlayer("read-polish");
  const { state, run } = usePolishRun(id);
  if (!polishActionShown(book)) return null;
  return (
    <div className="mb-3" data-testid="read-polish-action">
      <button
        type="button"
        data-testid="read-polish-menu"
        disabled={state === "working"}
        onClick={run}
        className="text-sm underline opacity-80 disabled:opacity-60"
      >
        {state === "working" ? t.working : t.polish}
      </button>
      <p className="mt-1 text-xs opacity-70">{state === "failed" ? t.failed : t.note}</p>
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

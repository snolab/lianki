"use client";

import { useIntlayer } from "next-intlayer";
import type { BookMeta } from "@/lib/read/book";

/**
 * A /vibe transcript in the reader: one line on what it is, and the mark that
 * keeps its text off any chat line (packages/debug-chat/src/scene.ts).
 */
export function VibeDocNote({ book }: { book?: Pick<BookMeta, "source"> | null }) {
  const t = useIntlayer("vibe-page");
  if (book?.source !== "vibe") return null;
  return (
    <p
      data-lk-private-screen=""
      data-testid="vibe-doc-note"
      className="mb-3 px-4 text-xs leading-relaxed text-[oklch(0.5_0_0)] dark:text-[oklch(0.72_0_0)]"
    >
      {t.docNote}
    </p>
  );
}

/** The way in, on /read, for who may start one. */
export function VibeEntry() {
  const t = useIntlayer("vibe-page");
  return (
    <a href="/vibe" data-testid="vibe-entry" className="mb-6 inline-block underline">
      {t.entry}
    </a>
  );
}

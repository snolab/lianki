"use client";

import { useIntlayer } from "next-intlayer";
import { translationParts } from "@/lib/read/translate";

/**
 * A translation with its translator's notes set apart, in brackets and named as
 * notes. Not selectable: a note never gets into a selection or a card.
 */
export function TranslatedText({ text }: { text: string }) {
  const t = useIntlayer("read-select");
  return translationParts(text).map((p, i) =>
    p.note ? (
      <span key={i} className="select-none text-[0.85em] italic opacity-70" data-translator-note="">
        {" ("}
        {t.translatorNote} {p.text}
        {") "}
      </span>
    ) : (
      <span key={i}>{p.text}</span>
    ),
  );
}

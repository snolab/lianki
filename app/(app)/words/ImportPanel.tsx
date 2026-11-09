"use client";

/**
 * The Import button at the top of /words and the inline panel it opens
 * (docs/import-material.md, "On /words"; owner 2026-11-09). The panel is a
 * list of import sources; each one either jumps to a tool already on the
 * page (the preset sets → the "Add a list" tree) or opens its own body here
 * (a CSV / Excel table → the word-list import with its templates). A new
 * source (e.g. "any file, converted by an agent") is one more entry in
 * SOURCES once it works — nothing is listed before then.
 */
import { useState, type ReactNode } from "react";
import { useIntlayer } from "next-intlayer";
import { Icon, type IconName } from "@/app/components/icons";
import { WORDS_ADD_HASH } from "@/lib/home-features";
import dynamic from "next/dynamic";

// Loaded when the table choice is opened, not with /words.
const WordListImport = dynamic(() => import("../import/WordListImport"), { ssr: false });

type SourceId = "preset" | "table";
type Source = {
  id: SourceId;
  icon: IconName;
  title: "presetTitle" | "tableTitle";
  hint: "presetHint" | "tableHint";
};

/** In the order shown. */
const SOURCES: readonly Source[] = [
  { id: "preset", icon: "books", title: "presetTitle", hint: "presetHint" },
  { id: "table", icon: "cards", title: "tableTitle", hint: "tableHint" },
];

/** Scroll to the "Add a list" tree and put the focus in it. */
export function goToAddTree() {
  const tree = document.getElementById(WORDS_ADD_HASH);
  if (!tree) return;
  tree.scrollIntoView({ block: "start", behavior: "smooth" });
  tree.querySelector<HTMLElement>('[role="treeitem"], button')?.focus({ preventScroll: true });
}

/** The button; the panel renders where the parent puts `panel` (under the title row). */
export function useImportPanel({ onAdded }: { onAdded: () => void }): {
  button: ReactNode;
  panel: ReactNode;
} {
  const t = useIntlayer("words-import-panel");
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<SourceId | null>(null);
  const close = () => {
    setOpen(false);
    setSource(null);
  };

  const button = (
    <button
      type="button"
      data-qa="words-import-button"
      aria-expanded={open}
      aria-controls="words-import-panel"
      aria-label={t.importLabel.value}
      title={t.importLabel.value}
      onClick={() => (open ? close() : setOpen(true))}
      className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium ${
        open
          ? "bg-[oklch(0.5_0.14_155)] text-[oklch(0.99_0_0)]"
          : "bg-[oklch(0.55_0.14_155/0.15)] text-[oklch(0.38_0.12_155)] hover:bg-[oklch(0.55_0.14_155/0.25)] dark:text-[oklch(0.85_0.12_155)]"
      }`}
    >
      <Icon name="uploadSimple" />
      {t.importButton}
    </button>
  );

  const panel = open && (
    <div
      id="words-import-panel"
      data-qa="words-import-panel"
      className="mt-3 rounded-xl border border-[oklch(0.5_0_0/0.2)] bg-[oklch(0.5_0_0/0.04)] p-3"
    >
      <div className="flex items-start gap-2">
        <ul className="grid flex-1 gap-2 sm:grid-cols-2" role="list">
          {SOURCES.map((s) => {
            const on = source === s.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  data-qa={`words-import-${s.id}`}
                  aria-pressed={s.id === "table" ? on : undefined}
                  onClick={() => {
                    if (s.id === "preset") {
                      close();
                      requestAnimationFrame(goToAddTree);
                    } else setSource(on ? null : s.id);
                  }}
                  className={`flex min-h-11 w-full items-start gap-3 rounded-lg border px-3 py-2 text-start ${
                    on
                      ? "border-[oklch(0.5_0.14_155)] bg-[oklch(0.55_0.14_155/0.12)]"
                      : "border-[oklch(0.5_0_0/0.2)] hover:bg-[oklch(0.5_0_0/0.08)]"
                  }`}
                >
                  <Icon name={s.icon} className="mt-0.5 text-lg" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{t[s.title]}</span>
                    <span className="block text-xs text-[oklch(0.42_0_0)] dark:text-[oklch(0.8_0_0)]">
                      {t[s.hint]}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={close}
          aria-label={t.close.value}
          title={t.close.value}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[oklch(0.5_0_0/0.1)]"
        >
          <Icon name="x" />
        </button>
      </div>
      {source === "table" && (
        <div className="mt-4" data-qa="words-import-table-body">
          <WordListImport signedIn embedded onAdded={() => onAdded()} />
        </div>
      )}
    </div>
  );

  return { button, panel };
}

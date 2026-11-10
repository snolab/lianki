"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { reasonOf, reasonText } from "@/lib/words/error-reason";
import { SettingsSheet } from "./SettingsSheet";
import {
  previewLoader,
  previewSize,
  windowOf,
  type PreviewEntry,
  type PreviewSource,
  type PreviewState,
} from "@/lib/words/list-preview";
import { backParts } from "@/lib/words/row-layout";

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/** The eye on a row of the "Add a list" tree: opens its preview (own SVG). */
export function PreviewButton({
  name,
  onOpen,
}: {
  name: string;
  onOpen: (from: HTMLElement) => void;
}) {
  const text = useIntlayer("words-list-preview");
  const label = fill(text.open.value, { name });
  return (
    <button
      type="button"
      onClick={(e) => onOpen(e.currentTarget)}
      aria-label={label}
      title={label}
      data-list-preview-open
      className="grid size-11 shrink-0 place-items-center rounded-lg opacity-55 hover:bg-[oklch(0.5_0_0/0.1)] hover:opacity-100 focus-visible:opacity-100"
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
        <path
          d="M2.5 12c2.2-4.2 5.4-6.5 9.5-6.5s7.3 2.3 9.5 6.5c-2.2 4.2-5.4 6.5-9.5 6.5S4.7 16.2 2.5 12Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </button>
  );
}

/**
 * The preview of a built-in list, a phrase deck or a coverage band (lib/words/
 * list-preview.ts), in the /words modal sheet: a bottom sheet on a phone, a
 * centred dialog on wide screens, one glass layer. Title, the list's size,
 * then every entry in the list's order — word, example, meaning (BACK_ORDER) —
 * rendered only near the view and loaded as the reader nears the end. The
 * action adds the list(s) and closes; studying never starts from here.
 */
export function ListPreview({
  title,
  lang,
  sources,
  fetchEntries,
  allAdded,
  busy,
  onAdd,
  onClose,
  returnTo,
}: {
  title: string;
  /** The entries' language (a band's lists share one). */
  lang: string;
  sources: PreviewSource[];
  fetchEntries: (path: string) => Promise<PreviewEntry[]>;
  /** Every list of the preview is already one of his. */
  allAdded: boolean;
  busy: boolean;
  onAdd: () => void;
  onClose: () => void;
  returnTo: React.RefObject<HTMLElement | null>;
}) {
  const text = useIntlayer("words-list-preview");
  const whyText = useIntlayer("words-status");
  const { locale } = useLocale();
  const loader = useMemo(() => previewLoader(sources, fetchEntries), [sources, fetchEntries]);
  const [state, setState] = useState<PreviewState<PreviewEntry>>(loader.state);
  const more = useCallback(() => {
    void loader.more().then((s) => setState({ ...s }));
  }, [loader]);
  useEffect(() => more(), [more]);

  // Virtual window over the sheet's own scroller.
  const content = useRef<HTMLDivElement>(null);
  const heights = useRef<number[]>([]);
  const [scroll, setScroll] = useState({ top: 0, view: 0 });
  const [, setMeasured] = useState(0);
  useLayoutEffect(() => {
    const el = content.current?.closest<HTMLElement>("[data-words-settings-body]");
    if (!el) return;
    const read = () =>
      setScroll((p) => {
        const c = content.current;
        const at = c ? c.getBoundingClientRect().top - el.getBoundingClientRect().top : 0;
        const top = Math.max(0, -at);
        return p.top === top && p.view === el.clientHeight ? p : { top, view: el.clientHeight };
      });
    read();
    el.addEventListener("scroll", read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", read);
      ro.disconnect();
    };
  }, []);
  const known = heights.current.filter(Boolean);
  const estimate = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 56;
  const view = scroll.view || 800;
  const win = windowOf(state.rows.length, heights.current, estimate, scroll.top, view, view);
  // Measure what was rendered; a changed height re-runs the window.
  useLayoutEffect(() => {
    let changed = false;
    content.current?.querySelectorAll<HTMLElement>("[data-preview-row]").forEach((r) => {
      const i = Number(r.dataset.previewRow);
      const h = r.offsetHeight;
      if (h && heights.current[i] !== h) {
        heights.current[i] = h;
        changed = true;
      }
    });
    if (changed) setMeasured((n) => n + 1);
  });
  // Near the end of what is loaded: load the next list.
  const nearEnd = state.rows.length - win.end < 20 || win.after < view;
  useEffect(() => {
    if (nearEnd && !state.done && !state.error) more();
  }, [nearEnd, state.done, state.error, state.rows.length, more]);

  const size = state.done ? state.rows.length : previewSize(sources);
  const action = allAdded ? text.added : text.add;
  return (
    <SettingsSheet
      title={
        <span className="flex flex-col">
          <span data-list-preview-title>{title}</span>
          <span className="fs-11 font-normal tabular-nums opacity-60" data-list-preview-size>
            {fill(text.size.value, { count: size.toLocaleString(locale) })}
          </span>
        </span>
      }
      label={title}
      closeLabel={text.close.value}
      onClose={onClose}
      returnTo={returnTo}
      footer={
        <button
          type="button"
          disabled={allAdded || busy}
          onClick={onAdd}
          data-list-preview-add
          className="min-h-11 w-full rounded-lg bg-[oklch(0.55_0.14_155)] px-4 text-sm font-medium text-[oklch(0.99_0_0)] hover:bg-[oklch(0.5_0.14_155)] disabled:opacity-40"
        >
          {action}
        </button>
      }
    >
      <div ref={content} className="min-h-[50dvh]" data-list-preview>
        <ol
          style={{ paddingTop: win.before, paddingBottom: win.after }}
          aria-busy={!state.done}
          aria-setsize={size}
        >
          {state.rows.slice(win.start, win.end).map((e, k) => {
            const i = win.start + k;
            const example = e.ex || e.note;
            return (
              <li
                key={`${e.listId}\u0000${e.term}`}
                data-preview-row={i}
                aria-posinset={i + 1}
                className="py-2"
              >
                <p className="font-medium" lang={lang}>
                  {e.term}
                  {e.reading && e.reading !== e.term && (
                    <span className="ms-2 font-normal opacity-55">{e.reading}</span>
                  )}
                </p>
                {backParts(e).map((part) =>
                  part === "example" ? (
                    <p
                      key={part}
                      lang={e.ex ? lang : undefined}
                      className="opacity-80"
                      data-preview-example
                    >
                      {example}
                    </p>
                  ) : (
                    <p key={part} className="opacity-55" data-preview-meaning>
                      {e.back}
                    </p>
                  ),
                )}
              </li>
            );
          })}
        </ol>
        {state.error ? (
          <p className="flex flex-wrap items-center gap-2 py-3 opacity-80" data-list-preview-error>
            <span>
              {fill(text.failed.value, {
                // Plain words, never the download's own error text.
                error: reasonText(whyText, reasonOf(new Error(state.error), "preview")),
              })}
            </span>
            <button
              type="button"
              onClick={() => {
                setState((s) => ({ ...s, error: undefined }));
                more();
              }}
              className="min-h-11 rounded-lg px-3 font-medium text-[oklch(0.5_0.14_155)] hover:bg-[oklch(0.5_0_0/0.1)] dark:text-[oklch(0.78_0.13_155)]"
            >
              {text.retry}
            </button>
          </p>
        ) : (
          !state.done && (
            <p className="py-3 opacity-50" role="status" data-list-preview-loading>
              {text.loading}
            </p>
          )
        )}
      </div>
    </SettingsSheet>
  );
}

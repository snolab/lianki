"use client";

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import type { TocItem } from "@/lib/books/toc";

/** Smooth scrolling unless the viewer asked for reduced motion. */
function jump(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  history.replaceState(null, "", `#${id}`);
}

/**
 * The section in view: an IntersectionObserver on each top-level section
 * (no polling, no scroll handler). The first section crossing the upper part
 * of the viewport is current; when none is, the last one seen stays.
 */
function useCurrent(items: TocItem[]): string {
  const ids = items.map((i) => i.id).join(" ");
  const [current, setCurrent] = useState(items[0]?.id ?? "");
  useEffect(() => {
    const list = ids ? ids.split(" ") : [];
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const first = list.find((id) => visible.has(id));
        if (first) setCurrent(first);
      },
      { rootMargin: "-15% 0px -70% 0px" },
    );
    for (const id of list) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [ids]);
  return current;
}

function Entries({
  items,
  current,
  onPick,
}: {
  items: TocItem[];
  current: string;
  onPick: (id: string) => void;
}) {
  const link = (it: TocItem, sub: boolean) => {
    const on = it.id === current;
    return (
      <a
        href={`#${it.id}`}
        onClick={(e) => {
          e.preventDefault();
          onPick(it.id);
        }}
        aria-current={on ? "location" : undefined}
        data-testid="books-toc-link"
        className={`block rounded-md px-3 py-1.5 transition-colors motion-reduce:transition-none ${
          sub ? "ps-6 text-xs" : "text-sm"
        } ${
          on
            ? "bg-blue-600/10 text-blue-700 dark:text-blue-300 font-medium"
            : "text-gray-600 dark:text-gray-400 hover:bg-gray-500/10"
        }`}
      >
        {it.label}
      </a>
    );
  };
  return (
    <ul>
      {items.map((it) => (
        <li key={it.id}>
          {link(it, false)}
          {it.children && (
            <ul>
              {it.children.map((c) => (
                <li key={c.id}>{link(c, true)}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The /books table of contents. From the desktop up: a sticky index beside
 * the list. On a phone: a sticky glass bar naming the current section that
 * opens a sheet of the same entries.
 */
export function BooksToc({ items, variant }: { items: TocItem[]; variant: "side" | "bar" }) {
  const t = useIntlayer("books-page");
  const current = useCurrent(items);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!items.length) return null;

  if (variant === "side")
    return (
      <nav aria-label={t.tocLabel.value} className="sticky top-6" data-testid="books-toc">
        <p className="px-3 mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t.tocLabel}
        </p>
        <Entries items={items} current={current} onPick={jump} />
      </nav>
    );

  const label = items.find((i) => i.id === current)?.label ?? items[0].label;
  return (
    <div className="lg:hidden sticky top-0 z-20 -mx-4 sm:-mx-6 mb-6" data-testid="books-toc-bar">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="lk-glass w-full flex items-center gap-2 px-4 sm:px-6 py-2.5 text-sm border-b border-[var(--glass-line)]"
      >
        <Icon name="list" className="text-lg" />
        <span className="text-gray-500 dark:text-gray-400">{t.tocLabel}</span>
        <span className="font-medium truncate">{label}</span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end"
          role="dialog"
          aria-modal="true"
          aria-label={t.tocLabel.value}
        >
          <button
            type="button"
            aria-label={t.tocClose.value}
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div className="relative w-full max-h-[70vh] overflow-y-auto rounded-t-2xl bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 px-3 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="flex items-center justify-between px-3 mb-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t.tocLabel}
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t.tocClose.value}
                className="p-2 -me-2 text-gray-500 dark:text-gray-400"
              >
                <Icon name="x" className="text-lg" />
              </button>
            </div>
            <Entries
              items={items}
              current={current}
              onPick={(id) => {
                setOpen(false);
                // After the sheet is gone, so the page can scroll.
                requestAnimationFrame(() => jump(id));
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

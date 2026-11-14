"use client";

import { useEffect, useState } from "react";

export type TocSection = {
  id: string;
  title: string;
};

/**
 * The media query matching screens wide enough to not collapse sections (owner: <35em folds on phones).
 */
export const WIDE_PREFS_QUERY = "(min-width: 35em)";

/** Smooth scrolling with reduced-motion check. */
export function jumpToSection(id: string) {
  const el = typeof document !== "undefined" ? document.getElementById(id) : null;
  if (!el) return;
  const reduce =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  if (typeof history !== "undefined" && history.replaceState) {
    history.replaceState(null, "", `#${id}`);
  }
}

/** IntersectionObserver logic to observe sections. */
export function observeSectionVisibility(
  sections: TocSection[],
  onIntersect: (id: string) => void,
) {
  if (typeof IntersectionObserver === "undefined" || !sections.length) return () => {};
  const ids = sections.map((s) => s.id);
  const visible = new Set<string>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      }
      const first = ids.find((id) => visible.has(id));
      if (first) onIntersect(first);
    },
    { rootMargin: "-10% 0px -65% 0px" },
  );

  for (const id of ids) {
    const el = typeof document !== "undefined" ? document.getElementById(id) : null;
    if (el) io.observe(el);
  }
  return () => io.disconnect();
}

/** IntersectionObserver to mark current active section. */
export function useActiveSection(sections: TocSection[]): string {
  const [current, setCurrent] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    return observeSectionVisibility(sections, (first) => setCurrent(first));
  }, [sections]);

  return current;
}

/** Helper to observe media query changes. */
export function observeMediaQuery(query: string, onChange: (matches: boolean) => void) {
  if (typeof matchMedia === "undefined") return () => {};
  const mq = matchMedia(query);
  const on = () => onChange(mq.matches);
  on();
  mq.addEventListener("change", on);
  return () => mq.removeEventListener("change", on);
}

/** Whether the screen is wide (>=35em), avoiding collapse. */
export function useIsWideScreen(): boolean {
  const [wide, setWide] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia(WIDE_PREFS_QUERY).matches,
  );

  useEffect(() => {
    return observeMediaQuery(WIDE_PREFS_QUERY, (matches) => setWide(matches));
  }, []);

  return wide;
}

export function PreferencesToc({
  label,
  sections,
  activeId,
  onSelect,
}: {
  label: string;
  sections: TocSection[];
  activeId?: string;
  onSelect?: (id: string) => void;
}) {
  const observed = useActiveSection(sections);
  const current = activeId ?? observed;

  const handleSelect = (id: string) => {
    onSelect?.(id);
    jumpToSection(id);
  };

  return (
    <div className="w-full">
      {/* Mobile: Horizontal scrollable chips sticky near the top */}
      <div className="lg:hidden mb-6 -mx-4 px-4 overflow-x-auto no-scrollbar py-1">
        <nav aria-label={label} className="flex gap-2 min-w-max">
          {sections.map((s) => {
            const active = current === s.id;
            return (
              <button
                key={s.id}
                type="button"
                data-testid={`toc-chip-${s.id}`}
                onClick={() => handleSelect(s.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full transition-all whitespace-nowrap ${
                  active
                    ? "bg-blue-600 text-white shadow-sm dark:bg-blue-500"
                    : "bg-black/5 dark:bg-white/10 text-gray-700 dark:text-gray-300 hover:bg-black/10 dark:hover:bg-white/20"
                }`}
              >
                {s.title}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Desktop sidebar navigation */}
      <nav
        aria-label={label}
        className="hidden lg:block sticky top-8 space-y-3"
        data-testid="preferences-toc"
      >
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {label}
        </h2>
        <ul className="space-y-1 text-sm border-s border-black/10 dark:border-white/10 ps-3">
          {sections.map((s) => {
            const active = current === s.id;
            return (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  data-testid={`toc-link-${s.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    handleSelect(s.id);
                  }}
                  className={`block py-1 text-sm transition-colors -ms-[13px] ps-3 border-s-2 ${
                    active
                      ? "border-blue-600 font-medium text-blue-600 dark:border-blue-400 dark:text-blue-400"
                      : "border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
                  }`}
                >
                  {s.title}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/**
 * A collapsible preference section wrapper.
 * On phones (<35em), non-active sections are folded by default, expanding upon tapping their header.
 * On wider screens (>=35em), all sections stay expanded and the title acts normally.
 */
export function CollapsibleSection({
  id,
  title,
  isOpen,
  isWide,
  onToggle,
  className = "",
  children,
}: {
  id: string;
  title: string;
  isOpen: boolean;
  isWide: boolean;
  onToggle?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const open = isWide || isOpen;

  return (
    <section
      id={id}
      data-section={id}
      data-open={open ? "true" : "false"}
      className={`scroll-mt-6 mb-8 border-b border-black/5 pb-8 last:border-b-0 dark:border-white/5 ${className}`}
    >
      {/* Clickable accordion header for phone screens (<35em) */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`${id}-content`}
        className="group flex w-full items-center justify-between py-2 text-start transition-opacity select-none focus:outline-none min-[35em]:cursor-default min-[35em]:pointer-events-none"
      >
        <h2 className="text-2xl font-semibold text-gray-900 transition-colors group-hover:text-blue-600 dark:text-white dark:group-hover:text-blue-400 min-[35em]:group-hover:text-gray-900 min-[35em]:dark:group-hover:text-white">
          {title}
        </h2>
        {/* Chevron icon visible only on mobile (<35em) */}
        <span
          aria-hidden="true"
          className="grid h-8 w-8 place-items-center rounded-full text-gray-400 transition-transform duration-200 min-[35em]:hidden"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>

      {/* Section body */}
      <div id={`${id}-content`} className={open ? "mt-4 block" : "mt-4 hidden min-[35em]:block"}>
        {children}
      </div>
    </section>
  );
}

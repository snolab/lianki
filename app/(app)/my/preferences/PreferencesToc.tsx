"use client";

import { useEffect, useMemo, useState } from "react";
import {
  groupPreferenceSections,
  type TocSection,
  type GroupedTocSection,
  type PreferenceGroupLabels,
  type TocGroup,
} from "./preferences-toc-groups";
export type { TocSection } from "./preferences-toc-groups";

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

const chipClass = (active: boolean) =>
  `min-h-10 shrink-0 rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
    active
      ? "bg-primary text-on-primary"
      : "bg-black/5 text-gray-700 hover:bg-black/10 dark:bg-white/10 dark:text-gray-300 dark:hover:bg-white/20"
  }`;

export function PreferencesToc({
  label,
  sections,
  groupLabels,
  activeId,
  onSelect,
}: {
  label: string;
  sections: GroupedTocSection[];
  groupLabels: PreferenceGroupLabels;
  activeId?: string;
  onSelect?: (id: string) => void;
}) {
  const observed = useActiveSection(sections);
  const current = activeId ?? observed;
  const groups = useMemo(
    () => groupPreferenceSections(sections, groupLabels),
    [sections, groupLabels],
  );
  const activeGroup = sections.find((section) => section.id === current)?.group ?? groups[0]?.id;
  // A manual disclosure belongs to this reading position; a new section follows its category.
  const [expansion, setExpansion] = useState<{ at: string; group: string } | null>(null);
  const expandedGroup = expansion && expansion.at === current ? expansion.group : activeGroup;
  const setExpanded = (group: string) => setExpansion({ at: current, group });
  const selected =
    groups.find((group) => group.id === expandedGroup) ??
    groups.find((group) => group.id === activeGroup) ??
    groups[0];

  const handleSelect = (id: string) => {
    onSelect?.(id);
    jumpToSection(id);
  };
  const selectGroup = (group: TocGroup) => {
    setExpanded(group.id);
    const first = group.sections[0];
    if (first) handleSelect(first.id);
  };

  if (!groups.length) return null;
  return (
    <div className="w-full">
      {/* Compact navigation keeps the category level separate from its settings. */}
      <div
        data-testid="preferences-toc-compact"
        className="@min-[64rem]/preferences:hidden -mx-4 mb-6 border-b border-[var(--glass-line)] px-4 py-2 lk-glass"
      >
        <nav aria-label={label} className="space-y-2">
          <div className="flex gap-2 overflow-x-auto no-scrollbar">
            {groups.map((group) => (
              <button
                key={group.id}
                type="button"
                data-testid={`toc-category-${group.id}`}
                aria-pressed={selected?.id === group.id}
                onClick={() => selectGroup(group)}
                className={chipClass(selected?.id === group.id)}
              >
                {group.title}
              </button>
            ))}
          </div>
          {selected && (
            <div
              role="group"
              aria-label={selected.title}
              className="flex gap-2 overflow-x-auto no-scrollbar"
            >
              {selected.sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  data-testid={`toc-chip-${section.id}`}
                  onClick={() => handleSelect(section.id)}
                  className={chipClass(current === section.id)}
                >
                  {section.title}
                </button>
              ))}
            </div>
          )}
        </nav>
      </div>
      <nav
        aria-label={label}
        className="hidden @min-[64rem]/preferences:block max-h-[calc(100dvh-4rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] overflow-y-auto overscroll-contain space-y-3"
        data-testid="preferences-toc"
      >
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {label}
        </h2>
        <ul className="space-y-1 text-sm">
          {groups.map((group) => {
            const open = expandedGroup === group.id;
            return (
              <li key={group.id}>
                <button
                  type="button"
                  data-testid={`toc-group-${group.id}`}
                  aria-expanded={open}
                  aria-controls={`preferences-toc-${group.id}`}
                  onClick={() => setExpanded(open ? "" : group.id)}
                  className={`flex min-h-10 w-full items-center justify-between gap-2 rounded px-2 py-2 text-start font-medium ${activeGroup === group.id ? "text-primary" : "text-gray-700 dark:text-gray-300"}`}
                >
                  <span>{group.title}</span>
                  <span
                    aria-hidden="true"
                    className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </span>
                </button>
                <ul
                  id={`preferences-toc-${group.id}`}
                  hidden={!open}
                  className="ms-2 space-y-1 border-s border-black/10 ps-3 dark:border-white/10"
                >
                  {group.sections.map((section) => (
                    <li key={section.id}>
                      <a
                        href={`#${section.id}`}
                        data-testid={`toc-link-${section.id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          handleSelect(section.id);
                        }}
                        className={`-ms-[13px] flex min-h-10 items-center border-s-2 py-2 ps-3 text-sm transition-colors ${current === section.id ? "border-primary font-medium text-primary" : "border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"}`}
                      >
                        {section.title}
                      </a>
                    </li>
                  ))}
                </ul>
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
      className={`scroll-mt-14 mb-8 border-b border-black/5 pb-8 last:border-b-0 dark:border-white/5 ${className}`}
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

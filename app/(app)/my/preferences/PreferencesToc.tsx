"use client";

import { useEffect, useState } from "react";

export type TocSection = {
  id: string;
  title: string;
};

/** Smooth scrolling with reduced-motion check. */
function jump(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  if (typeof history !== "undefined" && history.replaceState) {
    history.replaceState(null, "", `#${id}`);
  }
}

/** IntersectionObserver to mark current active section. */
function useCurrent(sections: TocSection[]): string {
  const [current, setCurrent] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    if (!sections.length) return;
    const ids = sections.map((s) => s.id);
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const first = ids.find((id) => visible.has(id));
        if (first) setCurrent(first);
      },
      { rootMargin: "-10% 0px -65% 0px" },
    );

    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [sections]);

  return current;
}

export function PreferencesToc({ label, sections }: { label: string; sections: TocSection[] }) {
  const current = useCurrent(sections);

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
                onClick={() => jump(s.id)}
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
                  onClick={(e) => {
                    e.preventDefault();
                    jump(s.id);
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

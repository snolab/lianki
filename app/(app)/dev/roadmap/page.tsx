import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import { appLocale } from "@/lib/app-locale.server";
import { StateTreeDoc } from "@/app/components/StateTreeDoc";
import { ROADMAP, STATUS_ORDER, type RoadmapItem, type RoadmapStatus } from "./items";

// Owner-only. Anyone else — guests included — gets a plain 404, so the page's
// existence is not revealed. Not linked from the nav.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { metaTitle } = getIntlayer("dev-roadmap", await appLocale());
  return {
    title: String(metaTitle),
    robots: { index: false, follow: false, nocache: true },
  };
}

const ACCENT: Record<RoadmapStatus, string> = {
  doing: "border-s-blue-600",
  waiting: "border-s-amber-500",
  queued: "border-s-gray-500",
  planned: "border-s-gray-300 dark:border-s-gray-700 border-dashed",
  done: "border-s-green-600",
};

const LINK = "text-blue-700 dark:text-blue-300 hover:underline";

export default async function DevRoadmapPage() {
  const user = await authUserOrNull();
  if (!isDev(user?.email)) notFound();

  const locale = await appLocale();
  const c = getIntlayer("dev-roadmap", locale);
  const groups = STATUS_ORDER.map((status) => ({
    status,
    label: String(c.status[status]),
    items: ROADMAP.filter((i) => i.status === status),
  }));

  const tocLinks = (
    <ol className="space-y-1 text-sm">
      <li>
        <a href="#tree" className={LINK}>
          {String(c.stateTree)}
        </a>
      </li>
      {groups.map((g) => (
        <li key={g.status} className="flex items-baseline justify-between gap-2">
          <a href={`#${g.status}`} className={LINK}>
            {g.label}
          </a>
          <span className="tabular-nums opacity-70">{g.items.length}</span>
        </li>
      ))}
    </ol>
  );

  const list = (items: RoadmapItem[], status: RoadmapStatus) => (
    <ul className="space-y-2">
      {items.map((item) => (
        <li
          key={item.id}
          className={`rounded-xl border border-black/10 dark:border-white/10 border-s-4 ${ACCENT[status]} bg-white/60 dark:bg-gray-900/60 px-4 py-3`}
        >
          <p className="font-medium leading-snug">{String(c.items[item.id])}</p>
          {item.prs && item.prs.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-x-2 text-sm tabular-nums">
              {item.prs.map((pr) => (
                <a
                  key={pr}
                  href={`https://github.com/snolab/lianki/pull/${pr}`}
                  className={LINK}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{pr}
                </a>
              ))}
            </p>
          )}
          {item.link && (
            <a
              href={item.link}
              className={`mt-1 inline-block text-sm break-all ${LINK}`}
              target="_blank"
              rel="noreferrer"
            >
              {item.link.replace(/^https?:\/\//, "")}
            </a>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div
      lang={locale}
      className="max-w-5xl mx-auto px-4 py-8 lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8"
    >
      {/* Contents: a sticky sidebar on a desktop, a folded box at the top on a phone. */}
      <aside className="hidden lg:block">
        <nav aria-label={String(c.toc)} className="sticky top-4 space-y-2" data-roadmap-toc>
          <h2 className="text-xs font-semibold uppercase tracking-wide opacity-70">
            {String(c.toc)}
          </h2>
          {tocLinks}
        </nav>
      </aside>

      <div className="min-w-0 space-y-10">
        <header className="space-y-1">
          <h1 className="font-brush text-4xl">{String(c.heading)}</h1>
          <p className="text-sm opacity-75">{String(c.intro)}</p>
        </header>

        <details className="lg:hidden rounded-xl border border-black/10 dark:border-white/10 px-4 py-2">
          <summary className="cursor-pointer text-sm font-semibold">{String(c.toc)}</summary>
          <nav aria-label={String(c.toc)} className="pt-2 pb-1">
            {tocLinks}
          </nav>
        </details>

        <div id="tree" className="scroll-mt-4">
          <StateTreeDoc />
        </div>

        {groups.map(({ status, label, items }) => {
          const heading = (
            <>
              {label}
              <span className="text-sm opacity-70 tabular-nums">{items.length}</span>
            </>
          );
          if (status === "done") {
            // Folded by default; the id sits on <details> itself, so a contents
            // link lands on its summary without needing to open it.
            return (
              <details key={status} id={status} className="scroll-mt-4 group" data-status={status}>
                <summary className="cursor-pointer font-antique text-xl flex items-baseline gap-2 list-none [&::-webkit-details-marker]:hidden">
                  <span
                    aria-hidden
                    className="inline-block transition-transform group-open:rotate-90"
                  >
                    ›
                  </span>
                  {heading}
                </summary>
                <div className="mt-3">{list(items, status)}</div>
              </details>
            );
          }
          return (
            <section
              key={status}
              id={status}
              className="scroll-mt-4 space-y-3"
              data-status={status}
            >
              <h2 className="font-antique text-xl flex items-baseline gap-2">{heading}</h2>
              {items.length === 0 ? <p className="text-sm opacity-70">—</p> : list(items, status)}
            </section>
          );
        })}
      </div>
    </div>
  );
}

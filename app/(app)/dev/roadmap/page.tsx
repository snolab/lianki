import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { ROADMAP, STATUS_LABEL, STATUS_ORDER, type RoadmapStatus } from "./items";

// Owner-only. Anyone else — guests included — gets a plain 404, so the page's
// existence is not revealed. Not linked from the nav.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dev roadmap — Lianki",
  robots: { index: false, follow: false, nocache: true },
};

const ACCENT: Record<RoadmapStatus, string> = {
  doing: "border-s-blue-600",
  deciding: "border-s-gray-500",
  shipped: "border-s-gray-300 dark:border-s-gray-700",
  ideas: "border-s-gray-300 dark:border-s-gray-700 border-dashed",
};

export default async function DevRoadmapPage() {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) notFound();

  return (
    <main lang="zh" className="max-w-3xl mx-auto px-4 py-8 space-y-10">
      <header className="space-y-1">
        <h1 className="font-brush text-4xl">路线图</h1>
        <p className="text-sm opacity-60">
          只有你能看到这页。编辑 app/(app)/dev/roadmap/items.ts。
        </p>
      </header>

      {STATUS_ORDER.map((status) => {
        const items = ROADMAP[status];
        return (
          <section key={status} className="space-y-3" data-status={status}>
            <h2 className="font-antique text-xl flex items-baseline gap-2">
              {STATUS_LABEL[status]}
              <span className="text-sm opacity-50 tabular-nums">{items.length}</span>
            </h2>
            {items.length === 0 ? (
              <p className="text-sm opacity-50">—</p>
            ) : (
              <ul className="space-y-2">
                {items.map((item) => (
                  <li
                    key={item.pr ?? item.title}
                    className={`rounded-xl border border-black/10 dark:border-white/10 border-s-4 ${ACCENT[status]} bg-white/60 dark:bg-gray-900/60 px-4 py-3`}
                  >
                    <div className="flex items-baseline gap-2">
                      {item.pr != null && (
                        <a
                          href={`https://github.com/snolab/lianki/pull/${item.pr}`}
                          className="text-sm tabular-nums text-blue-600 dark:text-blue-400 hover:underline shrink-0"
                          target="_blank"
                          rel="noreferrer"
                        >
                          #{item.pr}
                        </a>
                      )}
                      <span className="font-medium">{item.title}</span>
                    </div>
                    {item.detail && (
                      <p className="mt-1 text-sm leading-relaxed opacity-75">{item.detail}</p>
                    )}
                    {item.link && (
                      <a
                        href={item.link}
                        className="mt-1 inline-block text-sm text-blue-600 dark:text-blue-400 hover:underline break-all"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {item.link.replace(/^https?:\/\//, "")}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </main>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import { appLocale } from "@/lib/app-locale.server";
import { StateTreeDoc } from "@/app/components/StateTreeDoc";
import { RoadmapBoard } from "./RoadmapBoard";

// Owner-only. Anyone else — guests included — gets a plain 404, so the page's
// existence is not revealed. Not linked from the nav. Every item is a state
// tree node (docs/planning-tools.md): the board reads the hub on the owner's
// progress socket; only the page chrome is translated.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { metaTitle } = getIntlayer("dev-roadmap", await appLocale());
  return {
    title: String(metaTitle),
    robots: { index: false, follow: false, nocache: true },
  };
}

export default async function DevRoadmapPage() {
  const user = await authUserOrNull();
  if (!isDev(user?.email)) notFound();

  const locale = await appLocale();
  const c = getIntlayer("dev-roadmap", locale);
  return (
    <div
      lang={locale}
      className="max-w-5xl mx-auto px-4 py-8 lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8"
    >
      <RoadmapBoard
        labels={{
          toc: String(c.toc),
          stateTree: String(c.stateTree),
          sections: {
            doing: String(c.status.doing),
            waiting: String(c.status.waiting),
            queued: String(c.status.queued),
            done: String(c.status.done),
          },
          doneKind: {
            verified: String(c.doneKind.verified),
            unverified: String(c.doneKind.unverified),
          },
          connecting: String(c.connecting),
          empty: String(c.empty),
        }}
        header={
          <header className="space-y-1">
            <h1 className="font-brush text-4xl">{String(c.heading)}</h1>
            <p className="text-sm opacity-75">{String(c.intro)}</p>
          </header>
        }
        tree={<StateTreeDoc />}
      />
    </div>
  );
}

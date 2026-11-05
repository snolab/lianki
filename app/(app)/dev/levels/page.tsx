import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { LEVEL_IDS } from "@/lib/levels";
import { LevelGallery, type LevelNames } from "./LevelGallery";

// Owner-only gallery of the learner level badges (docs/levels.md); anyone
// else gets a plain 404. Nothing user-facing shows these yet.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Learner levels — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
};

function names(locale: "zh" | "en"): LevelNames {
  const d = getIntlayer("learner-levels", locale);
  return Object.fromEntries(LEVEL_IDS.map((id) => [id, String(d[id])])) as LevelNames;
}

export default async function DevLevelsPage() {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) notFound();
  return (
    <main className="max-w-5xl mx-auto px-4 py-6">
      <LevelGallery zh={names("zh")} en={names("en")} />
    </main>
  );
}

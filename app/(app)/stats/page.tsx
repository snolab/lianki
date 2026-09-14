import type { Metadata } from "next";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import StatsClient from "./StatsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  return {
    title: "Input hours - Lianki",
    description: "Active listening time per video, by language, with a daily heatmap.",
    ...generateAppHreflangMetadata(locale, "/stats"),
  };
}

export default function StatsPage() {
  // The (app) layout supplies the shell, auth and the Intlayer providers, so the
  // page is just its client body.
  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <StatsClient />
      </div>
    </div>
  );
}

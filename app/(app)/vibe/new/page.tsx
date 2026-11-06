import { vibeMetadata, vibePage } from "@/lib/vibe/page-gate";
import VibeClient from "../VibeClient";

export const dynamic = "force-dynamic";
export const generateMetadata = vibeMetadata;

/** /vibe/new (docs/vibe.md, "Pages"): where Start lives. */
export default async function VibeNewPage() {
  const { locale } = await vibePage();
  return <VibeClient locale={locale} />;
}

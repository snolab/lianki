import { notFound } from "next/navigation";
import { vibeMetadata, vibePage } from "@/lib/vibe/page-gate";
import { getDocLog } from "@/lib/vibe/store";
import { docTranslations } from "@/lib/vibe/translate-server";
import VibeClient from "../VibeClient";

export const dynamic = "force-dynamic";
export const generateMetadata = vibeMetadata;

/**
 * /vibe/<id> (docs/vibe.md, "Pages"): one conversation's log, by the doc's random
 * id. Only this user's own: anything else is 404, as for a doc that does not exist.
 */
export default async function VibeLogPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId, db, locale } = await vibePage();
  const log = await getDocLog(db, userId, (await params).id);
  if (!log) notFound();
  return (
    <VibeClient
      locale={locale}
      doc={{
        id: log.id,
        material: log.material,
        title: log.title,
        status: log.status,
        next: log.next,
        translations: await docTranslations(db, log.id),
        lines: log.text.map((text, i) => ({ text, lang: log.lineLangs[i] })),
      }}
    />
  );
}

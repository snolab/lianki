import { redirect } from "next/navigation";
import { vibeMetadata, vibePage } from "@/lib/vibe/page-gate";
import { listDocs } from "@/lib/vibe/store";
import { VibeList } from "./VibeList";

export const dynamic = "force-dynamic";
export const generateMetadata = vibeMetadata;

/** /vibe (docs/vibe.md, "Pages"): this user's conversations, newest first. */
export default async function VibeListPage({
  searchParams,
}: {
  searchParams: Promise<{ doc?: string | string[]; id?: string | string[] }>;
}) {
  const { userId, db, locale } = await vibePage();
  // A link that carried a conversation in its query goes to that conversation.
  const q = await searchParams;
  const doc = [q.doc, q.id].flat().find(Boolean);
  if (doc) redirect(`/vibe/${encodeURIComponent(doc)}`);
  return <VibeList rows={await listDocs(db, userId)} locale={locale} />;
}

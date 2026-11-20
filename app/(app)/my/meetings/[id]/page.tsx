import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull, signInRedirect } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import { MEETING_ID_RE } from "@/lib/meetings/core";
import { meetingsOpen } from "@/lib/meetings/gate";
import MeetingPlayer from "./MeetingPlayer";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { title } = getIntlayer("my-meetings", await appLocale());
  return { title: `${title} - Lianki`, robots: { index: false, follow: false } };
}

/** /my/meetings/<id> (docs/meetings.md, "Playback"): the player and the transcript. */
export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await authUserOrNull();
  if (!user) return signInRedirect();
  if (!(await meetingsOpen(user.email))) notFound();
  const { id } = await params;
  if (!MEETING_ID_RE.test(id)) notFound();
  return <MeetingPlayer id={id} />;
}

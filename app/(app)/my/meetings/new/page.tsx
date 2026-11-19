import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull, signInRedirect } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import { meetingsOpen } from "@/lib/meetings/gate";
import NewMeetingClient from "./NewMeetingClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { startTitle } = getIntlayer("my-meetings", await appLocale());
  return { title: `${startTitle} - Lianki`, robots: { index: false, follow: false } };
}

/** /my/meetings/new (docs/meetings.md, "Starting"): the start page. 404 unless meetings.record + dev. */
export default async function NewMeetingPage() {
  const user = await authUserOrNull();
  if (!user) return signInRedirect();
  if (!(await meetingsOpen(user.email))) notFound();
  return <NewMeetingClient />;
}

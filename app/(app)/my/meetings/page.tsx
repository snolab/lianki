import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull, signInRedirect } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import { meetingsOpen } from "@/lib/meetings/gate";
import MeetingsClient from "./MeetingsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { title } = getIntlayer("my-meetings", await appLocale());
  return { title: `${title} - Lianki`, robots: { index: false, follow: false } };
}

/** /my/meetings (docs/meetings.md, "Pages"): the list. 404 unless meetings.record + dev. */
export default async function MeetingsPage() {
  const user = await authUserOrNull();
  if (!user) return signInRedirect();
  if (!(await meetingsOpen(user.email))) notFound();
  return <MeetingsClient />;
}

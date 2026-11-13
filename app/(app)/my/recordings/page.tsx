import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull, signInRedirect } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import RecordingsClient from "./RecordingsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { title } = getIntlayer("my-recordings", await appLocale());
  return { title: `${title} - Lianki`, robots: { index: false, follow: false } };
}

/**
 * /my/recordings (docs/recordings.md): the account's kept mic recordings, by
 * day. Signed-in only; 404 unless the flag `voice.recordings` is on and the
 * account holds `dev` (the same gate as /api/my/recordings).
 */
export default async function RecordingsPage() {
  const user = await authUserOrNull();
  if (!user) return signInRedirect();
  if (!isDev(user.email) || !flagIn(await readFlags(), "voice.recordings")) notFound();
  return <RecordingsClient />;
}

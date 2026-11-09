import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { OptOutClient } from "./OptOutClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { optTitle } = getIntlayer("email-invite", await appLocale());
  return { title: `${String(optTitle)} - Lianki`, robots: { index: false, follow: false } };
}

/**
 * Where an invite email's Unsubscribe / Report abuse links land (no sign-in).
 * The token is in the URL fragment; the page POSTs it on a button press, never
 * on load, so a mail scanner opening the link changes nothing.
 */
export default function InviteOptOutPage() {
  return <OptOutClient />;
}

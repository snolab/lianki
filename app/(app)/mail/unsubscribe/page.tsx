import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { UnsubscribeClient } from "./UnsubscribeClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { title } = getIntlayer("mail-unsubscribe", await appLocale());
  return { title: `${String(title)} - Lianki`, robots: { index: false, follow: false } };
}

/**
 * Where a mail's Unsubscribe link lands (no sign-in; docs/mail-templates.md,
 * "Unsubscribe"). The token is in the URL fragment; the page POSTs it on a
 * button press, never on load, so a mail scanner opening the link changes
 * nothing. Once done it confirms and offers Undo.
 */
export default function MailUnsubscribePage() {
  return <UnsubscribeClient />;
}

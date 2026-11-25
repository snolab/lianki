import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { PER_ORIGIN_FLAG } from "@/lib/li-thread";
import SitesClient, { type SitesLabels } from "./SitesClient";
import PillInstallGuide, { type PillInstallLabels } from "./PillInstallGuide";
import { LIANKI_USERSCRIPT_VERSION } from "@/lib/userscript-version";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { metaTitle } = getIntlayer("chat-sites-page", await appLocale());
  return { title: String(metaTitle), robots: { index: false, follow: false } };
}

/**
 * /chat/sites (docs/userscript-li-chat.md, "Per-site threads"): the signed-in
 * user's Li chats from the pill, one per website, and each one opened to read
 * and go on chatting. Only on lianki.com, never on a host page; the list comes
 * from /api/chat/sites (the session's own account only). Not found while
 * `ext.pill-chat-per-origin` is off.
 */
export default async function ChatSitesPage() {
  if (!flagIn(await readFlags(), PER_ORIGIN_FLAG)) notFound();
  const locale = await appLocale();
  const labels = Object.fromEntries(
    Object.entries(getIntlayer("chat-sites-page", locale)).map(([k, v]) => [k, String(v)]),
  ) as unknown as SitesLabels;
  // The assistant's name is the chat's own (learning-partner.content.ts `name`).
  labels.agent = String(getIntlayer("learning-partner", locale).name);
  const user = await authUserOrNull();
  if (!user)
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="mb-4 text-2xl font-bold">{labels.title}</h1>
        <a href="/sign-in" className="text-[oklch(0.55_0.198_22.3)] underline">
          {labels.signIn}
        </a>
      </div>
    );
  const installLabels = Object.fromEntries(
    Object.entries(getIntlayer("pill-install", locale)).map(([k, v]) => [k, String(v)]),
  ) as PillInstallLabels;
  return (
    <SitesClient
      labels={labels}
      locale={locale}
      installGuide={
        <PillInstallGuide latestVersion={LIANKI_USERSCRIPT_VERSION} labels={installLabels} />
      }
    />
  );
}

import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { portableSource } from "@/lib/portable-chat-url";
import ChatLaunch from "./ChatLaunch";

export const dynamic = "force-dynamic";
export async function generateMetadata() {
  const t = getIntlayer("pill-chat", await appLocale());
  return { title: String(t.directTitle), robots: { index: false, follow: false } };
}
/** First-party chat destination. Source context is a link, never an automatic redirect or grant. */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const t = getIntlayer("pill-chat", await appLocale());
  const source = portableSource((await searchParams).from);
  return (
    <ChatLaunch
      title={String(t.directTitle)}
      openText={String(t.openChat)}
      source={source}
      returnText={String(t.returnSite)}
    />
  );
}

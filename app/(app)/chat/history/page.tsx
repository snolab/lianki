import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import HistoryClient, { type HistoryLabels } from "./HistoryClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { metaTitle } = getIntlayer("chat-history-page", await appLocale());
  return { title: String(metaTitle), robots: { index: false, follow: false } };
}

/**
 * /chat/history (docs/chat-history.md): the signed-in user's own chat lines,
 * kept with their account. The lines come from /api/chat/history, which
 * reads only the session's account.
 */
export default async function ChatHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await appLocale();
  const labels = Object.fromEntries(
    Object.entries(getIntlayer("chat-history-page", locale)).map(([k, v]) => [k, String(v)]),
  ) as unknown as HistoryLabels;
  // The main lane's name is the chat's own (learning-partner.content.ts `name`).
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
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const lane = typeof sp.lane === "string" ? sp.lane : "";
  return <HistoryClient labels={labels} locale={locale} initialQ={q} initialLane={lane} />;
}

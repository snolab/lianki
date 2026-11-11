import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { generateAppHreflangMetadata } from "@/lib/hreflang";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { title, intro } = getIntlayer("privacy-page", locale);
  return {
    title: String(title),
    description: String(intro),
    ...generateAppHreflangMetadata(locale, "/privacy"),
  };
}

/** Notes on how Lianki handles data (docs/partner-ai.md, "Privacy"). */
export default async function PrivacyPage() {
  const locale = await appLocale();
  const c = getIntlayer("privacy-page", locale);
  return (
    <main className="mx-auto max-w-2xl px-4 py-8 flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{c.title}</h1>
      <p>{c.intro}</p>
      <section id="ai-replies" className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{c.aiHeading}</h2>
        <p>{c.aiBody}</p>
      </section>
      <section id="own-ai" className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{c.byokHeading}</h2>
        <p>{c.byokBody}</p>
        <p>{c.byokRelay}</p>
      </section>
      <section id="files" className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{c.filesHeading}</h2>
        <p>{c.filesBody}</p>
      </section>
      <section id="voice" className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{c.voiceHeading}</h2>
        <p>{c.voiceBody}</p>
        <p>{c.voiceKeep}</p>
      </section>
    </main>
  );
}

import type { Metadata } from "next";
import { authEmail, authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import LearnClient from "./LearnClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const { metadata } = getIntlayer("learn-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateHreflangMetadata(locale, "/learn"),
  };
}

export default async function LearnPage({ params }: { params: Promise<{ locale: string }> }) {
  const email = await authEmail();
  const user = await authUser();
  const { locale } = await params;
  const { appName, nav } = getIntlayer("landing-page", locale);

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        locale={locale}
        appName={appName}
        blogLabel={nav.blog}
        learnLabel={nav.learn}
        user={user}
      />

      <main className="flex-grow">
        <LearnClient locale={locale} />
      </main>
    </div>
  );
}

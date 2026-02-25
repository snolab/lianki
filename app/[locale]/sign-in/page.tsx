import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { getLocale } from "next-intlayer/server";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import SignInClient from "./SignInClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return {
    title: "Sign In - Lianki",
    description: "Sign in to Lianki to start your spaced repetition learning journey",
    ...generateHreflangMetadata(locale, "/sign-in"),
  };
}

export default async function SignInPage() {
  const locale = await getLocale();
  const { appName, nav } = getIntlayer("landing-page", locale);

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        locale={locale}
        appName={appName}
        blogLabel={nav.blog}
        learnLabel={nav.learn}
        user={null}
      />

      <main className="flex-grow">
        <SignInClient />
      </main>
    </div>
  );
}

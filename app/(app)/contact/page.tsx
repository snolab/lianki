import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import ContactForm from "@/app/ContactForm";
import { appLocale } from "@/lib/app-locale.server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { title } = getIntlayer("contact-form", locale);
  return {
    title: title,
    description: title,
    ...generateAppHreflangMetadata(locale, "/contact"),
  };
}

export default async function ContactPage() {
  const locale = await appLocale();
  const { appName, nav } = getIntlayer("landing-page", locale);
  const content = getIntlayer("contact-form", locale);

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        locale={locale}
        appName={appName}
        blogLabel={nav.blog}
        learnLabel={nav.learn}
        importLabel={nav.import}
        aiVocabLabel={nav.aiVocab}
        signInLabel={nav.signIn}
        dashboardLabel={nav.dashboard}
        profileLabel={nav.profile}
        preferencesLabel={nav.preferences}
        membershipLabel={nav.membership}
        signOutLabel={nav.signOut}
        user={null}
      />

      <main className="flex-grow">
        <ContactForm content={content} />
      </main>
    </div>
  );
}

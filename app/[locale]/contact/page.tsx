import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { locale as getLocale } from "next-intlayer/server";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import ContactForm from "@/app/ContactForm";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = getLocale;
  const { title } = getIntlayer("contact-form", locale);
  return {
    title: title,
    description: title,
    ...generateHreflangMetadata(locale, "/contact"),
  };
}

export default async function ContactPage() {
  const locale = getLocale;
  const { appName, nav } = getIntlayer("landing-page", locale);
  const content = getIntlayer("contact-form", locale);

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
        <ContactForm content={content} />
      </main>
    </div>
  );
}

import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
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
  const content = getIntlayer("contact-form", locale);

  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <ContactForm content={content} />
      </div>
    </div>
  );
}

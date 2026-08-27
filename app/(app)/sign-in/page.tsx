import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import SignInClient from "./SignInClient";
import { appLocale } from "@/lib/app-locale.server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("sign-in-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/sign-in"),
  };
}

export default async function SignInPage() {
  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <SignInClient />
      </div>
    </div>
  );
}

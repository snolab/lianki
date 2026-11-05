import type { Metadata } from "next";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import MembershipClient from "./MembershipClient";
import { appLocale } from "@/lib/app-locale.server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  return {
    title: "Membership - Lianki",
    description: "Manage your Lianki membership and view available features",
    ...generateAppHreflangMetadata(locale, "/membership"),
  };
}

export default async function MembershipPage() {
  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <MembershipClient />
      </div>
    </div>
  );
}

import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import AddNoteClient from "./AddNoteClient";
import { appLocale } from "@/lib/app-locale.server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("add-note-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/add-note"),
  };
}

export default async function AddNotePage() {
  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <AddNoteClient />
      </div>
    </div>
  );
}

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { importAnyOn } from "@/lib/import/words-handler";
import MyFilesClient from "./MyFilesClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  return {
    title: "My Files - Lianki",
    description: "Every file you uploaded to Lianki, kept in your account's own storage.",
    ...generateAppHreflangMetadata(locale, "/my/files"),
  };
}

/**
 * /my/files: every file the user stored, in folders by where it came from
 * (docs/import-material.md, "My Files"). The file store's gate: `import.any`
 * (importAnyOn — every signed-in user while on; `dev` holders while off).
 */
export default async function MyFilesPage() {
  const user = await authUserOrNull().catch(() => null);
  if (!user?.email) redirect("/sign-in?callbackUrl=/my/files");
  if (!importAnyOn(await readFlags(), isDev(user.email))) notFound();
  return <MyFilesClient />;
}

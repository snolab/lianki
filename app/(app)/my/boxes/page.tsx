import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { authUserOrNull, signInRedirect } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import MyBoxesClient from "./MyBoxesClient";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const t = getIntlayer("my-boxes", await appLocale());
  return { title: `${t.title} - Lianki`, robots: { index: false, follow: false } };
}
export default async function MyBoxesPage() {
  if (!(await authUserOrNull())) return signInRedirect();
  return <MyBoxesClient />;
}

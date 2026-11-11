import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isAdmin } from "@/lib/permissions";
import ConfigAdmin from "./ConfigAdmin";
import { devPageText, devPageMetadata } from "../dev-page-title";

// Admin only, like /dev/flags: anyone else gets a plain 404. docs/config-store.md.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("config");

export default async function DevConfigPage() {
  const user = await authUserOrNull();
  if (!isAdmin(user?.email)) notFound();
  const heading = await devPageText("config");
  return (
    <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <h1 lang={heading.lang} className="font-brush text-4xl">
        {heading.text}
      </h1>
      <ConfigAdmin />
    </main>
  );
}

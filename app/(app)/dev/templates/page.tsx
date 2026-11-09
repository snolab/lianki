import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import { devPageMetadata, devPageText } from "../dev-page-title";
import TemplatesEditor from "./TemplatesEditor";

// Developers only: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("templates", { referrer: "no-referrer" });

/**
 * The editor of every transactional mail (docs/mail-templates.md, "Editor"):
 * lib/mail-templates through /api/dev/templates.
 */
export default async function DevTemplatesPage() {
  const user = await authUserOrNull();
  if (!isDev(user?.email)) notFound();
  const heading = await devPageText("templates");
  return (
    <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
      <h1 lang={heading.lang} className="text-xl font-semibold">
        {heading.text}
      </h1>
      <TemplatesEditor />
    </main>
  );
}

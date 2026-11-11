import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import { devPageMetadata, devPageText } from "../dev-page-title";
import MailsLog from "./MailsLog";

// Developers only: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("mails", { referrer: "no-referrer" });

/**
 * The send log of every outgoing mail (docs/mail-templates.md, "Send log"):
 * lib/mail-log through /api/dev/mails.
 */
export default async function DevMailsPage() {
  const user = await authUserOrNull();
  if (!isDev(user?.email)) notFound();
  const heading = await devPageText("mails");
  return (
    <main className="max-w-6xl mx-auto px-4 py-6 space-y-4">
      <h1 lang={heading.lang} className="text-xl font-semibold">
        {heading.text}
      </h1>
      <MailsLog />
    </main>
  );
}

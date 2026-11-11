import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isAdmin } from "@/lib/permissions";
import { devPageMetadata, devPageText } from "../dev-page-title";
import SttAccessAdmin from "./SttAccessAdmin";

// Admin only, like /dev/permissions: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("sttAccess", { referrer: "no-referrer" });

/**
 * Who may use Lianki's speech servers, and which speech servers may register
 * (lib/stt-worker/store.ts through /api/dev/stt-access; docs/local-stt.md,
 * "Lianki's speech servers for everyone").
 */
export default async function DevSttAccessPage() {
  const user = await authUserOrNull();
  if (!isAdmin(user?.email)) notFound();
  const heading = await devPageText("sttAccess");
  return (
    <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">
      <h1 lang={heading.lang} className="font-brush text-4xl">
        {heading.text}
      </h1>
      <SttAccessAdmin />
    </main>
  );
}

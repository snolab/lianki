import { notFound, redirect } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import { dbBackend } from "@/lib/d1";
import { safePreviewPath, signInUrlForPreview } from "@/lib/dev-server-switch";
import PreviewEntryClient from "./PreviewEntryClient";
import { devPageMetadata } from "../dev-page-title";

// Owner-only, like every /dev page: a signed-in non-owner gets a plain 404.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("preview", { referrer: "no-referrer" });

/**
 * The way in from preview.lianki.com's gate page (docs/dev-whole-page.md,
 * "Opening a preview link directly"): the profile menu's switch, run at once,
 * landing on `to` on the preview build. `to` is a relative path only
 * (safePreviewPath); anything else lands on "/".
 */
export default async function DevPreviewEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string | string[] }>;
}) {
  const raw = (await searchParams).to;
  const to = safePreviewPath(Array.isArray(raw) ? raw[0] : raw) ?? "/";
  const user = await authUserOrNull();
  // Signed out: the normal sign-in, then back here with the same `to`.
  if (!user) redirect(signInUrlForPreview(to));
  if (!isDev(user.email) || dbBackend() !== "d1") notFound();
  return (
    <main lang="zh" className="max-w-md mx-auto px-4 py-16 text-center space-y-4">
      <PreviewEntryClient to={to} />
    </main>
  );
}

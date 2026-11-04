import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { dbBackend } from "@/lib/d1";
import { safePreviewPath } from "@/lib/dev-server-switch";
import PreviewEntryClient from "./PreviewEntryClient";

// Owner-only, like every /dev page: a signed-in non-owner gets a plain 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Preview build — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

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
  const user = await authUserOrNull();
  if (!user) redirect("/sign-in");
  if (!isOwner(user.email) || dbBackend() !== "d1") notFound();
  const raw = (await searchParams).to;
  const to = safePreviewPath(Array.isArray(raw) ? raw[0] : raw) ?? "/";
  return (
    <main lang="zh" className="max-w-md mx-auto px-4 py-16 text-center space-y-4">
      <PreviewEntryClient to={to} />
    </main>
  );
}

import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { appLocale } from "@/lib/app-locale.server";
import { hostView } from "@/lib/mini-apps/handlers";
import { pageOrigin } from "@/lib/mini-apps/origin";
import { miniDeps } from "@/app/api/my/mini-apps/deps";
import { MiniAppHost } from "./MiniAppHost";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const { title } = getIntlayer("mini-app", await appLocale());
  return { title: String(title), robots: { index: false, follow: false } };
}

/**
 * /m/<slug> (docs/mini-apps.md): one of the signed-in account's own mini apps,
 * in a sandboxed iframe that never runs as lianki.com, with the permission
 * bridge around it. 404 for a guest, another account's slug, or the flag off.
 */
export default async function MiniAppPage({ params }: Props) {
  const { slug } = await params;
  const h = await headers();
  const view = await hostView(
    slug,
    pageOrigin(h.get("host"), h.get("x-forwarded-proto")),
    miniDeps,
  );
  if (!view) notFound();
  return <MiniAppHost view={view} />;
}

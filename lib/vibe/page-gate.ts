// The gate on /vibe's three pages (docs/vibe.md, "Pages"): 404 unless `read.vibe`
// is on and this is the owner. The flag has no owner bypass: with it off, nobody
// gets these pages or their routes.
import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import type { D1Batch } from "@/lib/read/reader-store";
import { vibeAllowed } from "./gate";

export async function vibePage(): Promise<{ userId: string; db: D1Batch; locale: string }> {
  const user = await authUserOrNull();
  if (!user?.id || dbBackend() !== "d1") notFound();
  if (!vibeAllowed(await readFlags(), isOwner(user.email ?? null))) notFound();
  return {
    userId: user.id,
    db: getD1() as unknown as D1Batch,
    locale: await appLocale(),
  };
}

export async function vibeMetadata(): Promise<Metadata> {
  const { title } = getIntlayer("vibe-page", await appLocale());
  return { title: String(title), robots: { index: false, follow: false } };
}

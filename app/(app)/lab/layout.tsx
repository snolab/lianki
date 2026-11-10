import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";

/**
 * Every /lab page (the experiments: AI vocab, Polyglot, immersion) is for
 * developers only (owner, 2026-11-10): a `dev` holder sees it, anyone else a
 * 404, as on /dev. The sidebar's Lab group is hidden the same way
 * (lib/app-nav.ts `dev`).
 */
export default async function LabLayout({ children }: { children: ReactNode }) {
  const user = await authUserOrNull();
  if (!isDev(user?.email ?? null)) notFound();
  return children;
}

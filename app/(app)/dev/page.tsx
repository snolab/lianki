import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { hasPermission, isAdmin, isDev } from "@/lib/permissions";
import { DEV_PAGE_PERMISSION } from "@/lib/dev-page-permissions";
import { appLocale } from "@/lib/app-locale.server";
import { devPageText, devPageTitle, type DevPageName } from "./dev-page-title";

// Dev access only, like every /dev page: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { text } = await devPageText("dashboard");
  return { title: text, robots: { index: false, follow: false, nocache: true } };
}

const camel = (slug: string) => slug.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** A page's name: its own dictionary for the two that keep one, else dev-pages. */
function pageName(slug: string, locale: string): string {
  if (slug === "design") return String(getIntlayer("dev-design", locale as never).metaTitle);
  if (slug === "roadmap") return String(getIntlayer("dev-roadmap", locale as never).metaTitle);
  return devPageTitle(camel(slug) as DevPageName, locale).split(" — ")[0]!;
}

/**
 * /dev: the developer's index (owner, 2026-11-14: "https://preview.lianki.com/dev/
 * … a dev dashboard"). Every /dev page the viewer's permissions open, and on the
 * preview build the install link for its own dev userscript.
 */
export default async function DevIndexPage() {
  const user = await authUserOrNull();
  const email = user?.email;
  // Dev or admin only, like every /dev page; each listed page is one the viewer may open.
  if (!isDev(email) && !isAdmin(email)) notFound();
  const mine = Object.entries(DEV_PAGE_PERMISSION).filter(([, p]) => hasPermission(email, p));
  const locale = await appLocale();
  const heading = await devPageText("dashboard");
  // The preview build: next dev under scripts/dev/whole-page.ts (the gate rewrites Host).
  const onPreview = process.env.LIANKI_DEV_WHOLE_PAGE === "1";
  const loader = onPreview ? await devPageText("previewLoader") : null;
  const rows = mine
    .map(([slug]) => ({ slug, name: pageName(slug, locale) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  return (
    <main className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <h1 lang={heading.lang} className="font-brush text-4xl">
        {heading.text}
      </h1>
      {loader && (
        <a
          href="/dev/loader.user.js"
          lang={loader.lang}
          className="inline-block rounded-full px-5 py-2 bg-[oklch(0.55_0.198_22.3)] text-[oklch(0.99_0_0)] font-semibold"
        >
          {loader.text}
        </a>
      )}
      <ul className="grid gap-2 sm:grid-cols-2" data-testid="dev-index">
        {rows.map((r) => (
          <li key={r.slug}>
            <a
              href={`/dev/${r.slug}`}
              className="block rounded-lg border border-[oklch(0.9_0_0)] dark:border-[oklch(0.35_0_0)] px-4 py-3 hover:bg-[oklch(0.97_0_0)] dark:hover:bg-[oklch(0.25_0_0)]"
            >
              <span className="font-medium">{r.name}</span>
              <span className="block text-xs opacity-60 font-mono">/dev/{r.slug}</span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

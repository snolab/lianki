import Link from "next/link";
import { LEGAL_LABELS, LEGAL_SLUGS, SELLER, SUPPORT_EMAIL, legalLocale } from "@/lib/legal";

/**
 * Links to the legal pages plus the contact address — payment providers want
 * both reachable from the homepage. `lang` is passed from the /{locale}
 * landing page, whose locale is in the path rather than the app's cookie.
 */
export function LegalFooter({
  locale,
  lang,
  brand = "Lianki",
}: {
  locale: string;
  lang?: boolean;
  brand?: string;
}) {
  const labels = LEGAL_LABELS[legalLocale(locale)];
  const q = lang ? `?lang=${locale}` : "";
  const link = "hover:underline underline-offset-2";
  return (
    <footer className="px-4 py-6 text-center text-sm text-gray-600 sm:px-6 lg:px-8 dark:text-gray-400">
      <nav aria-label="Legal" className="flex flex-wrap justify-center gap-x-4 gap-y-1">
        {LEGAL_SLUGS.map((s) => (
          <Link key={s} href={`/legal/${s}${q}`} className={link}>
            {labels.pages[s]}
          </Link>
        ))}
        <a href={`mailto:${SUPPORT_EMAIL}`} className={link}>
          {labels.contact}: {SUPPORT_EMAIL}
        </a>
      </nav>
      <p className="mt-2">
        © {new Date().getFullYear()} {brand} · {SELLER}
      </p>
    </footer>
  );
}

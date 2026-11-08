import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { appLocale } from "@/lib/app-locale.server";

// Owner-only, gated like every /dev page (isOwner + a plain 404), so it moves
// with them when that gate becomes the isDev permission. Not linked from the nav.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { metaTitle } = getIntlayer("dev-design", await appLocale());
  return {
    title: String(metaTitle),
    robots: { index: false, follow: false, nocache: true },
  };
}

/** Section order, as in Google's DESIGN.md: overview, tokens, layout, parts, do / don't. */
const SECTIONS = [
  "overview",
  "colors",
  "typography",
  "spacing",
  "layout",
  "components",
  "motion",
  "contrast",
  "i18n",
  "dos",
  "donts",
] as const;

/**
 * The colour tokens as app/globals.css defines them (light, then dark). Kept
 * here as text so the page shows both themes side by side, whichever is on.
 */
const SWATCHES: { token: string; light: string; dark: string }[] = [
  { token: "--background", light: "oklch(0.945 0.02 82)", dark: "oklch(0.18 0.01 65)" },
  { token: "--foreground", light: "oklch(0.22 0.015 65)", dark: "oklch(0.92 0.02 82)" },
  { token: "--brand", light: "oklch(0.53 0.207 22.3)", dark: "oklch(0.6 0.205 18.3)" },
  { token: "--slip-again", light: "oklch(0.83 0.071 40)", dark: "oklch(0.39 0.089 35)" },
  { token: "--slip-hard", light: "oklch(0.86 0.091 79)", dark: "oklch(0.46 0.079 69)" },
  { token: "--slip-good", light: "oklch(0.85 0.071 124)", dark: "oklch(0.43 0.069 130)" },
  { token: "--slip-easy", light: "oklch(0.86 0.05 230)", dark: "oklch(0.42 0.06 235)" },
];

const LINK = "text-blue-700 dark:text-blue-300 hover:underline";

export default async function DevDesignPage() {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) notFound();

  const locale = await appLocale();
  const c = getIntlayer("dev-design", locale);
  const sections = SECTIONS.map((id) => {
    const s = c[id] as unknown as Record<string, unknown>;
    return {
      id,
      title: String(s.title),
      rules: Object.keys(s)
        .filter((k) => /^b\d+$/.test(k))
        .map((k) => String(s[k])),
    };
  });

  const tocLinks = (
    <ol className="space-y-1 text-sm">
      {sections.map((s) => (
        <li key={s.id}>
          <a href={`#${s.id}`} className={LINK}>
            {s.title}
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <div
      lang={locale}
      className="max-w-5xl mx-auto px-4 py-8 lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8"
    >
      {/* Contents: a sticky sidebar on a desktop, a folded box at the top on a phone. */}
      <aside className="hidden lg:block">
        <nav aria-label={String(c.toc)} className="sticky top-4 space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide opacity-70">
            {String(c.toc)}
          </h2>
          {tocLinks}
        </nav>
      </aside>

      <div className="min-w-0 space-y-10">
        <header className="space-y-1">
          <h1 className="font-brush text-4xl">{String(c.heading)}</h1>
          <p className="text-sm opacity-75">{String(c.intro)}</p>
        </header>

        <details className="lg:hidden rounded-xl border border-black/10 dark:border-white/10 px-4 py-2">
          <summary className="cursor-pointer text-sm font-semibold">{String(c.toc)}</summary>
          <nav aria-label={String(c.toc)} className="pt-2 pb-1">
            {tocLinks}
          </nav>
        </details>

        {sections.map((s) => (
          <section key={s.id} id={s.id} className="scroll-mt-4 space-y-3" data-section={s.id}>
            <h2 className="font-antique text-xl">{s.title}</h2>
            <ul className="list-disc space-y-1.5 ps-5 leading-relaxed">
              {s.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {s.id === "colors" && (
              <ul className="grid gap-3 pt-2 grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]">
                {SWATCHES.map((w) => (
                  <li key={w.token} className="space-y-1">
                    <div className="flex h-12 overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
                      <span className="flex-1" style={{ background: w.light }} />
                      <span className="flex-1" style={{ background: w.dark }} />
                    </div>
                    <code className="block text-xs font-semibold">{w.token}</code>
                    <p className="text-xs leading-snug opacity-75 break-all">
                      {String(c.light)} <code>{w.light}</code>
                      <br />
                      {String(c.dark)} <code>{w.dark}</code>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

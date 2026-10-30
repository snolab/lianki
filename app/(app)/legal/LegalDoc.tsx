import Link from "next/link";
import type { ReactNode } from "react";
import { LEGAL_LABELS, LEGAL_SLUGS, LEGAL_UPDATED, legalLocale, type LegalSlug } from "@/lib/legal";
import type { Block, LegalDocText, TokushohoText } from "./content";
import { LEGAL_TEXT } from "./content";

/** `[label](href)` → a link, `` `code` `` → <code>; everything else is text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = m.index;
    if (m[3] !== undefined) {
      out.push(
        <code key={key} className="rounded bg-gray-200 px-1 text-[0.9em] dark:bg-gray-800">
          {m[3]}
        </code>,
      );
    } else {
      const [label, href] = [m[1], m[2]];
      const cls = "text-blue-700 underline underline-offset-2 dark:text-blue-300";
      out.push(
        href.startsWith("/") ? (
          <Link key={key} href={href} className={cls}>
            {label}
          </Link>
        ) : (
          <a key={key} href={href} className={cls}>
            {label}
          </a>
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) =>
        typeof b === "string" ? (
          <p key={i} className="mb-3 leading-relaxed">
            {inline(b)}
          </p>
        ) : (
          <ul key={i} className="mb-3 list-disc space-y-1.5 pl-6 leading-relaxed">
            {b.list.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

function Frame({
  slug,
  locale,
  title,
  children,
}: {
  slug: LegalSlug;
  locale: string;
  title: string;
  children: ReactNode;
}) {
  const labels = LEGAL_LABELS[legalLocale(locale)];
  const fallback = legalLocale(locale) !== locale;
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <nav aria-label="Legal" className="mb-6 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {LEGAL_SLUGS.map((s) => (
          <Link
            key={s}
            href={`/legal/${s}`}
            aria-current={s === slug ? "page" : undefined}
            className={
              s === slug
                ? "font-semibold"
                : "text-gray-600 hover:underline underline-offset-2 dark:text-gray-400"
            }
          >
            {labels.pages[s]}
          </Link>
        ))}
      </nav>
      <h1 className="mb-2 text-3xl font-bold">{title}</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        {labels.updated}: <time dateTime={LEGAL_UPDATED}>{LEGAL_UPDATED}</time>
      </p>
      {fallback && (
        <p className="mb-6 rounded-lg border border-gray-300 bg-gray-100 px-4 py-3 text-sm dark:border-gray-700 dark:bg-gray-900">
          {labels.fallbackNote}
        </p>
      )}
      {children}
    </article>
  );
}

export function LegalDoc({
  slug,
  locale,
}: {
  slug: Exclude<LegalSlug, "tokushoho">;
  locale: string;
}) {
  const doc: LegalDocText = LEGAL_TEXT[slug][legalLocale(locale)];
  return (
    <Frame slug={slug} locale={locale} title={doc.title}>
      {doc.intro && <Blocks blocks={doc.intro} />}
      {doc.sections.map((s) => (
        <section key={s.heading} className="mt-8">
          <h2 className="mb-3 text-xl font-semibold">{s.heading}</h2>
          <Blocks blocks={s.blocks} />
        </section>
      ))}
    </Frame>
  );
}

export function TokushohoDoc({ locale }: { locale: string }) {
  const doc: TokushohoText = LEGAL_TEXT.tokushoho[legalLocale(locale)];
  return (
    <Frame slug="tokushoho" locale={locale} title={doc.title}>
      <p className="mb-6 leading-relaxed">{doc.intro}</p>
      <dl className="divide-y divide-gray-300 border-y border-gray-300 dark:divide-gray-700 dark:border-gray-700">
        {doc.rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4">
            <dt className="font-semibold">{label}</dt>
            <dd className="[&>*:last-child]:mb-0">
              <Blocks blocks={value} />
            </dd>
          </div>
        ))}
      </dl>
    </Frame>
  );
}

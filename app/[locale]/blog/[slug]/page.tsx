import { notFound } from "next/navigation";
import Link from "next/link";
import { getPost, getRawPost, getAllSlugs } from "@/lib/blog";
import { translatePost } from "@/lib/translate";
import { commitFile } from "@/lib/github-commit";

export const revalidate = 3600;

const LOCALES = ["en", "cn"];

export async function generateStaticParams() {
  const slugs = await getAllSlugs();
  return LOCALES.flatMap((locale) => slugs.map((slug) => ({ locale, slug })));
}

async function resolvePost(locale: string, slug: string) {
  // Fast path: translation already exists
  const existing = await getPost(locale, slug);
  if (existing) return { post: existing, translated: false };

  // English is the source of truth — no fallback
  if (locale === "en") return { post: null, translated: false };

  // Translate from English
  const enRaw = await getRawPost("en", slug);
  if (!enRaw) return { post: null, translated: false };

  const translatedRaw = await translatePost(enRaw, locale);

  // Commit back to repo in the background (non-blocking)
  commitFile(
    `blog/${locale}/${slug}.md`,
    translatedRaw,
    `auto: translate ${slug} to ${locale}`,
  ).catch((err) => console.error("Failed to commit translation:", err));

  // Parse and return the freshly translated content
  const { parsePost } = await import("@/lib/blog");
  const post = await parsePost(translatedRaw, slug);
  return { post, translated: true };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  if (!LOCALES.includes(locale)) notFound();

  const { post, translated } = await resolvePost(locale, slug);
  if (!post) notFound();

  const otherLocale = locale === "en" ? "cn" : "en";

  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      <nav className="flex items-center justify-between mb-8 text-sm text-gray-500">
        <Link href={`/${locale}/blog`} className="hover:text-gray-700">
          ← Blog
        </Link>
        <Link
          href={`/${otherLocale}/blog/${slug}`}
          className="px-3 py-1 border rounded hover:bg-gray-50"
        >
          {otherLocale === "cn" ? "中文" : "English"}
        </Link>
      </nav>

      <article>
        <header className="mb-8">
          <time className="text-sm text-gray-400">
            {post.date
              ? new Date(post.date).toLocaleDateString(locale === "cn" ? "zh-CN" : "en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })
              : ""}
          </time>
          <h1 className="text-3xl font-bold mt-2">{post.title}</h1>
          {post.tags.length > 0 && (
            <div className="flex gap-2 mt-3 flex-wrap">
              {post.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-2 py-0.5 bg-gray-100 rounded-full text-gray-600"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          {translated && (
            <p className="mt-3 text-xs text-amber-600 bg-amber-50 px-3 py-1 rounded">
              Auto-translated · Committed to repo for future visits
            </p>
          )}
        </header>

        <div
          className="prose prose-gray max-w-none"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted markdown
          dangerouslySetInnerHTML={{ __html: post.contentHtml }}
        />
      </article>
    </main>
  );
}

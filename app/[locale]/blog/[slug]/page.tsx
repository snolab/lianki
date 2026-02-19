import { notFound } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { getPost, getRawPost, getAllSlugs, parsePost, blogLocaleDir, type Post } from "@/lib/blog";
import { translatePost } from "@/lib/translate";
import { commitFile } from "@/lib/github-commit";

export const revalidate = 3600;

const LOCALES = ["en", "zh", "ja"];

const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  zh: "中文",
  ja: "日本語",
};

function dateLocale(locale: string): string {
  if (locale === "zh") return "zh-CN";
  if (locale === "ja") return "ja-JP";
  return "en-US";
}

export async function generateStaticParams() {
  const slugs = await getAllSlugs();
  return LOCALES.flatMap((locale) => slugs.map((slug) => ({ locale, slug })));
}

async function resolvePost(
  locale: string,
  slug: string,
): Promise<{ post: Post; translated: boolean }> {
  const existing = await getPost(locale, slug);
  if (existing) return { post: existing, translated: false };

  if (locale === "en") notFound();

  const enRaw = await getRawPost("en", slug);
  if (!enRaw) notFound();

  const translatedRaw = await translatePost(enRaw, locale);

  // Commit back non-blocking — don't await
  const dir = blogLocaleDir(locale);
  commitFile(`blog/${dir}/${slug}.md`, translatedRaw, `auto: translate ${slug} to ${locale}`).catch(
    (err) => console.error("commit translation failed:", err),
  );

  return { post: parsePost(translatedRaw, slug), translated: true };
}

function PostSkeleton() {
  return (
    <div className="animate-pulse space-y-4 mt-8">
      <div className="h-4 bg-gray-200 rounded w-24" />
      <div className="h-8 bg-gray-200 rounded w-3/4" />
      <div className="flex gap-2">
        <div className="h-5 bg-gray-200 rounded-full w-16" />
        <div className="h-5 bg-gray-200 rounded-full w-20" />
      </div>
      <div className="space-y-3 mt-8">
        {[...Array(8)].map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
          <div
            key={i}
            className="h-4 bg-gray-100 rounded"
            style={{ width: `${85 + (i % 3) * 7}%` }}
          />
        ))}
      </div>
      <p className="text-sm text-amber-600 bg-amber-50 px-3 py-2 rounded mt-6">
        Translating… this may take a moment
      </p>
    </div>
  );
}

async function PostContent({ locale, slug }: { locale: string; slug: string }) {
  const { post, translated } = await resolvePost(locale, slug);

  return (
    <article>
      <header className="mb-8">
        <time className="text-sm text-gray-400">
          {post.date
            ? new Date(post.date).toLocaleDateString(dateLocale(locale), {
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
  );
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  if (!LOCALES.includes(locale)) notFound();

  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      <nav className="flex items-center justify-between mb-8 text-sm text-gray-500">
        <Link href={`/${locale}/blog`} className="hover:text-gray-700">
          ← Blog
        </Link>
        <div className="flex gap-2">
          {LOCALES.filter((l) => l !== locale).map((l) => (
            <Link
              key={l}
              href={`/${l}/blog/${slug}`}
              className="px-3 py-1 border rounded hover:bg-gray-50"
            >
              {LOCALE_LABELS[l]}
            </Link>
          ))}
        </div>
      </nav>

      {/* Shell renders immediately; PostContent streams in when translation is ready */}
      <Suspense fallback={<PostSkeleton />}>
        <PostContent locale={locale} slug={slug} />
      </Suspense>
    </main>
  );
}

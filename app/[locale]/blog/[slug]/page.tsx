import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { getPost, getRawPost, getAllSlugs } from "@/lib/blog";
import { StreamingTranslation } from "../StreamingTranslation";
import { BLOG_LOCALES, LOCALE_LABELS, getDateLocale, isSupportedLocale } from "@/lib/constants";
import { generateHreflangMetadata } from "@/lib/hreflang";
import matter from "gray-matter";

export const revalidate = 3600;

export async function generateStaticParams() {
  const slugs = await getAllSlugs();
  return BLOG_LOCALES.flatMap((locale) => slugs.map((slug) => ({ locale, slug })));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;

  // Try to get the post to extract title and description
  const raw = await getRawPost("en", slug); // Always use English source for metadata
  if (!raw) {
    return {
      title: "Blog Post - Lianki",
      ...generateHreflangMetadata(locale, `/blog/${slug}`),
    };
  }

  const { data } = matter(raw);
  return {
    title: `${data.title || slug} - Lianki Blog`,
    description: data.summary || data.description || "Read this article on the Lianki blog",
    ...generateHreflangMetadata(locale, `/blog/${slug}`),
  };
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
  // For English, render directly (no translation needed)
  if (locale === "en") {
    const post = await getPost("en", slug);
    if (!post) notFound();

    return (
      <article>
        <header className="mb-8">
          <time className="text-sm text-gray-400">
            {post.date
              ? new Date(post.date).toLocaleDateString(getDateLocale(locale), {
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
        </header>

        <div
          className="prose prose-gray max-w-none"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted markdown
          dangerouslySetInnerHTML={{ __html: post.contentHtml }}
        />
      </article>
    );
  }

  // For other locales, check if committed translation exists
  const committed = await getPost(locale, slug);
  if (committed) {
    return (
      <article>
        <header className="mb-8">
          <time className="text-sm text-gray-400">
            {committed.date
              ? new Date(committed.date).toLocaleDateString(getDateLocale(locale), {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })
              : ""}
          </time>
          <h1 className="text-3xl font-bold mt-2">{committed.title}</h1>
          {committed.tags.length > 0 && (
            <div className="flex gap-2 mt-3 flex-wrap">
              {committed.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-2 py-0.5 bg-gray-100 rounded-full text-gray-600"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </header>

        <div
          className="prose prose-gray max-w-none"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted markdown
          dangerouslySetInnerHTML={{ __html: committed.contentHtml }}
        />
      </article>
    );
  }

  // Ensure English source exists
  const english = await getRawPost("en", slug);
  if (!english) notFound();

  // Stream the translation to the client
  return <StreamingTranslation locale={locale} slug={slug} />;
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  if (!isSupportedLocale(locale)) notFound();

  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      <nav className="flex items-center justify-between mb-8 text-sm text-gray-500">
        <Link href={`/${locale}/blog`} className="hover:text-gray-700">
          ← Blog
        </Link>
        <div className="flex gap-2">
          {BLOG_LOCALES.filter((l) => l !== locale).map((l) => (
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

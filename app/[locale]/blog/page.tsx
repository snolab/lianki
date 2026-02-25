import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAllSlugs, getRawPostWithFallback } from "@/lib/blog";
import matter from "gray-matter";
import { BLOG_LOCALES, LOCALE_LABELS, getDateLocale, isSupportedLocale } from "@/lib/constants";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { getIntlayer } from "intlayer";
import { Header } from "@/app/components/Header";
import { authUser } from "@/app/signInEmail";

export const revalidate = 3600;

export async function generateStaticParams() {
  return BLOG_LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: "Lianki Blog - Learn about spaced repetition and FSRS",
    description:
      "Articles about spaced repetition learning, FSRS algorithm, and effective study techniques",
    ...generateHreflangMetadata(locale, "/blog"),
  };
}

type PostSummary = {
  slug: string;
  title: string;
  date: string;
  summary: string;
};

async function getPostSummaries(locale: string): Promise<PostSummary[]> {
  const slugs = await getAllSlugs();
  const results = await Promise.all(
    slugs.map(async (slug) => {
      const raw = await getRawPostWithFallback(locale, slug);
      if (!raw) return null;
      const { data } = matter(raw);
      return {
        slug,
        title: data.title ?? slug,
        date: data.date ?? "",
        summary: data.summary ?? "",
      };
    }),
  );
  return results.filter((r): r is PostSummary => r !== null);
}

export default async function BlogIndexPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();

  const posts = await getPostSummaries(locale);
  const { appName, nav } = getIntlayer("landing-page", locale);

  // Try to get user if logged in (optional)
  let user = null;
  try {
    user = await authUser();
  } catch (e) {
    // User not logged in, that's ok
  }

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        locale={locale}
        appName={appName}
        blogLabel={nav.blog}
        learnLabel={nav.learn}
        user={user}
      />

      {/* Main Content */}
      <main className="flex-grow max-w-2xl mx-auto px-4 py-12 w-full">
        <h1 className="text-3xl font-bold mb-8">Blog</h1>

        <ul className="space-y-8">
          {posts.map((post) => (
            <li key={post.slug}>
              <Link href={`/${locale}/blog/${post.slug}`} className="group block">
                <time className="text-sm text-gray-400">
                  {post.date
                    ? new Date(post.date).toLocaleDateString(getDateLocale(locale), {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })
                    : ""}
                </time>
                <h2 className="text-xl font-semibold group-hover:text-blue-600 mt-1">
                  {post.title}
                </h2>
                <p className="text-gray-600 mt-1 text-sm">{post.summary}</p>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

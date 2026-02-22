import Link from "next/link";
import { notFound } from "next/navigation";
import { getAllSlugs, getRawPost } from "@/lib/blog";
import matter from "gray-matter";
import { BLOG_LOCALES, LOCALE_LABELS, getDateLocale, isSupportedLocale } from "@/lib/constants";

export const revalidate = 3600;

export async function generateStaticParams() {
  return BLOG_LOCALES.map((locale) => ({ locale }));
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
      const raw = (await getRawPost(locale, slug)) ?? (await getRawPost("en", slug));
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

  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-700">
            ← Lianki
          </Link>
          <h1 className="text-3xl font-bold mt-2">Blog</h1>
        </div>
        <div className="flex gap-2">
          {BLOG_LOCALES.filter((l) => l !== locale).map((l) => (
            <Link
              key={l}
              href={`/${l}/blog`}
              className="text-sm px-3 py-1 border rounded hover:bg-gray-50"
            >
              {LOCALE_LABELS[l]}
            </Link>
          ))}
        </div>
      </div>

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
              <h2 className="text-xl font-semibold group-hover:text-blue-600 mt-1">{post.title}</h2>
              <p className="text-gray-600 mt-1 text-sm">{post.summary}</p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

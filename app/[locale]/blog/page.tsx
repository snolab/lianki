import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAllSlugs, getRawPostWithFallback, getRawPost } from "@/lib/blog";
import matter from "gray-matter";
import { BLOG_LOCALES, LOCALE_LABELS, getDateLocale, isSupportedLocale } from "@/lib/constants";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { getIntlayer } from "intlayer";
import { Header } from "@/app/components/Header";
import { authUser } from "@/app/signInEmail";
import OpenAI from "openai";
import { logSanitizedError } from "@/lib/safeError";

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
  const { metadata } = getIntlayer("blog-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateHreflangMetadata(locale, "/blog"),
  };
}

type PostSummary = {
  slug: string;
  title: string;
  date: string;
  summary: string;
};

async function translateText(text: string, targetLocale: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) return text;

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const languageName = LOCALE_LABELS[targetLocale as keyof typeof LOCALE_LABELS] || targetLocale;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a translator. Translate the given text to ${languageName}. Only return the translated text, nothing else.`,
        },
        {
          role: "user",
          content: text,
        },
      ],
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || text;
  } catch (error) {
    logSanitizedError("blog.index.translate", error, { targetLocale });
    return text;
  }
}

async function getPostSummaries(
  locale: string,
  allowLiveTranslation: boolean,
): Promise<PostSummary[]> {
  const slugs = await getAllSlugs();
  const results = await Promise.all(
    slugs.map(async (slug) => {
      // Check if localized version exists
      const localizedRaw = await getRawPost(locale, slug);

      if (localizedRaw) {
        // Use localized version
        const { data } = matter(localizedRaw);
        return {
          slug,
          title: data.title ?? slug,
          date: data.date ?? "",
          summary: data.summary ?? "",
        };
      }

      // Fallback to English and translate
      const englishRaw = await getRawPost("en", slug);
      if (!englishRaw) return null;

      const { data } = matter(englishRaw);
      const title = data.title ?? slug;
      const summary = data.summary ?? "";

      // Translate title and summary if not English
      if (locale !== "en" && allowLiveTranslation) {
        const [translatedTitle, translatedSummary] = await Promise.all([
          translateText(title, locale),
          translateText(summary, locale),
        ]);

        return {
          slug,
          title: translatedTitle,
          date: data.date ?? "",
          summary: translatedSummary,
        };
      }

      return {
        slug,
        title,
        date: data.date ?? "",
        summary,
      };
    }),
  );
  return results.filter((r): r is PostSummary => r !== null);
}

export default async function BlogIndexPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();

  const { appName, nav } = getIntlayer("landing-page", locale);
  const { heading } = getIntlayer("blog-page", locale);

  // Try to get user if logged in (optional)
  let user = null;
  try {
    user = await authUser();
  } catch (e) {
    // User not logged in, that's ok
  }
  const posts = await getPostSummaries(locale, Boolean(user));

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        locale={locale}
        appName={appName}
        blogLabel={nav.blog}
        learnLabel={nav.learn}
        importLabel={nav.import}
        aiVocabLabel={nav.aiVocab}
        signInLabel={nav.signIn}
        dashboardLabel={nav.dashboard}
        profileLabel={nav.profile}
        preferencesLabel={nav.preferences}
        membershipLabel={nav.membership}
        signOutLabel={nav.signOut}
        user={user}
      />

      {/* Main Content */}
      <main className="flex-grow max-w-2xl mx-auto px-4 py-12 w-full">
        <h1 className="text-3xl font-bold mb-8">{heading}</h1>

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

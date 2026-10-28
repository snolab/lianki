import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { getRawPost, getAllSlugs } from "@/lib/blog";
import { StreamingTranslation } from "../StreamingTranslation";
import { MarkdownPost } from "../MarkdownPost";
import { BLOG_LOCALES, LOCALE_LABELS, isSupportedLocale } from "@/lib/constants";
import { generateHreflangMetadata } from "@/lib/hreflang";
import matter from "gray-matter";
import { getIntlayer } from "intlayer";
import { Header } from "@/app/components/Header";
import { authUser } from "@/app/signInEmail";

// No `revalidate` / `dynamicParams` here on purpose: the root layout awaits
// headers()/cookies(), so every route in this app is dynamically rendered and
// neither flag has any effect (verified — the prerender manifest holds 2 routes
// for the whole app, and an unknown slug still returns 200 with
// `dynamicParams = false`). The blog reaches the Worker because lib/blog.ts
// bundles the markdown, not because anything here is static.

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

async function EnglishPost({ slug, locale }: { slug: string; locale: string }) {
  const raw = await getRawPost("en", slug);
  if (!raw) notFound();
  return <MarkdownPost content={raw} locale={locale} />;
}

function UntranslatedNotice({ locale, signedIn }: { locale: string; signedIn: boolean }) {
  const language = LOCALE_LABELS[locale] ?? locale;
  return (
    <p className="text-sm text-amber-700 bg-amber-50 px-3 py-2 rounded mb-6">
      This post hasn&apos;t been translated into {language} yet, so it is shown in English.
      {!signedIn && " Sign in to generate a translation."}
    </p>
  );
}

async function PostContent({
  locale,
  slug,
  signedIn,
}: {
  locale: string;
  slug: string;
  signedIn: boolean;
}) {
  // For English, render directly (no translation needed)
  if (locale === "en") return <EnglishPost slug={slug} locale={locale} />;

  // For other locales, check if committed translation exists
  const committedRaw = await getRawPost(locale, slug);
  if (committedRaw) {
    return <MarkdownPost content={committedRaw} locale={locale} />;
  }

  // Ensure English source exists
  const english = await getRawPost("en", slug);
  if (!english) notFound();

  // /api/translate needs a signed-in user, so a visitor would only ever see a
  // "Sign in required" error box. Show them the English original instead.
  if (!signedIn) {
    return (
      <>
        <UntranslatedNotice locale={locale} signedIn={false} />
        <EnglishPost slug={slug} locale={locale} />
      </>
    );
  }

  // Stream the translation to the client, falling back to English if it fails
  return (
    <StreamingTranslation
      locale={locale}
      slug={slug}
      fallback={
        <>
          <UntranslatedNotice locale={locale} signedIn />
          <EnglishPost slug={slug} locale={locale} />
        </>
      }
    />
  );
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  if (!isSupportedLocale(locale)) notFound();

  const { appName, nav } = getIntlayer("landing-page", locale);
  const shellNav = getIntlayer("app-shell", locale).nav;

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
        importLabel={nav.import}
        aiVocabLabel={nav.aiVocab}
        signInLabel={shellNav.signIn}
        dashboardLabel={shellNav.dashboard}
        profileLabel={shellNav.profile}
        preferencesLabel={shellNav.preferences}
        membershipLabel={shellNav.membership}
        signOutLabel={shellNav.signOut}
        user={user}
      />

      {/* Main Content */}
      <main className="flex-grow max-w-2xl mx-auto px-4 py-12 w-full">
        <nav className="mb-8 text-sm text-gray-500">
          <Link href={`/${locale}/blog`} className="hover:text-gray-700">
            ← Blog
          </Link>
        </nav>

        {/* Shell renders immediately; PostContent streams in when translation is ready */}
        <Suspense fallback={<PostSkeleton />}>
          <PostContent locale={locale} slug={slug} signedIn={Boolean(user)} />
        </Suspense>
      </main>
    </div>
  );
}

import type { Metadata } from "next";
import { BLOG_LOCALES } from "@/lib/constants";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import { authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";

/**
 * Privacy policy.
 *
 * Required by the Chrome Web Store: an extension that handles user data cannot
 * be published without a reachable policy URL, and `/privacy` previously 307'd
 * to `/en/privacy`, which 404'd.
 *
 * Deliberately in English only for now. A machine-translated legal statement is
 * worse than an untranslated one — the other locales render this same text
 * rather than a translation nobody has checked.
 *
 * Every claim below is drawn from the code, not from intent. If a data flow
 * changes, this page changes with it.
 */
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
    title: "Privacy Policy — Lianki",
    description: "What Lianki stores, where it is stored, and which third parties process it.",
    ...generateHreflangMetadata(locale, "/privacy"),
  };
}

const UPDATED = "2026-09-09";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xl font-semibold mb-3">{title}</h2>
      <div className="space-y-3 text-gray-700 dark:text-gray-300">{children}</div>
    </section>
  );
}

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const { appName, nav } = getIntlayer("landing-page", locale);

  let user = null;
  try {
    user = await authUser();
  } catch {
    // signed out is fine — this page is public
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
        signInLabel={nav.signIn}
        dashboardLabel={nav.dashboard}
        profileLabel={nav.profile}
        preferencesLabel={nav.preferences}
        membershipLabel={nav.membership}
        signOutLabel={nav.signOut}
        user={user}
      />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: {UPDATED}</p>

        <p className="mb-8 text-gray-700 dark:text-gray-300">
          Lianki is a spaced-repetition tool. To schedule reviews it has to remember which pages you
          chose to study and how those reviews went. This page describes exactly what that means,
          where the data sits, and who else can see it.
        </p>

        <Section title="What is stored">
          <p>For each card you add — one card is one page you chose to study:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>the page URL (normalized) and its title</li>
            <li>
              scheduling state from the FSRS algorithm (due date, stability, difficulty, lapses)
            </li>
            <li>your review history: which rating you gave and when</li>
            <li>optional playback-speed markers for video and audio pages</li>
            <li>a clock value and device identifier used to merge changes across devices</li>
          </ul>
          <p>
            If you play video or audio on a page, the browser extension and userscript also record
            watch time for that page: active seconds, seconds of media consumed, number of viewing
            sessions, per-day totals, which parts of the timeline you reached, the media duration
            and its detected audio language. This is what powers the study streak and hour totals.
            Time is only counted while media is actually playing — visiting a page records nothing
            on its own.
          </p>
          <p>
            For your account: your email address, and — if you sign in with GitHub or Google — the
            account identifier those services return. No password is stored; sign-in is by emailed
            link or by GitHub/Google.
          </p>
        </Section>

        <Section title="Where it is stored">
          <ul className="list-disc pl-6 space-y-1">
            <li>
              <strong>On your device first.</strong> Cards are written to the extension&rsquo;s
              storage (or Tampermonkey&rsquo;s, for the userscript) and mirrored into this
              site&rsquo;s IndexedDB. Reviews are scheduled locally, so the app works offline.
            </li>
            <li>
              <strong>In your account,</strong> if you are signed in. Device storage syncs to our
              database so your cards follow you between devices.
            </li>
            <li>
              <strong>Generated audio</strong> from the text-to-speech feature is cached in object
              storage, keyed by a hash of the text.
            </li>
          </ul>
          <p>Signed out, nothing leaves your browser: the app is usable as a purely local tool.</p>
        </Section>

        <Section title="Who else processes it">
          <ul className="list-disc pl-6 space-y-1">
            <li>
              <strong>Cloudflare</strong> — hosting and database, the Turnstile anti-abuse check on
              the email sign-in form, and Workers AI. Text you send to the AI features (vocabulary
              generation, translation, learning roadmaps) and text you send to text-to-speech are
              processed by Workers AI.
            </li>
            <li>
              <strong>Vercel</strong> — application hosting.
            </li>
            <li>
              <strong>MongoDB Atlas</strong> — the current production database.
            </li>
            <li>
              <strong>Resend</strong> — sends your sign-in link. It receives your email address.
            </li>
            <li>
              <strong>GitHub and Google</strong> — only if you choose to sign in with them.
            </li>
            <li>
              <strong>YouTube (Google)</strong> — only if you use the playlist import, which asks
              YouTube for the videos in a playlist you supply.
            </li>
            <li>
              <strong>Slack</strong> — if you submit the contact form, the name, email, phone and
              message you typed are delivered to our Slack workspace.
            </li>
          </ul>
          <p>
            We do not sell your data, and we do not use it for advertising or send it to advertising
            networks.
          </p>
        </Section>

        <Section title="Your control over it">
          <ul className="list-disc pl-6 space-y-1">
            <li>
              <strong>See everything:</strong> the <code>/data</code> page lists every card held in
              your account and on this device.
            </li>
            <li>
              <strong>Delete:</strong> cards can be deleted individually or all at once, from that
              same page, in the cloud and locally.
            </li>
            <li>
              <strong>Export:</strong> your cards can be exported as YAML.
            </li>
            <li>
              <strong>Stay local:</strong> not signing in keeps everything on your device.
            </li>
          </ul>
          <p>
            To delete your account and everything attached to it, contact us using the address below
            and we will remove it.
          </p>
        </Section>

        <Section title="Retention">
          <p>
            Cards and watch data are kept for as long as you keep them — they are deleted when you
            delete them, and removing a card removes its review history with it. Cached
            text-to-speech audio persists until it is evicted from the cache. We do not currently
            operate an automatic expiry schedule on account data.
          </p>
        </Section>

        <Section title="The browser extension">
          <p>
            The extension runs on every site so that a card can be added, and media watch time
            measured, wherever you happen to be reading or watching. It does not transmit the pages
            you visit. A page is only recorded once you add it as a card, or when you play media on
            it; ordinary browsing is not sent anywhere.
          </p>
          <p>
            The extension talks to <code>lianki.com</code> and nowhere else.
          </p>
        </Section>

        <Section title="Changes and contact">
          <p>
            If this policy changes, the date at the top changes with it. Questions, or a request to
            delete your data: use the contact form on the home page.
          </p>
        </Section>
      </main>
    </div>
  );
}

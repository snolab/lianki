import { getIntlayer } from "intlayer";
import { Header } from "@/app/components/Header";
import { authUser } from "@/app/signInEmail";
import { ReadListClient } from "./ReadListClient";

export default async function ReadPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const { appName, nav } = getIntlayer("landing-page", locale);

  let user = null;
  try {
    user = await authUser();
  } catch {
    // Guest mode
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
      <main className="flex-grow px-4 sm:px-6 lg:px-8 py-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-3xl font-bold mb-6">Read & Learn</h1>
          <p className="text-gray-600 dark:text-gray-400 mb-8">
            Import text materials for spaced repetition learning.
            {user
              ? " Your materials are stored securely in your account."
              : " Sign in to save your materials."}
          </p>
          <ReadListClient locale={locale} isLoggedIn={!!user} />
        </div>
      </main>
    </div>
  );
}

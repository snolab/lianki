import { getIntlayer } from "intlayer";
import { Header } from "@/app/components/Header";
import { authUser } from "@/app/signInEmail";
import { ReadViewClient } from "./ReadViewClient";

export default async function ReadMaterialPage({
  params,
}: {
  params: Promise<{ id: string; locale: string }>;
}) {
  const { id, locale } = await params;
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
        user={user}
      />
      <main className="flex-grow px-4 sm:px-6 lg:px-8 py-8">
        <div className="max-w-4xl mx-auto">
          <ReadViewClient id={id} locale={locale} isLoggedIn={!!user} />
        </div>
      </main>
    </div>
  );
}

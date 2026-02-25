import { auth } from "@/auth";
import { headers } from "next/headers";
import { authUser } from "@/app/signInEmail";
import { getLocale } from "next-intlayer/server";
import { getIntlayer } from "intlayer";
import { Header } from "@/app/components/Header";

export default async function ProfilePage() {
  const user = await authUser();
  const session = await auth.api.getSession({ headers: await headers() });
  const locale = await getLocale();
  const { appName, nav } = getIntlayer("landing-page", locale);

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        locale={locale}
        appName={appName}
        blogLabel={nav.blog}
        learnLabel={nav.learn}
        user={user}
      />

      <main className="flex-grow max-w-4xl mx-auto px-4 py-12 w-full">
        <h1 className="text-3xl font-bold mb-8">Profile</h1>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
          <h2 className="text-2xl font-semibold mb-4">User Information</h2>
          <p className="mb-2">
            <strong>Name:</strong> {user.name || "N/A"}
          </p>
          <p className="mb-2">
            <strong>Email:</strong> {user.email}
          </p>
          {user.image && (
            <p>
              <strong>Avatar:</strong> <img src={user.image} alt="User avatar" className="mt-2 w-32 h-32 rounded-full" />
            </p>
          )}
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
          <h2 className="text-2xl font-semibold mb-4">Session Details</h2>
          <pre className="text-sm overflow-x-auto">{JSON.stringify(session, null, 2)}</pre>
        </div>
        <div className="flex gap-4">
          <a href={`/${locale}/preferences`} className="text-blue-500 hover:text-blue-600">
            Edit Preferences
          </a>
          <a href={`/${locale}/list`} className="text-blue-500 hover:text-blue-600">
            Back to Home
          </a>
        </div>
      </main>
    </div>
  );
}

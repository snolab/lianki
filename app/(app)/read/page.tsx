import { ReadListClient } from "./ReadListClient";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";

export default async function ReadPage() {
  const locale = await appLocale();
  const user = await authUserOrNull();

  return (
    <div className="flex flex-col">
      <div className="flex-grow px-4 sm:px-6 lg:px-8 py-8">
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
      </div>
    </div>
  );
}

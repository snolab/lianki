import { authUser } from "@/app/signInEmail";
import { getUserMembership } from "@/lib/membership";
import { localeRedirect } from "@/lib/locale-redirect";
import Link from "next/link";
import { useIntlayer } from "next-intlayer/server";
import { getLocale } from "next-intlayer/server";

export default async function PolyglotLayout({ children }: { children: React.ReactNode }) {
  const content = useIntlayer("polyglot-layout");
  const locale = await getLocale();

  // Get authenticated user or redirect to sign-in
  let user;
  try {
    user = await authUser();
  } catch {
    localeRedirect("/sign-in");
    return null; // TypeScript: unreachable, but needed
  }

  let membership;
  try {
    membership = await getUserMembership(user.id);
  } catch {
    membership = { tier: "free" as const };
  }
  const hasAccess = membership.tier === "pro" || membership.tier === "trial";

  if (!hasAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
        <div className="max-w-md w-full text-center">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
            <div className="text-6xl mb-4">🔒</div>
            <h1 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">
              {content.accessDenied.title.value}
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              {content.accessDenied.description.value}
            </p>
            <div className="space-y-3">
              <Link
                href={`/${locale}/membership`}
                className="block w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors"
              >
                {content.accessDenied.upgradeToPro.value}
              </Link>
              <Link
                href={`/${locale}/list`}
                className="block w-full bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-900 dark:text-white font-semibold py-3 px-6 rounded-lg transition-colors"
              >
                {content.accessDenied.backToHome.value}
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Show trial/pro banner
  return (
    <div className="min-h-screen">
      {membership.tier === "trial" && membership.trialEndsAt && (
        <div className="bg-yellow-500 text-black px-4 py-2 text-center text-sm font-medium">
          {content.banner.trialExpires.value} {membership.trialEndsAt.toLocaleDateString()} —{" "}
          <Link href={`/${locale}/membership`} className="underline">
            {content.banner.upgradeToPro.value}
          </Link>
        </div>
      )}
      {membership.tier === "pro" && membership.proEndsAt && (
        <div className="bg-green-600 text-white px-4 py-2 text-center text-sm font-medium">
          {content.banner.proMemberUntil.value} {membership.proEndsAt.toLocaleDateString()}
        </div>
      )}
      {children}
    </div>
  );
}

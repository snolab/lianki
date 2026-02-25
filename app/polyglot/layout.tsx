import { authUser } from "@/app/signInEmail";
import { getUserMembership } from "@/lib/membership";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function PolyglotLayout({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await authUser();
  } catch (error) {
    // Not logged in, redirect to sign-in
    redirect("/sign-in");
  }

  const membership = await getUserMembership(user.id);
  const hasAccess = membership.tier === "pro" || membership.tier === "trial";

  if (!hasAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
        <div className="max-w-md w-full text-center">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
            <div className="text-6xl mb-4">🔒</div>
            <h1 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">
              Pro Membership Required
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              The Polyglot feature is available for Pro members. New users get 90 days free trial
              automatically.
            </p>
            <div className="space-y-3">
              <Link
                href="/membership"
                className="block w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors"
              >
                Upgrade to Pro
              </Link>
              <Link
                href="/list"
                className="block w-full bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-900 dark:text-white font-semibold py-3 px-6 rounded-lg transition-colors"
              >
                Back to Home
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
          Trial expires on {membership.trialEndsAt.toLocaleDateString()} —{" "}
          <Link href="/membership" className="underline">
            Upgrade to Pro
          </Link>
        </div>
      )}
      {membership.tier === "pro" && membership.proEndsAt && (
        <div className="bg-green-600 text-white px-4 py-2 text-center text-sm font-medium">
          Pro member until {membership.proEndsAt.toLocaleDateString()}
        </div>
      )}
      {children}
    </div>
  );
}

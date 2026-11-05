import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import PasskeysCard from "./PasskeysCard";
import { DebugOnly } from "./DebugOnly";
import { dbBackend } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { connectionsOn } from "@/lib/connections/gate";
import { getD1 } from "@/lib/d1";
import { LEVEL_IDS, type LevelId } from "@/lib/levels";
import { levelsOn, type LevelView } from "@/lib/level-progress";
import { userLevelOf } from "@/lib/study-days";
import { LevelCard, type LevelCardLabels } from "@/app/components/LevelCard";

/** The level card's data and strings, or null when levels are not shown to this viewer. */
async function levelCardFor(email: string | null, locale: string) {
  if (dbBackend() !== "d1" || !levelsOn(await readFlags(), isOwner(email))) return null;
  let view: LevelView;
  try {
    view = await userLevelOf(getD1(), email);
  } catch {
    return null; // the rest of the profile still renders
  }
  const n = getIntlayer("learner-levels", locale);
  const names = Object.fromEntries(LEVEL_IDS.map((id) => [id, String(n[id])])) as Record<
    LevelId,
    string
  >;
  const ui = getIntlayer("learner-level-ui", locale);
  const labels = Object.fromEntries(
    Object.entries(ui).map(([k, v]) => [k, String(v)]),
  ) as unknown as LevelCardLabels;
  return { view, names, labels };
}

export default async function ProfilePage() {
  const signedIn = await authUserOrNull();
  const locale = await appLocale();
  // Learner level (docs/levels.md): a guest sees the guest level here and the
  // way up (sign up); with levels hidden, a guest goes to sign in as before.
  const level = await levelCardFor(signedIn?.email ?? null, locale);
  if (!signedIn) {
    if (!level) redirect("/sign-in");
    const { heading } = getIntlayer("profile-page", locale);
    return (
      <div className="flex flex-col">
        <div className="flex-grow max-w-4xl mx-auto px-4 py-12 w-full">
          <h1 className="text-3xl font-bold mb-8">{heading}</h1>
          <LevelCard {...level} locale={locale} />
        </div>
      </div>
    );
  }
  const user = signedIn;
  const session = await auth.api.getSession({ headers: await headers() });
  const {
    heading,
    userInformation,
    name,
    notAvailable,
    email,
    avatar,
    userAvatarAlt,
    sessionDetails,
    editPreferences,
    backToHome,
  } = getIntlayer("profile-page", locale);
  // /connections while it ships dark: the owner, or everyone once connections.google is on.
  const connections =
    dbBackend() === "d1" && connectionsOn(await readFlags(), isOwner(user.email))
      ? String(getIntlayer("connections-page", locale).title)
      : null;

  return (
    <div className="flex flex-col">
      <div className="flex-grow max-w-4xl mx-auto px-4 py-12 w-full">
        <h1 className="text-3xl font-bold mb-8">{heading}</h1>
        {level && <LevelCard {...level} locale={locale} />}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
          <h2 className="text-2xl font-semibold mb-4">{userInformation}</h2>
          <p className="mb-2">
            <strong>{name}</strong> {user.name || notAvailable}
          </p>
          <p className="mb-2">
            <strong>{email}</strong> {user.email}
          </p>
          {user.image && (
            <p>
              <strong>{avatar}</strong>{" "}
              <img src={user.image} alt={userAvatarAlt} className="mt-2 w-32 h-32 rounded-full" />
            </p>
          )}
        </div>
        <PasskeysCard />
        {/* A raw dump for diagnosing sign-in; shown in debug mode only. */}
        <DebugOnly>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
            <h2 className="text-2xl font-semibold mb-4">{sessionDetails}</h2>
            <pre className="text-sm overflow-x-auto">
              {JSON.stringify(
                {
                  session: session?.session
                    ? {
                        expiresAt: session.session.expiresAt,
                        createdAt: session.session.createdAt,
                        updatedAt: session.session.updatedAt,
                        // token and ipAddress intentionally omitted
                      }
                    : null,
                  user: session?.user
                    ? {
                        name: session.user.name,
                        email: session.user.email,
                        emailVerified: session.user.emailVerified,
                        createdAt: session.user.createdAt,
                        updatedAt: session.user.updatedAt,
                        id: session.user.id,
                      }
                    : null,
                },
                null,
                2,
              )}
            </pre>
          </div>
        </DebugOnly>
        <div className="flex gap-4">
          <a href="/preferences" className="text-blue-500 hover:text-blue-600">
            {editPreferences}
          </a>
          {connections && (
            <a href="/connections" className="text-blue-500 hover:text-blue-600">
              {connections}
            </a>
          )}
          <a href="/list" className="text-blue-500 hover:text-blue-600">
            {backToHome}
          </a>
        </div>
      </div>
    </div>
  );
}

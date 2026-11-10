import { getIntlayer } from "intlayer";
import { authEmail } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import { SignOutButton } from "./SignOutButton";

/**
 * Kept for old links: the menu signs out in place (lib/sign-out.ts). Listed in
 * APP_ROUTES, or the middleware sends it to /en/auth/logout, a 404.
 *
 * @author: snomiao <snomiao@gmail.com>
 */
export default async function Logout() {
  const email = await authEmail();
  // The same "Sign out" as the account menu (app-shell.content.ts).
  const { nav } = getIntlayer("app-shell", await appLocale());
  return (
    <main className="p-4 flex flex-col items-start gap-3">
      <p>{email}</p>
      <SignOutButton label={nav.signOut} />
    </main>
  );
}

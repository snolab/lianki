import { authEmail } from "@/app/signInEmail";
import { SignOutButton } from "./SignOutButton";

/**
 * Kept for old links: the menu signs out in place (lib/sign-out.ts). Listed in
 * APP_ROUTES, or the middleware sends it to /en/auth/logout, a 404.
 *
 * @author: snomiao <snomiao@gmail.com>
 */
export default async function Logout() {
  const email = await authEmail();
  return (
    <main className="p-4 flex flex-col items-start gap-3">
      <p>{email}</p>
      <SignOutButton />
    </main>
  );
}

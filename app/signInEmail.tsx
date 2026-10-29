import DIE from "phpdie";
import { auth, hasSessionCookie } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { appHref } from "@/lib/app-locale";
import { appLocale } from "@/lib/app-locale.server";

export async function authEmail() {
  const user = await authUser();
  return user.email || DIE("this user missing email, why?");
}

export async function authUser() {
  const user = await authUserOrNull();
  if (!user) redirect(appHref("/sign-in", await appLocale()));
  return user;
}

/** For API routes: returns null instead of redirecting when unauthenticated. */
export async function authUserOrNull() {
  const h = await headers();
  // A guest has no session cookie, and then getSession can only answer null:
  // skip it, so a guest's request never loads better-auth at all.
  if (!hasSessionCookie(h)) return null;
  const session = await auth.api.getSession({ headers: h });
  return session?.user ?? null;
}

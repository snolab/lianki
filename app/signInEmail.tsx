import DIE from "phpdie";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { appHref } from "@/lib/app-locale";
import { appLocale } from "@/lib/app-locale.server";

export async function authEmail() {
  const user = await authUser();
  return user.email || DIE("this user missing email, why?");
}

export async function authUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect(appHref("/sign-in", await appLocale()));
  return session.user;
}

/** For API routes: returns null instead of redirecting when unauthenticated. */
export async function authUserOrNull() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
}

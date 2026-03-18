import DIE from "phpdie";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function authEmail() {
  const user = await authUser();
  return user.email || DIE("this user missing email, why?");
}

export async function authUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/sign-in");
  return session.user;
}

/** For API routes: returns null instead of redirecting when unauthenticated. */
export async function authUserOrNull() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
}

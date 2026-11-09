import DIE from "phpdie";
import { auth, hasSessionCookie } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { BOX_PATH_HEADER, boxReturnPath } from "@/lib/box-oauth/return-path";

export async function authEmail() {
  const user = await authUser();
  return user.email || DIE("this user missing email, why?");
}

export async function authUser() {
  const user = await authUserOrNull();
  if (!user) await signInRedirect();
  return user!;
}

/**
 * To /sign-in. On a box, with the page to come back to (the middleware's
 * BOX_PATH_HEADER): a tab whose token cookie went stale (15 min) refreshes it
 * there and returns at once (BoxSignIn), instead of stopping at "sign in".
 */
export async function signInRedirect(): Promise<never> {
  if (process.env.LIANKI_BOX_CLIENT_ID) {
    const back = boxReturnPath((await headers()).get(BOX_PATH_HEADER));
    if (back) redirect(`/sign-in?${new URLSearchParams({ next: back })}`);
  }
  redirect("/sign-in");
}

/** For API routes: returns null instead of redirecting when unauthenticated. */
export async function authUserOrNull() {
  return (await authSessionOrNull())?.user ?? null;
}

/** The user and their sign-in session ({user, session}), or null for a guest. */
export async function authSessionOrNull() {
  const h = await headers();
  // A guest has no session cookie, and then getSession can only answer null:
  // skip it, so a guest's request never loads better-auth at all.
  if (!hasSessionCookie(h)) return null;
  return (await auth.api.getSession({ headers: h })) ?? null;
}

import { headers } from "next/headers";
import DIE from "phpdie";
import { auth } from "@/auth";

export async function authEmail() {
  const user = await authUser();
  return user.email || DIE("this user missing email, why?");
}

export async function authUser() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    // For better-auth, we redirect to sign in rather than automatically signing in
    throw new Error("User not authenticated");
  }

  return session.user || DIE("missing user");
}

export async function getSession() {
  try {
    return await auth.api.getSession({
      headers: await headers(),
    });
  } catch {
    return null;
  }
}

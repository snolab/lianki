import { headers } from "next/headers";
import DIE from "phpdie";
import { auth } from "@/lib/auth";

export async function getSession() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  return session;
}

export async function authUser() {
  const session = await getSession();
  return session?.user || DIE("User not authenticated");
}

export async function authEmail() {
  const user = await authUser();
  return user.email || DIE("User missing email");
}

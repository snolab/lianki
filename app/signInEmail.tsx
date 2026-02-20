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

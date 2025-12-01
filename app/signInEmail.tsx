import DIE from "phpdie";
import { auth, signIn } from "@/auth";

export async function authEmail() {
  const user = await authUser();
  return user.email || DIE("this user missing email, why?");
}
export async function authUser() {
  const session = (await auth()) ?? (await signIn());
  return session.user || DIE("missing user");
}

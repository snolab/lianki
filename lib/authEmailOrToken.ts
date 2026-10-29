import { auth, hasSessionCookie } from "@/auth";
import { headers } from "next/headers";
import { getEmailByToken } from "./getApiTokensCollection";

export async function authEmailOrToken(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const email = await getEmailByToken(token);
    if (email) return email;
  }
  const h = await headers();
  // No session cookie: getSession can only answer null — don't load better-auth.
  if (!hasSessionCookie(h)) return null;
  const session = await auth.api.getSession({ headers: h });
  return session?.user?.email ?? null;
}

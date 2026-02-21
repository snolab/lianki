import { auth } from "@/auth";
import { headers } from "next/headers";
import { getEmailByToken } from "./getApiTokensCollection";

export async function authEmailOrToken(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const email = await getEmailByToken(token);
    if (email) return email;
  }
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user?.email ?? null;
}

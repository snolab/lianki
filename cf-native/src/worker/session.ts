import { createHash } from "node:crypto";
import type { D1Like } from "@/lib/d1/types";
import { ApiTokensD1Repo } from "@/lib/repos/d1Repos";
import { getAuth, type AuthEnv } from "./auth";

export type Env = AuthEnv & { DB: D1Like };

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Email from a Bearer API token (sha256 → api_tokens), else the session cookie. */
export async function resolveEmail(env: Env, req: Request): Promise<string | null> {
  const authz = req.headers.get("authorization");
  if (authz?.startsWith("Bearer ")) {
    const email = await new ApiTokensD1Repo(env.DB).emailByHash(sha256(authz.slice(7)));
    if (email) return email;
  }
  const session = await getAuth(env).api.getSession({ headers: req.headers });
  return session?.user?.email ?? null;
}

/** Full user (id + email) from the session cookie. For browser-only routes. */
export async function resolveUser(
  env: Env,
  req: Request,
): Promise<{ id: string; email: string } | null> {
  const session = await getAuth(env).api.getSession({ headers: req.headers });
  if (!session?.user?.email) return null;
  return { id: session.user.id, email: session.user.email };
}

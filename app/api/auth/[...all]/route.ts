import { getAuth } from "@/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { authPathOf, BOX_FLAG, isOpenProviderPath, isProviderPath } from "@/lib/box-oauth/rules";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";

/**
 * Two doors stay shut here (docs/box-oauth.md). On a box, this server has no
 * sign-in of its own, only a session answer of "nobody" (without loading
 * better-auth). On lianki.com, the
 * OAuth plugin answers only the few paths it needs, and only with the flag on.
 */
async function shut(req: Request): Promise<boolean> {
  const path = authPathOf(new URL(req.url).pathname);
  if (process.env.LIANKI_BOX_CLIENT_ID) return true;
  if (!isProviderPath(path)) return false;
  if (!isOpenProviderPath(path)) return true;
  return !flagIn(await readFlags(), BOX_FLAG);
}

const notFound = (req: Request) =>
  process.env.LIANKI_BOX_CLIENT_ID && authPathOf(new URL(req.url).pathname) === "/get-session"
    ? Response.json(null)
    : new Response(null, { status: 404 });

// getAuth() is resolved per-request so the D1 binding (request-scoped) is
// available when DB_BACKEND=d1.
export const GET = async (req: Request) =>
  (await shut(req)) ? notFound(req) : toNextJsHandler(await getAuth()).GET(req);
export const POST = async (req: Request) =>
  (await shut(req)) ? notFound(req) : toNextJsHandler(await getAuth()).POST(req);
export const dynamic = "force-dynamic";

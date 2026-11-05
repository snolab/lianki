import { getAuth } from "@/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { authPathOf, BOX_FLAG, isOpenProviderPath, isProviderPath } from "@/lib/box-oauth/rules";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";

/**
 * Two doors stay shut here (docs/box-oauth.md). On a box, this server has no
 * sign-in of its own, only a session answer of "nobody". On lianki.com, the
 * OAuth plugin answers only the few paths it needs, and only with the flag on.
 */
async function shut(req: Request): Promise<boolean> {
  const path = authPathOf(new URL(req.url).pathname);
  if (process.env.LIANKI_BOX_CLIENT_ID) return path !== "/get-session";
  if (!isProviderPath(path)) return false;
  if (!isOpenProviderPath(path)) return true;
  return !flagIn(await readFlags(), BOX_FLAG);
}

const notFound = () => new Response(null, { status: 404 });

// getAuth() is resolved per-request so the D1 binding (request-scoped) is
// available when DB_BACKEND=d1.
export const GET = async (req: Request) =>
  (await shut(req)) ? notFound() : toNextJsHandler(await getAuth()).GET(req);
export const POST = async (req: Request) =>
  (await shut(req)) ? notFound() : toNextJsHandler(await getAuth()).POST(req);
export const dynamic = "force-dynamic";

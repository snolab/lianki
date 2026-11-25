import { consent } from "@/lib/mcp-oauth/handlers";
import { oauthDeps } from "@/lib/mcp-oauth/deps";

/**
 * The consent form's Allow / Deny (app/(app)/my/connected-apps/new;
 * docs/mcp-oauth.md). Only the user's own click on that page counts.
 */
export const dynamic = "force-dynamic";
export const POST = (req: Request) => consent(req, oauthDeps());

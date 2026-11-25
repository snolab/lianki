import { myApps } from "@/lib/mcp-oauth/handlers";
import { oauthDeps } from "@/lib/mcp-oauth/deps";

/**
 * The signed-in account's connected apps (OAuth for MCP, docs/mcp-oauth.md):
 * GET lists, DELETE {id} disconnects. Also with the flag off, for clean-up.
 */
export const dynamic = "force-dynamic";
export const GET = (req: Request) => myApps(req, oauthDeps());
export const DELETE = (req: Request) => myApps(req, oauthDeps());

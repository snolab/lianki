import { token, preflight } from "@/lib/mcp-oauth/handlers";
import { oauthDeps } from "@/lib/mcp-oauth/deps";

/** OAuth for the remote MCP server (docs/mcp-oauth.md). 404 while mcp.oauth is off. */
export const dynamic = "force-dynamic";
export const POST = (req: Request) => token(req, oauthDeps());
export const OPTIONS = () => preflight();

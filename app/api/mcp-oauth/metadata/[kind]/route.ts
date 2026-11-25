import { metadata, preflight } from "@/lib/mcp-oauth/handlers";
import { oauthDeps } from "@/lib/mcp-oauth/deps";

/**
 * The OAuth metadata documents (RFC 9728, RFC 8414) for the remote MCP server.
 * middleware.ts rewrites /.well-known/oauth-protected-resource[/mcp] and
 * /.well-known/oauth-authorization-server here (docs/mcp-oauth.md).
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  if (kind !== "protected-resource" && kind !== "authorization-server")
    return new Response(null, { status: 404 });
  return metadata(req, kind, oauthDeps());
}
export const OPTIONS = () => preflight();

# MCP scope requests

MCP uses the same account-bound, expiring API token as the REST API. New token
forms default to the three chat scopes. A tool list contains only tools allowed
by the token's live scopes; permission lookup failure never expands the list.

A missing permission on a known tool produces structured data:

```json
{
  "needScope": "study",
  "requestUrl": "https://lianki.com/my/tokens/scopes?token=<public-id>&scope=study"
}
```

The URL contains the public token hash, not an `lk_…` bearer secret. It requests
one scope. GET only shows the token name, current permission state and requested
permission to the signed-in owning account. An explicit session-authenticated,
same-origin JSON POST approves that one scope. Bearer authentication cannot
approve grants, and opening a link never changes permissions.

The server rechecks ownership, token expiry/revocation, the live account and any
developer-only restrictions when writing. Scope additions are additive and do
not extend expiry. Concurrent approvals must preserve each other's grants; a
concurrent revocation cannot be undone. The request is audited without secrets.

The MCP client shows the link to the user, waits for approval, then refreshes
its tools or retries. Unknown tools stay unknown; invalid/revoked tokens remain
authentication errors. Local stdio and remote Streamable HTTP share the same
scope table and missing-scope shape.

Implementation: `lib/api-token-scopes.ts`, `/api/token/scopes`,
`/my/tokens/scopes`, `packages/lianki-cli/mcp-tools.mjs`, and
`workers/mcp/src/mcp.ts`. The localized agent guide explains the same sequence.
See [API instructions](api-for-agents.md) and [token security](secrets-and-auth.md).

Apps connected by OAuth (ChatGPT, Claude.ai) get the same kind of token with
a fixed, smaller scope list; a scope request does not apply to them
([mcp-oauth.md](mcp-oauth.md)).

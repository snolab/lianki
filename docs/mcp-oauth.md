# OAuth sign-in for the remote MCP server

ChatGPT, Claude.ai and similar apps connect to `https://lianki.com/mcp` with
the user's own Lianki account: the app registers itself, sends the user to
lianki.com to sign in and approve, and gets a short-lived token. Before this,
`/mcp` took only a pasted `lk_` token, which ChatGPT's custom connectors cannot
send (they offer OAuth or no auth).

**Dark:** behind the flag `mcp.oauth`, off by default (an auth change). With it
off, every piece below answers 404, the MCP 401 is the plain one, and every
OAuth token already issued is refused (the rows stay; on again, they work).

| piece                                          | where                                                         |
| ---------------------------------------------- | ------------------------------------------------------------- |
| pure rules: scopes, registration, PKCE, checks | `lib/mcp-oauth/rules.ts`                                      |
| D1: clients, codes, grants, tokens             | `lib/mcp-oauth/store.ts`, `db/migrations/0084_mcp_oauth.sql`  |
| each route's answer                            | `lib/mcp-oauth/handlers.ts` (live I/O: `deps.ts`)             |
| well-known documents                           | `middleware.ts` rewrites to `app/api/mcp-oauth/metadata/[kind]` |
| registration, token, revoke                    | `app/api/mcp-oauth/{register,token,revoke}`                   |
| consent page and its form                      | `/my/connected-apps/new`, `app/api/mcp-oauth/consent`         |
| the account's connected apps                   | Preferences → API tokens (`ConnectedApps.tsx`), `/api/my/connected-apps` |
| the shared token check                         | `lib/api-tokens.ts` (`OAUTH_LIVE` in `checkToken`, `describeToken`) |
| the MCP 401                                    | `workers/mcp/src/mcp.ts` (`authHeaders`)                      |
| strings                                        | `app/components/connected-apps.content.ts`                    |
| tests                                          | `unit/mcp-oauth.test.ts`, `scripts/qa/qa-mcp-oauth.mjs` (qa:all `mcp-oauth`) |

## The flow (MCP authorization, 2025-06-18 / 2025-11-25)

```
app ─POST /mcp──────────────▶ 401  WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"
app ─GET  that document─────▶ resource https://lianki.com/mcp, authorization_servers [https://lianki.com]
app ─GET  /.well-known/oauth-authorization-server ─▶ endpoints, S256, iss in responses
app ─POST /api/mcp-oauth/register ─▶ client_id (lkc_…), a secret only if it asked for one
user ▶ /my/connected-apps/new?client_id&redirect_uri&code_challenge&state&scope&resource
        signed out: /sign-in, then back here
        the page names the app, the host it returns to, the account, the permissions (checkboxes)
user clicks Allow ─POST /api/mcp-oauth/consent ─303▶ redirect_uri?code&state&iss
app ─POST /api/mcp-oauth/token (code + code_verifier) ─▶ access_token lk_…, refresh_token lkm_…
app ─POST /mcp  Authorization: Bearer lk_… ─▶ the same path as any API token
```

ChatGPT (developers.openai.com/apps-sdk/build/auth): it reads the protected
resource document, requires `code_challenge_methods_supported` with `S256`,
registers by DCR when no client metadata document is advertised, sends
`resource` on authorize and token, and checks `iss` in every authorization
response. Because the metadata says `authorization_response_iss_parameter_supported`,
it uses its stable redirect URI, `https://chatgpt.com/connector_platform_oauth_redirect`.
Client ID Metadata Documents (CIMD) and `private_key_jwt` are not offered; DCR
with `none`, `client_secret_post` or `client_secret_basic` is.

## What holds it closed

- **One check.** An access token is an `api_tokens` row (`lk_` + 64 hex,
  hashed) with `oauth_grant_id` set and the grant's scopes. Every route,
  lianki-push's chat included, checks it through `checkToken` /
  `describeToken` exactly as a token made by hand. The only extra rule,
  `OAUTH_LIVE`, is in that same query: its grant must exist for the same account
  and the flag's row must be on (read live, no cache).
- **Scopes, default deny.** `MCP_OAUTH_SCOPES`: `study`, `chat:read`,
  `chat:write`, `chat:ask`. Never the owner's (`eval`, `progress`,
  `recordings:read`), nor `mic:polish` (spends credits), `chat:play` (sound on
  the phone) or `apps:publish`. A requested scope outside the list is dropped;
  none left means the whole list is offered, and the user unticks what they
  do not want. A scope request (`/my/tokens/scopes`) never changes an app's
  token: connect the app again instead.
- **Consent is the user's click.** Opening the page changes nothing. The form's
  POST counts only as a same-origin, top-level, user-activated navigation
  (`Origin`, `Sec-Fetch-Site/Mode/Dest/User`), which a page's script cannot
  fake, so script on a lianki.com page (a `?live` frontend) cannot mint a code.
  The request is checked again from scratch on POST.
- **The app's name is its own claim.** The page shows it beside the host its
  redirect URI goes to, and says so.
- **Redirect URIs.** Registered: https, or http on the loopback (desktop apps);
  no fragments, user info or custom schemes; at most 5. Matched exactly. An
  unknown client or an unregistered redirect URI is shown on lianki.com and
  never redirected; any other error goes back to the app with `iss`.
- **Codes** work once (taken before checking), last `mcp.oauthCodeSeconds`
  (60 s), and are bound to the client, redirect URI, PKCE S256 challenge,
  account and approved scopes. Another client's code or refresh token is
  `invalid_grant`.
- **Lifetimes** (cfg): access `mcp.oauthAccessMin` (60 min), refresh
  `mcp.oauthRefreshDays` (30 days, renewed on each use). Refresh rotates in one
  conditional UPDATE; the old refresh token and the old access token stop.
- **Revocation.** The user's Disconnect (Preferences), the app's own RFC 7009
  revoke, and sign-out everywhere (`revokeAllTokens`) each delete the grant;
  its tokens are refused at once and the chat hub is told to close their sockets.
  One grant per app and account: connecting again replaces it.
- **Rate limits** (cfg): registration `mcp.oauthRegisterPerHour` per IP (it needs
  no sign-in), token and revoke `mcp.oauthTokenPerMin` per IP.
- **Clean-up.** The list and Disconnect work with the flag off too.

Not done yet: CIMD; removing registered clients that never connected (rows
are small and rate-limited).

## Trying it from ChatGPT

1. Apply `0084_mcp_oauth.sql` to D1.
2. `/dev/flags#mcp.oauth` on (everyone can connect once it is on).
3. chatgpt.com/plugins → + → Add custom MCP server; URL `https://lianki.com/mcp`,
   authentication OAuth (it discovers the rest; no client id or secret to paste).
4. Sign in on lianki.com, Allow. Preferences → API tokens → Connected apps shows it.

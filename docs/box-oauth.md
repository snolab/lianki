# A box signs in through lianki.com

A my-box ([devbox/README.md](../devbox/README.md)) runs its owner's code on
`my-<hash>.lianki.com`. With this, that code signs in through lianki.com and
uses the production API as one Lianki account, through a short-lived token and
no shared cookie. Owner's decision: Slack, 2026-11-05.

**Dark:** behind the flag `box.oauth`, off. With it off, everything here answers
as if it did not exist.

| piece                                       | where                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| pure rules: origins, allowlist, scopes      | `lib/box-oauth/rules.ts`                                                            |
| the Worker's gate                           | `lib/box-oauth/gate.ts`, called first in `worker.ts`                                |
| provider (better-auth plugin), binding hook | `lib/box-oauth/provider.ts`, `auth-impl.ts`                                         |
| lianki.com's entry to the flow              | `app/box-authorize/route.ts`                                                        |
| which plugin routes answer                  | `app/api/auth/[...all]/route.ts`                                                    |
| binding, revoke, token lookup               | `lib/box-oauth/store.ts`, `db/migrations/0049_box_oauth.sql`                        |
| owner's page and API                        | `/dev/box-clients`, `app/api/dev/box-clients/route.ts`                              |
| the app's view of a token                   | `lib/box-oauth/identity.ts`, `app-session.ts`, `auth.ts`                            |
| the box's browser side                      | `lib/box-oauth/client.ts`, `/box-callback`, `BoxSignIn`, `BoxApiBridge`             |
| the box's signed-in view                    | `lib/box-oauth/session.ts`, `me.ts`, `app/api/box/me`, `BoxApiBridge`               |
| tests                                       | `unit/box-oauth.test.ts`, `unit/box-session.test.ts`, `scripts/qa/qa-box-oauth.mjs` |

## For the owner: set up a box

1. `/dev/box-clients`: bind the box's exact origin to one account, read or
   read + write. Copy the client id (not a secret).
2. In the box's gitignored env file, set `DEVBOX_LIANKI_CLIENT_ID=<id>` (and
   `DEVBOX_LIANKI_SCOPE=box:read offline_access` for a read-only box), and
   recreate the box. Its own sign-in and sign-up are gone from then on.
3. `/dev/flags`: `box.oauth` on. This is the switch that opens it.

**Revoke** on the same page is the one action that ends a box: its binding, its
client and every token, at once. Every bind and revoke is in `security_audit`.

## The flow

```
box /sign-in ─▶ lianki.com/box-authorize       flag, exact redirect URI, account = binding
                 │ signed out: lianki.com/sign-in, then back here
                 ▼ a page, not a redirect: lianki.com's own navigation from here on
              /api/auth/oauth2/authorize       the plugin; the hook checks the binding again
                 ▼
box /box-callback?code=…&state=…               state checked, code traded once (PKCE S256)
                 ▼
POST lianki.com/api/auth/oauth2/token          cross-origin, no cookie
                 ▼
box page: fetch("/api/…") ─▶ lianki.com/api/…  Authorization: Bearer lkb_…, credentials omit
```

The client is public: PKCE, and no secret anywhere in the box. Access tokens
last 15 min, refresh tokens 24 h and rotate, codes 60 s and work once. All are
stored hashed. The browser keeps them in that tab's sessionStorage.

## What holds it closed

- **One box, one account.** `box_binding` has partial unique indexes on origin
  and on account. Any other account is refused three times over, all on the
  server: at the entry, in the plugin's hook, and in the gate, whose token lookup
  joins the token's user to the binding's.
- **The plugin answers three routes.** It mounts 34, including client CRUD for
  any signed-in user and dynamic registration. Only `authorize`, `token` and
  `revoke` answer, and only with the flag on; the rest are 404 at
  `app/api/auth/[...all]`. Consent is off: the owner's binding is the grant. That
  is right only while the owner alone can bind a box to an account; opening binding
  to members means revisiting it and adding a consent screen.
- **Exact redirect URIs.** One per client, origin + `/box-callback`, no loopback
  port leniency.
- **Deny by default.** A token reaches only the routes listed in
  `tokenMayCall` (`rules.ts`), the account's own study data. A new route is closed
  until someone adds it. Never `/api/dev*`, `/api/debug`, payments, invites and
  gift codes, API tokens, CLI login, previews, connections, or `/api/auth`, so
  no email or login change. The BYOK relay (`/api/byok/proxy`) and email change
  (`/api/profile/email`) are closed too. Encoded and otherwise odd paths are refused,
  so the list cannot be walked around.
- **Scopes.** `box:read` is GET and HEAD, minus the GETs that write (grading,
  deleting, `/repeat`). `box:write` adds the rest. Read-only routes take no
  writes with either. A token never has more than its binding.
- **CORS.** Only a live box's exact origin, and never
  `Access-Control-Allow-Credentials`. A token and a cookie together are refused.
  A token works only from its own origin.
- **The app sees no token and no cookie.** The gate strips both and sends a
  signed one-minute identity instead (`x-lk-box-identity`, HMAC with a key derived
  from `AUTH_SECRET`). It strips that header from all incoming requests. `auth.ts`
  answers `getSession` from it, so routes need no change, and a bad one is nobody,
  never a fall back. `Set-Cookie` is dropped on the way back.
- **Rate limit per token:** 300 requests a minute (`worker.ts`), on top of each
  route's own per-account limits.
- **No secrets in the box.** No Cloudflare credential, no D1 access, no token in
  the image or the env file.

- **Only a real navigation gets a code.** The plugin hands its redirect URL, code
  included, as JSON to any `fetch`. JS on lianki.com with the user's session, such
  as a `?live` custom frontend, could then read a code with its own PKCE verifier
  and mint a token that outlives the preview. So `/oauth2/authorize` takes only a
  top-level navigation by lianki.com's own entry page (`isFirstPartyNavigation`:
  Fetch Metadata, which a page's JS cannot set). A code then goes only to the
  box's exact redirect URI, where such a page cannot read it.

### The sibling guard

A box is a sibling subdomain, and `SameSite=Lax` sends the session cookie to
lianki.com from its pages. `lib/security/same-site-guard.ts`
([security-measures.md](security-measures.md) §11) refuses a cookie-carrying
same-site request to `/api`, first thing in `worker.ts`. That is why the entry is
`/box-authorize`, not under `/api`, and why a box's own calls omit cookies. A
`__Host-` cookie does not replace this: it stops subdomains setting the cookie, not
sending it.

### Custom frontends

`?live` frontends keep their own rule: account writes are refused while the live
cookie is set (`customFrontendBlocked`). Nothing here relies on it: any normal
lianki.com page load clears that cookie, browser-wide, so it is no boundary (an
open finding of the #600 review, not fixed here). A token is minted only through
the navigation rule above, never through a route on that block, and
`unit/box-oauth.test.ts` checks each of those writes is closed to a token as well.

## The box's signed-in view

The box's server has no session, so the page asks lianki.com. `BoxApiBridge`
wraps every page from the root layout (landing and blog included). With a token
in the tab it calls `GET /api/box/me` through the box's fetch. That route is on the
allowlist, read-only, exactly that path, takes no parameter, and answers only a
request carrying the gate's signed identity (404 otherwise, so lianki.com's own pages
get nothing new). It returns the bound account's name, email and avatar.

Until the answer comes, the page is a spinner: the server's HTML never holds a
"Sign in" link. Then `useShellUser` gives the header and account menu the account.
`useSignedIn` does the same for client pages that took `isLoggedIn` from the server:
home, read, the reader, review, data, sites, next, and import's paste box. `PrefSync`
starts as on any signed-in device. An uploaded avatar is fetched from lianki.com
(`/api/avatar`, public, read-only to a token) and shown as a blob URL. A 401 forgets
the tokens. Sign-out (`lib/sign-out.ts`) then calls `boxSignOut`, which revokes the
refresh token, instead of better-auth's cookie sign-out.

Still signed out, because they are drawn on the box's server:

- `/learn` and `/polyglot` redirect to `/sign-in`. On a box with a token, that page
  says so and links to lianki.com, instead of going round the flow again.
- `/list` and `/import` show their guest view; `/profile`, `/preferences`,
  `/connections`, `/self-intro`, `/ai-vocab` and the `/dev` pages read the server's user.
- Server-decided extras: the level chip, flag-gated nav items, the owner's dev
  switch and live view.

**The Learning Partner chat does not work on a box.** It talks only over the
lianki-push WebSocket (`/api/version/debug`), which takes a lianki.com Origin with the
session cookie, or a site-owner ticket. A box page has neither. Its HTTP routes
(`/api/debug/*`, `/api/dev/*`) are closed to tokens, by design; only cloud TTS
(`/api/words/tts`) passes. Opening any of that is the owner's decision.

## How it was tested

`scripts/qa/qa-box-oauth.mjs`, in a real browser: the provider is the OpenNext
Worker under `wrangler dev` on local D1, the box a separate `next dev`. It has not
run against production, where the flag is off. On 127.0.0.1 the two share a site,
as a box and lianki.com do, but the box is http and registered as a native client;
a real box is https and `web`.

## Known limits

- **Client-side only.** The box's `fetch` goes to lianki.com, but its server
  components still read the box's own (empty) session and local D1. The shell and
  the client pages show the account (above); server-drawn parts do not.
  `authClient.useSession` is empty (nothing in the app uses it).
- **An owner's own box.** Bound to an owner's account (`site_role`), admin routes stay
  closed, but on allowlisted routes `isOwner` is true, so owner-only feature
  previews apply. Accepted (owner's direction, 2026-11-05): tokens never reach
  admin routes, which is what matters.
- **Token in the page.** Any script on the box can read the tab's token. That
  is the box's own code and the box's own account, and the token is short-lived.
- **Cookie tossing.** A box is a subdomain, so its JS can set a cookie with
  `Domain=lianki.com`, which lianki.com then receives. The `__Host-` names on every
  better-auth cookie close that ([secrets-and-auth.md](secrets-and-auth.md), "The session
  cookie"). Cookies outside better-auth, such as the language one or `lk_device`, can still be planted.

## Edge gate (designed, not built)

The tokens protect the account. They do not stop anyone with the URL from opening
the box's pages: today the hash is the only thing hiding them. The gate makes a
box open only for its own member. No code for it exists yet.

**Option A, Cloudflare Access: needs a new credential.** An Access application
per host, one allow-email policy, and `originRequest.access` on the connector
(`devbox/host-tunnel.sh` already writes that rule for dsh). It needs an API token
with **Account · Access: Apps and Policies · Edit**, and a Zero Trust team, which
has not been confirmed to exist. Members sign in twice: Access, then Lianki.

**Option B, a small Worker: needs no new credential (recommended, to be proved).**
A Worker `lianki-box-gate` on an exact route per box, added through the API with
wrangler's existing login, which has `workers_routes:write`. Hostnames stay in D1,
never in a config file in the repo.

1. A request with a valid `__Host-lk_box_gate` cookie (host-only, Secure,
   HttpOnly, HMAC over client id + user + expiry) goes to the tunnel.
2. Otherwise a redirect to `lianki.com/api/box/gate?client=<id>`, which checks the
   session against `box_binding` and returns a one-time 60 s ticket to that box's
   exact origin. The Worker trades it and sets the cookie. This also signs members
   in only once.
3. Anyone else gets a plain 403. Websockets (HMR) pass through after the cookie.

To prove before building: that a Worker route on a proxied CNAME to a tunnel runs
ahead of the tunnel (expected; not tested here), and that wrangler's OAuth token
may create routes through the API. If either fails, it is Option A.

Neither gate blocks the other work: it sits in front of the box, and the flow
above is unchanged behind it.

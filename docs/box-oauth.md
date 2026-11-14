# A box signs in through lianki.com

A my-box ([devbox/README.md](../devbox/README.md)) runs its owner's code on
`my-<hash>.lianki.com` or a named `my-<name>.lianki.com` (one rule for both:
`isBoxHost` in `lib/box-oauth/rules.ts`, reserved names as data). With this, that code signs in through lianki.com and
uses the production API as one Lianki account, through a short-lived token and
no shared cookie. Owner's decision: Slack, 2026-11-05.

**Dark:** behind the flag `box.oauth`, off. With it off, everything here answers
as if it did not exist.

| piece                                       | where                                                                                                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pure rules: origins, allowlist, scopes      | `lib/box-oauth/rules.ts`                                                                                                                                                                       |
| the Worker's gate                           | `lib/box-oauth/gate.ts`, called first in `worker.ts`                                                                                                                                           |
| provider (better-auth plugin), binding hook | `lib/box-oauth/provider.ts`, `auth-impl.ts`                                                                                                                                                    |
| lianki.com's entry to the flow              | `app/box-authorize/route.ts`                                                                                                                                                                   |
| which plugin routes answer                  | `app/api/auth/[...all]/route.ts`                                                                                                                                                               |
| binding, revoke, token lookup               | `lib/box-oauth/store.ts`, `db/migrations/0049_box_oauth.sql`                                                                                                                                   |
| owner's page and API                        | `/dev/box-clients`, `app/api/dev/box-clients/route.ts`                                                                                                                                         |
| the app's view of a token                   | `lib/box-oauth/identity.ts`, `app-session.ts`, `auth.ts`                                                                                                                                       |
| the box's browser side                      | `lib/box-oauth/client.ts`, `/box-callback`, `BoxSignIn`, `BoxApiBridge`                                                                                                                        |
| the box's signed-in view                    | `lib/box-oauth/session.ts`, `me.ts`, `app/api/box/me`, `BoxApiBridge`                                                                                                                          |
| the box's server sees the sign-in           | `lib/box-oauth/server-session.ts`, `server-auth.ts`, `return-path.ts`, `auth.ts`, `BoxSignIn`                                                                                                  |
| chat on the owner's box (`box:chat`)        | `lib/box-oauth/chat-ticket.ts`, `app/api/box/chat-ticket`, `workers/push/src/auth.ts`                                                                                                          |
| code on the owner's box (`box:eval`)        | `lib/box-oauth/store.ts` (`setBoxEval`, `boxEvalLive`), `worker.ts` (`boxEval`), `workers/push/src/debug.ts`                                                                                   |
| tests                                       | `unit/box-oauth.test.ts`, `unit/box-allowlist.test.ts`, `unit/box-session.test.ts`, `unit/box-locale.test.ts`, `unit/box-chat.test.ts`, `unit/box-eval.test.ts`, `scripts/qa/qa-box-oauth.mjs` |

## Account self-service: /my/boxes

Every signed-in account can open **My box** from `/my` to inspect its current
binding (address, scopes, binding date). `/api/my/boxes` reads only that
session account. With no binding, the page shows an empty state.

Disconnect is confirmed inline, then revokes the binding, disables the OAuth
client and its tokens through the existing revoke path, and notifies the
chat hub. The request must be same-origin JSON and match the current box id;
another account's id or a stale binding id cannot revoke anything. It never
deletes a machine or files. Reconnecting requires a new administrative
binding; this page cannot create bindings or grant permissions.

Inspection and disconnection work even while `box.oauth` is off or the
account is off the allowlist, so access can still be cleaned up. A guest
cannot read or write; the page redirects to sign-in, the API returns 401.
The API returns 503 off D1. Tests: `unit/my-box.test.ts`.

## Who may have a box

my-box is a premium feature (owner, 2026-11-07): **default deny**, only for
users the owner approves. One list covers all of it: binding a box, its
address (the origin it is bound to), box chat, and custom frontends
([custom-frontend.md](custom-frontend.md)). It is the table
`live_frontend_allow`, kept on `/dev/box-clients` (add by email or user id,
remove) and shown on `/dev/live-frontends` as well; code in
`lib/box-oauth/allowlist.ts`. An admin approves the list; an account holding
`dev` (`account_permission`) needs no row of its own.

- **Bind time.** `/dev/box-clients` refuses to bind an account that is not on
  the list (403, and a `box.bind-refused` row in `security_audit`).
- **Every use.** The list is part of the SQL of every lookup a box's use goes
  through (`lib/box-oauth/store.ts`): `bindingByOrigin` (preflight, code
  exchange), `liveToken` (every token request, so the chat-ticket and STT
  routes too), `bindingByClient` (`/box-authorize`, the OAuth provider's
  checks, `chatBinding`, the hub's `boxChatLive` and `boxEvalLive`). A binding
  whose account is off the list is no box at all, read live on each request.
  `box:chat` and `box:eval` still also need the account to be a site owner.
- **Removing someone** revokes their box (binding, client, every token; the
  hub's chat socket is told to close) and stops their previews, at once.
  Adding them back does not revive a revoked box: bind it again.
- **Audit.** Adds and removes are `live-frontend.allow` /
  `live-frontend.disallow` (the list's kinds from before it covered boxes),
  plus `box.revoke` for the box a removal ends.

A box bound before the list existed stops working until its account is added
(the binding shows "不在名单上" on `/dev/box-clients`); that is the default deny.

## For the owner: set up a box

0. `/dev/box-clients`: put the account on the box list (above).
1. `/dev/box-clients`: bind the box's exact origin to one account, read or
   read + write. The host's shape only lets it be bound; the binding is the
   authority, so a well-formed host nobody bound (hex or named) gets nothing. Copy the client id (not a secret).
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
  until someone adds it. Never `/api/dev*`, `/api/debug` (except the chat mic, with
  `box:chat` below), payments, invites and
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
get nothing new). It returns the bound account's name, email and avatar, and
production's flags and owner role for it ("Flags on a box", below).

Until the answer comes, the page is a spinner: the server's HTML never holds a
"Sign in" link. Then `useShellUser` gives the header and account menu the account.
`useSignedIn` does the same for client pages that took `isLoggedIn` from the server:
home, read, the reader, review, data, sites, next, and import's paste box. `PrefSync`
starts as on any signed-in device. An uploaded avatar is fetched from lianki.com
(`/api/avatar`, public, read-only to a token) and shown as a blob URL. A 401 forgets
the tokens. Sign-out (`lib/sign-out.ts`) then calls `boxSignOut`, which revokes the
refresh token, instead of better-auth's cookie sign-out.

The pages drawn on the box's server see the sign-in too: next section.
Still decided from the box's own local D1: the flag-gated server extras (the
level chip, flag-gated nav items).

### The box's server sees the sign-in

Until 2026-11-09 the box's server saw nobody: the tokens are in the tab's
sessionStorage, which a server never receives. So every page it decides said
"sign in" to a signed-in tab: `/learn` and `/polyglot` redirected to
`/sign-in`, `/list` and `/import` showed their guest view, and `/my/profile`,
`/my/preferences`, `/connections`, `/self-intro`, `/ai-vocab`, `/chat/history`,
`/roadmap` and the `/dev` pages read no user.

Now (`server-session.ts`, `server-auth.ts`):

- **The cookie.** Each time the tab gets a token (sign-in, refresh) and on every
  page load, it writes the access token into one cookie of the box's own host:
  `__Host-lk_box_at` (Secure, Path=/, no Domain, SameSite=Lax; `lk_box_at` on an
  http QA box), lasting as long as the token (15 min). Never the refresh token.
  A `__Host-` cookie goes to this host only: never to lianki.com or another box.
  Sign-out, a refused token and a failed sign-in clear it.
- **The server asks lianki.com.** On a box, `auth.api.getSession` (auth.ts)
  never loads better-auth: it reads that cookie and calls `GET /api/box/me` as the
  page does, with `Authorization: Bearer`, `Origin` = the box's own origin
  (`BETTER_AUTH_BASE_URL`), no cookie, through the same gate. The answer (the
  account's id, name, email, avatar, owner role) is kept 30 s per token. Anything
  off is nobody: no cookie, a malformed one, an expired or revoked token,
  lianki.com unreachable, no configured origin. There is no local session to fall
  back to.
- **What it opens.** Nothing on lianki.com: the server holds the same token the
  page already does, from the same origin, and can call only what the token can.
  `/api/box/me` now also says the account's `id`, so the box's server keys its
  session by the real account. Its permissions are lianki.com's for that account:
  `/api/box/me` reports `isAdmin` and `isDev`, and the box's server puts exactly
  those into its snapshot (`setPermissionSnapshot`; an answer without them grants
  nothing), so the box's own `/dev` pages show as on lianki.com; their
  calls still go to lianki.com, where a token never reaches `/api/dev`.
- **Data drawn on the server is still the box's own.** A server page that reads
  D1 itself (`/list`'s cards, `/roadmap`'s goals, `/connections`) reads the box's
  local D1, signed in now but mostly empty. Client pages read lianki.com
  through the box's fetch, as before. Server actions write the box's local D1
  only.
- **A stale cookie.** A tab left open past its token's 15 minutes still holds a
  stale cookie when it navigates; the server then sends it to
  `/sign-in?next=<the page>` (the middleware puts the path in `x-lk-box-path`, on
  a box only). `BoxSignIn` refreshes the token, writes the cookie and goes
  straight back. The same page twice within 20 s means the server still cannot
  see it: then it says so instead of looping. Signed in with no `next`, it opens
  `/home`.
- **A new tab.** Its sessionStorage is empty but the cookie (another tab's) is
  there, so the server draws it signed in. `BoxApiBridge` then runs the sign-in
  round trip for that tab (lianki.com is signed in, so it is only redirects) and
  comes back to the same page (`startBoxSignIn(config, back)`; `/box-callback`
  opens `back`, else `/home`).

The Learning Partner chat works on a box only with `box:chat`, below.

### The box's language

A box is its own host, so lianki.com's `lang` cookie (host-only) never reaches
it. Before this, the box's server guessed from Accept-Language, and the
landing link it renders (`/<locale>`) seeded the box's own `lang` cookie with
that guess, so the owner's box opened in French while lianki.com showed
Chinese for the same account (2026-11-08). Now `/box-callback`, right after
the code is traded, reads the account's `ui.locale` (`GET /api/prefs` through
the box's fetch) and writes the box's `lang` and `NEXT_LOCALE` cookies before it
opens `/home`: the language picked by hand on any device first, then the
browser's languages, then English (`lib/box-oauth/locale.ts`). It never writes
`lk:ui-locale`, which means "picked by hand" and would be uploaded; later
changes arrive through `PrefSync` as on any device.

### Flags on a box

A box's own server reads its **local** D1 (usually an empty `feature_flags`, so
every flag off) and has no session (so `isOwner` is false). A page that decides
on the server would show the box what an anonymous user with every flag off
sees, not what the bound account sees on lianki.com. The owner hit this on
2026-11-07: his box showed the old reader at `/reader/<id>`, because
`read.reader-v2` (since removed) was off in the box's D1 and the server did not
know him.

So `/api/box/me` also answers **production's flags** (`readFlags()`, the same
30 s cache as every lianki.com request) and **whether the bound account is a
site owner**. `BoxApiBridge` reads them in the same call it already makes before
the page renders, so it costs no extra request and no flash. Client components
decide with `useFlagView({ flags, owner })`: on a signed-in box, production's
answer; otherwise the server's. They are read once per page load (a full reload
picks up a flip at /dev/flags). Only registry keys with boolean values are kept;
an older lianki.com that does not send them means all off, not the owner.

Used today by `/reader/[id]` (`BoxReader`: the live-draft gate). Other server-decided parts listed above still read the box's own D1; move
one to `useFlagView` when a box needs it. No sync of the local D1 is needed or
done.

## Chat on the owner's box (`box:chat`)

Owner's decision, by tap card, 2026-11-07: the Li chat (Learning Partner, with
voice) works on his own box, signed in through the box token. **He accepted that
any script running on the box can then use the chat as him**: read the owner's
chat history, send lines to the agents, transcribe with the mic, and tap ask
cards, approvals included. That is the box's own code, its dependencies, and
anything an agent runs there.

**Who can have it.** Only a box whose binding's account holds `dev`
(`account_permission`, [secrets-and-auth.md](secrets-and-auth.md), "Permissions"). The
owner turns it on per box on `/dev/box-clients` ("允许盒子上的聊天", behind a
warning and a confirm) and off with "关闭盒子上的聊天". Revoking the box ends it
with everything else. Each grant, removal and ticket mint is in `security_audit`
(`box.chat-grant`, `box.chat-remove`, `box.chat-ticket`). A box without it sees
no change at all.

**The scope is the binding's, not the token's.** `box:chat` is never asked for in
the OAuth flow (it is not in `BOX_SCOPES`), so no box env changes and no new
sign-in: `liveToken` gives every live token of a binding `box:chat` exactly while
the binding holds it. Removing it takes effect on the next request.

**What it opens, and nothing more.** Three routes, each with its one method,
exact paths (`tokenMayCall`; without the scope they are 404 to a token as
before):

| route                       | what                                                         |
| --------------------------- | ------------------------------------------------------------ |
| `POST /api/box/chat-ticket` | a 60 s single-use ticket for the hub socket                  |
| `POST /api/debug/stt`       | the chat mic's transcription (cloud STT, the owner's limits) |
| `GET /api/dev/state-tree`   | the state tree's outline, for the chat's tree and ETA bar    |

No other `/api/debug*` or any `/api/dev*` route: no eval, no pairing, no
page-error log, no inbox upload, no state-tree writes or resolves, no local STT
ticket. Read-aloud uses the TTS routes a box already had.

**Fail closed, four times.** (1) Grant: `setBoxChat` refuses a binding whose
account does not hold `dev`. (2) The gate: a `box:chat` route also needs the
token's account to hold `dev`, read from D1 on that request
(`isDevUser`, no cache). (3) The routes: `chat-ticket` and `stt` check the
signed identity's binding again (`boxChatCaller`: live, same account, holds the
scope, holds `dev`). (4) The hub: before it takes each line from a box socket it
asks the main Worker (`DebugSessions.boxChat`, an RPC with no URL): flag on,
binding live with the scope, account a site owner. "gone", or a main Worker that
has no such check, closes the socket (4401). An unsure answer drops that line only.

**The socket.** The page fetches a ticket through the box's fetch (token,
`credentials: "omit"`), then opens `wss://lianki.com/api/version/debug` from the
box's origin offering `Sec-WebSocket-Protocol: lianki-partner, <ticket>`, never the
ticket in the URL (`DebugEval`, `boxChatHub` in `client.ts`). The ticket is signed
with the partner key under its own audience (`lianki-box-chat`) and names the box's
exact origin and client id. lianki-push (`boxChatTicket` in
`workers/push/src/auth.ts`) takes it only from that exact origin, which must be a
box origin; the hub burns its id once. A partner ticket is never a box ticket and
the other way round; a lianki.com cookie page can never claim to be a box.

**What the socket may do.** Without `box:eval` (below), it is the owner's thread, as an embedded page: no eval
ever reaches it, it never counts for a pairing or a grant, never joins a recording
session, and its `state` carries no pairings, sessions or pages. Beyond the plain
partner widget's `chat` and `page`, it may send `passage-end` and `unmerge` (voice
lines amending each other) and `answer` (an ask-card tap). Its lines' label starts
with `box `, so agents can tell where a line or a tap came from.

**Ending it.** Removal and revoke also tell lianki-push over the PUSH binding
(`/internal/box-closed`, the client id only), which closes that box's sockets at
once. That notice is best effort; the per-line check above is what guarantees a
socket that outlived it can say nothing.

**Avatars.** The hub knows no name or picture for a box socket (a ticket, no
identity), so the box's own lines once showed the initial of "owner"; the chat
now takes the viewer from `/api/box/me` (`boxViewer`). Pictures stored on lines
are `https://lianki.com/api/avatar/…`, which the sibling guard refused as a
cookie-carrying same-site request until it let that one read through
([security-measures.md](security-measures.md) §11).

**Not changed.** The box holds no lianki.com cookie, and its refresh token stays in the tab's
sessionStorage. A ticket lives 60 s and works once; a box page asks for one per
connect (20 a minute at most per box), and a refused page does not ask again
until it reloads.

**To use it** (after both Workers are deployed): on `/dev/box-clients`, turn on
chat for the owner's box; on the box, open any page with `?debug=1` once (the
chat follows debug mode, as on lianki.com).

## The state tree on the owner's box

The chat's tree and its ETA bar (flag `chat.eta-bar`) need two things a box
lacked, both owner-only on lianki.com by cookie: the outline and the live
progress socket. Without them the box's tree was empty and the bar, which
shows only timed tasks, never appeared (2026-11-08).

- **The outline**: `GET /api/dev/state-tree` through the box's fetch (its
  token). The gate lets a box:chat token through as for the other chat routes
  (site owner read now), and the route checks `boxChatCaller` again; anything
  else, 404. The text is the bundled `docs/state-tree.md`, public in the repo
  anyway.
- **Live progress**: `wss://lianki.com/api/version/progress` from the box's
  origin, offering `lianki-partner, <ticket>`: a fresh box chat ticket from
  `/api/box/chat-ticket`, as the chat socket's (each socket mints its own).
  lianki-push takes only a box chat ticket there (`boxChatTicket`: never a
  partner ticket, only from the exact box origin it names) and hands the
  progress hub the client id (`x-progress-box`) and the ticket's id, never the
  owner header; a cookie page's own `x-progress-box` is stripped. The hub burns
  the ticket once and asks the main Worker (`DebugSessions.boxChat`) at
  connect; it asks again before sending to that socket once its last answer is
  30 s old, and before each `{type:"eta"}` the box sends. "gone" (or a main
  Worker without the check) closes it with 4401, after which the page does not
  ask again until a wake; unsure skips that message. A box reader may send
  `{type:"eta"}` only: it never resolves a node. Removal or revoke also closes
  it at once: `/internal/box-closed` goes to both hubs (an eval-only notice to
  the chat hub alone).

The flag itself: the layout reads flags on the box's own server (its local
D1, no session), so on a box `DebugEval` takes `chat.eta-bar` from
production's answer for the signed-in account instead (`/api/box/me`, shared
by `BoxApiBridge` through `useBoxAccount`; `ownerFlagOn`), and only for a site
owner.

`DebugEval` builds the live source only once the hub has said this is the
owner's page, and on a box only while `boxChatHub` has one to give (a box
refused a chat ticket gets no tree and no bar).

## Code on the owner's box (`box:eval`)

Owner's decision, by tap card, 2026-11-07 ("允许 box 的令牌直接用聊天接口……包括执行代码和配对"),
and his reason (22:40 JST): the box exists so the frontend can be changed live,
so running code on its pages is its purpose. **The trust boundary, in plain
words: with `box:eval` on, any script on that box can run code on the owner's
pages through the hub.** Its own code, its dependencies, anything an agent runs
there can pair with the hub (the owner still taps Allow), take an eval grant
that covers every page (lianki.com's included when he allows "all"), and send
page errors to the agents. That is on top of everything `box:chat` already
gives.

**Who can have it.** Only a box that holds `box:chat` and whose binding's
account is a site owner. It is never implied by `box:chat`: the owner turns it
on per box on `/dev/box-clients` ("允许盒子上的代码执行", behind its own warning and
confirm) and off with "关闭盒子上的代码执行". Turning chat off removes it too;
revoking the box ends it with everything else. Each grant and removal is in
`security_audit` (`box.eval-grant`, `box.eval-remove`).

**Never on a token.** Like `box:chat` it is the binding's alone, and unlike it
it never rides on a box token (`liveToken` drops it) and opens no HTTP route.
Only the hub uses it, by asking the main Worker.

**Fail closed.** (1) Grant: `setBoxEval` refuses a box that is not a site
owner's or lacks `box:chat`. (2) The hub asks the main Worker
(`DebugSessions.boxEval`, an RPC with no URL; flag on, binding live with both
scopes, account a site owner, read from D1 each time) at connect, before each
eval it sends to that box, and before each pairing answer, result or page error
it takes from it. "gone" drops the box's pages back to chat-only; unsure drops
that one eval or message. A main Worker without the check counts as gone.
(3) Removal also tells lianki-push (`/internal/box-closed` with `scope: "eval"`),
which drops that box's pages to chat-only at once; their chat goes on.

**What the box page then is.** An owner page in the hub: listed in the pages,
labelled `box <path>`, sent the whole state (pairings, grants, pages), reached
by eval (`eval.ts --target box`, or by its page id in a grant), able to answer
a pairing (the modal shows there; the tap on that page is still the only
approval), and its page errors are forwarded. Still never: clips or recording,
a session, or renewal. A grant approved on a box page carries no session, so it
lasts its 8 hours and then needs a tap. The 8-hour grants approved elsewhere
reach box pages like any page they cover. So does an eval token
([secrets-and-auth.md](secrets-and-auth.md), "Eval tokens"), and only while the
box holds `box:eval`.

**Hot replace on a box.** A box runs `next dev` on its own tree, so its own
edits already reach its pages by HMR. For the Mac's working tree:

- the widget hot-load (`lk:debug-widget-src`) follows the owner's page, which a
  box chat page already is, so it worked with `box:chat` alone;
- hot islands (`lk:slots-src`) need a code-run grant for the page, which a box
  page can only hold with `box:eval`: from it, the grant in the hub's state
  turns them on as on lianki.com;
- live view (`?live=`, the Dev parts chip) is lianki.com's Worker serving dev
  code at lianki.com's own address. It does not apply to a box, which is dev
  code already.

The Mac's dev servers answer CORS only for lianki.com, loopback and
`LIANKI_DEV_ORIGINS`, so the box's exact origin goes in that variable where they
run (never in the repo).

**To use it**: with chat on, turn on code on `/dev/box-clients`, then reload the
box page (a page connected before the grant stays chat-only until it
reconnects). `bun scripts/dev/eval.ts --target box '<code>'` pairs as usual; the
prompt shows on the box page too.

## How it was tested

`scripts/qa/qa-box-oauth.mjs`, in a real browser: the provider is the OpenNext
Worker under `wrangler dev` on local D1, the box a separate `next dev`. It has not
run against production, where the flag is off. On 127.0.0.1 the two share a site,
as a box and lianki.com do, but the box is http and registered as a native client;
a real box is https and `web`.

## The service worker on a box

A box runs `next dev`, whose chunk names stay the same across edits and
restarts. The site's service worker (`public/sw.js`) caches `/_next/static`
cache-first, so on a box it served the previous build's chunks next to the new
ones and the page never hydrated (2026-11-07: a spinner forever, and the box's
fetch never reached lianki.com). On a `my-*.lianki.com` host (any box, hex or named) the worker now answers
nothing, caches nothing, and deletes what an older worker cached
(`unit/sw-box.test.ts`). A browser picks the new worker up on its next
navigation; the reload after that is clean.

Cloudflare in front of the box then did the same in the browser's HTTP cache: it
turns next dev's `no-cache` (and `max-age=0`) into the zone's 4-hour browser TTL.
On a box (`LIANKI_DEVBOX=1`) `next.config.mjs` sends `Cache-Control: no-store` on
every response, which Cloudflare leaves alone. A browser that cached chunks before
that keeps them until it revalidates: one hard reload (Cmd+Shift+R) clears them.

## Known limits

- **Server data is local.** The box's server knows the account (above), but
  server components that read D1 read the box's local D1.
  `authClient.useSession` is empty (nothing in the app uses it).
- **An owner's own box.** Bound to an account holding `dev`, admin routes stay
  closed, but on allowlisted routes `isDev` is true, so owner-only feature
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

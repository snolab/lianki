# Custom frontends

Anyone can run their **own frontend** for Lianki: their own dev server,
behind their own Cloudflare tunnel, viewed at `https://lianki.com/<path>?live=<id>`.
The page and its scripts come from their tunnel. `/api` and `/auth` always
stay on production, and they use their real account with their own
permissions. The core API is not touched.

Owner's direction: Slack, 2026-11-05 13:58 JST ("we should allow everyone
customize their frontend in future without harming our core api"). The
first user is kishouzet (frontend only). Later it will be everyone.

**Phase 1 (this):** behind the flag `live.custom-frontend` (the owner can use
it while it is off), for users on an allowlist the owner keeps at
`/dev/live-frontends`. Code: `lib/live-view/custom.ts` (rules, store, CSP,
cookie), the custom branch of `lib/live-view/page-proxy.ts` (in `worker.ts`,
before OpenNext), `app/api/live-previews/`, `app/api/dev/live-frontends/`,
`db/migrations/0042_live_previews.sql`. Tests: `unit/custom-frontend.test.ts`,
`scripts/qa/qa-api.mjs`. It is the owner's same-origin live preview
([live-view.md](live-view.md), "Same-origin pages") with stricter rules, and
it follows the shared spec: **no cookie is forwarded, and there is no session
bridge**.

## For the owner: turn it on

1. `/dev/flags`: turn on `live.custom-frontend`.
2. `/dev/live-frontends`: add the user by their sign-in email. Removing them
   later also stops all their previews at once. The same page lists every
   active preview, each with a **stop** button.

Every add, remove, registration and revoke is a row in `security_audit`
([security-measures.md](security-measures.md) §8). It needs
`LIVE_GATE_SECRET` on the Worker, which already exists: it keys the live
cookie's HMAC and is never sent anywhere.

## For a developer: start

```bash
# 1. your frontend (the starter below, or your own app) on a local port
bunx vite --config examples/custom-frontend-vite/vite.config.ts      # :5188
# 2. a quick tunnel to it (prints https://<words>.trycloudflare.com)
cloudflared tunnel --url http://localhost:5188
```

3. Sign in at https://lianki.com. In that tab's devtools console, register
   the tunnel (at most 8 h, at most 3 at once):

   ```js
   await fetch("/api/live-previews", {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({ target: "https://<words>.trycloudflare.com", hours: 8 }),
   }).then((r) => r.json());
   // → { id, target, expiresAt, url: "https://lianki.com/?live=<id>" }
   ```

4. Open the `url`. Any path works (`/words?live=<id>`). A red
   **LIVE · <tunnel host> · stop** badge sits bottom-left. Saves reach the
   page by hot reload.

**Stop:** tap **stop** (`?live=off`), or open any lianki.com page without
`?live`. To end the registration itself:
`fetch("/api/live-previews/<id>", {method: "DELETE", headers: {"content-type": "application/json"}})`
(from a normal lianki.com tab). `GET /api/live-previews` lists yours.

A new quick tunnel has a new host, so register again when you restart
`cloudflared`.

**A devbox** ([devbox/README.md](../devbox/README.md)) is a different way in:
the friend's whole checkout, on a local D1, at its own host
(`devbox-<name>.lianki.com`). To view a devbox's pages at lianki.com
`?live` against production's API, add its exact host to
`CUSTOM_FRONTEND_HOSTS` (`lib/live-view/custom.ts`, a reviewed change) once
its DNS record exists, and register `https://devbox-<name>.lianki.com`. Its
server-rendered pages still get no session there (see "Not available").

## How it works

```
browser ── lianki.com/words?live=<id> ──▶ Worker (worker.ts → page-proxy.ts)
                                           │ 1. GET /api/live-previews/<id>  (the app itself, with the viewer's Cookie only)
                                           │    → 200 only for the user who registered <id>
                                           │ 2. fetch https://<tunnel>/words  (no Cookie, no Authorization, no cf-*, no Referer)
           ◀── page + strict CSP + badge ──┘
browser ── lianki.com/_next/*, HMR ──────▶ Worker → tunnel   (live cookie, re-checked in D1)
browser ── lianki.com/api/* ─────────────▶ Worker → production (never the tunnel)
```

- **Only the registrant sees it.** A `?live=<id>` document is served from the
  tunnel only when the signed-in viewer is the user who registered `<id>`,
  the preview has not expired or been revoked, the flag is on (or the user is
  the owner), and the user is still on the allowlist. Anyone else, the owner
  included, signed out, or with a made-up id, gets the normal production page
  with the live cookie cleared. The response looks the same whether the id
  exists or not. This rule matters most: a link that showed someone else's code
  on lianki.com would be phishing or XSS with the victim's session.
- **The live cookie** `__Host-lk_live` (Secure, HttpOnly, SameSite=Lax,
  host-only) holds `c.<id>.<user>.<until>.<o>.<session tag>.<hmac>`. It is
  sealed with LIVE_GATE_SECRET under its own label, lasts at most 1 h idle
  and never past the preview, and is **bound to the session**: a hash of the
  session cookie it was set with. After signing out, or under another account
  on the same browser, it stops matching. Every subresource re-checks the
  preview in D1 (row, owner, expiry, revoke, allowlist, flag), cached 5 s per
  isolate, so a stop, a removal or the flag turned off ends it within 5 s.
- **What is proxied:** the `?live` document, `/_next/*` and `/__nextjs*`
  (scripts, the dev overlay), the HMR websocket, and the router's RSC
  fetches whose Referer still has `?live=<id>`. **Never** `/api`, `/auth`,
  `/_lk`, a POST, or a service worker script (403).
- **What goes up:** an allowlist of request headers (Accept,
  Accept-Language, User-Agent, Next's router headers, Sec-Fetch-Dest/Mode,
  conditional and range headers, the websocket handshake). Origin is set to
  the tunnel's. Never the viewer's Cookie, Authorization, `cf-*`,
  `x-forwarded-*` or Referer, and never the owner's gate secret. The URL is
  the tunnel's origin with only the path and query set. `//`, backslashes,
  `%2F`, `%5C`, `%00`, control characters and `@` (outside `/_next/`) are
  refused, and the result is asserted to still be that origin right before
  the fetch.
- **What comes down:** filtered (`lib/live-view/tunnel-headers.ts`: no
  Set-Cookie, Clear-Site-Data, CSP, CORS, HSTS or Service-Worker-Allowed, the
  same for the 101), `Cache-Control: no-store`, `x-lk-live: <id>`,
  `Referrer-Policy: same-origin`, and **our CSP** (`customCsp`):

  ```
  default-src 'self'; script-src 'self' <tunnel> 'unsafe-eval' 'nonce-<per response>';
  style-src 'self' 'unsafe-inline' <tunnel>; img-src 'self' data: blob: <tunnel>;
  font-src 'self' data: <tunnel>; connect-src 'self' wss://lianki.com <tunnel> wss://<tunnel host>;
  media-src 'self' data: blob:; worker-src 'self' blob:; manifest-src 'self'; frame-src 'self';
  object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'
  ```

  The Worker puts the nonce on every `<script>` of the proxied HTML (and the
  badge's), so a framework's inline bootstrap runs and an injected inline
  handler does not. `'unsafe-eval'` is there for dev builds (source maps,
  fast refresh). It does not widen where data can go.
- **Account-level writes are refused** while the custom live cookie is set
  (`customFrontendBlocked`, 403 from the Worker before the app runs):
  `POST /api/token`, `/api/cli-login/*`, `/api/live-previews*`,
  `/api/live-view`, anything but GET under `/api/dev*` and `/api/dev-access*`,
  and every better-auth write but `sign-out` (`/api/auth/update-user`,
  `link-social`, `delete-user`, `revoke-sessions`, passkeys, …). A token
  minted from a custom page would outlive the preview, and an account change
  is a takeover. Neither is needed to build a frontend.
- **Tunnel down or slow** (20 s for the document): the normal page, a small
  「预览不可用，这是正式版」 notice, and the cookie cleared.

**What CSP cannot stop:** a top-level navigation to another site with data
in its URL. Also, `connect-src 'self'` includes `/_next/*`, which goes to
the registrant's own tunnel. Both channels lead only to the registrant: it
is their own code, shown only to them. The CSP is defence in depth against a
dependency or a tunnel turning on its own user, not a sandbox.

## The contract (what a custom frontend can use)

**Auth: same-origin cookies.** The page is on lianki.com, so
`fetch("/api/…")` (`credentials: "same-origin"`, the default) sends the
user's own session cookie. There is no token to handle and no CORS. Signing
in happens on the normal lianki.com pages. If a request answers 401 or 404,
or a guest-shaped answer comes back, send the user to `/sign-in` without
`?live`.

**Writes:** `Content-Type: application/json`, same origin. Some routes check
`Origin` and `Sec-Fetch-Site: same-origin` (`sameOriginJson`); a normal
`fetch` from the page passes. Cross-site requests never carry the session
(SameSite=Lax). Every write acts on the signed-in user's own data, because
the server takes the user from the session, never from the body.

**Rate limits:** the server's own limits apply, the same as for our pages.
Examples: the AI routes (gloss, translate, TTS) per user, `/api/live-previews`
20 registrations an hour. A 429 carries `Retry-After`. Keep polling low;
prefer events.

**The public surface.** These are what Lianki's own words, review and reader
pages use. Shapes are the routes' own; for the reader they are typed in
`lib/read/reader-api.ts`.

| Area     | Endpoint                                           | Method       | What                                                                                              |
| -------- | -------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| words    | `/api/words/lists`                                 | GET / POST / PATCH | `{lists}`; create `{name, lang, source?, params?}`; reorder `{order}`                     |
| words    | `/api/words/lists/:id`                             | PATCH / DELETE | rename or set params, or remove                                                                 |
| words    | `/api/words/lists/:id/entries`                     | GET          | the list's entries                                                                                |
| words    | `/api/words/lists/:id/session`, `/api/words/session?lists=a,b&day=&limit=` | GET | due and new words (one list, or up to 90)                                          |
| words    | `/api/words/lists/:id/review`                      | POST         | `{day?, cursor?, reviews:[{term, rating 1–4, …}] ≤ 200}`                                          |
| words    | `/api/words/lists/:id/known`, `/undo`              | POST         | mark known `{terms[] ≤ 500}`; undo `{term, day?}`                                                 |
| words    | `/api/words/familiarity`                           | POST         | familiarity of terms                                                                              |
| words    | `/api/words/tts?lang=&…`                           | GET          | a word's audio                                                                                    |
| review   | `/api/fsrs/next-url`, `/api/fsrs/due`              | GET          | the next due card `{url, title}`; the due list                                                    |
| review   | `/api/fsrs/review/:rating?id\|url`                 | POST         | `{hlc?}` → `{ok, due, card, log, hlc, nextUrl, nextTitle}`; 409 on a conflict                     |
| review   | `/api/fsrs/add`, `/api/fsrs/notes`                 | POST / PATCH | add a card; edit its notes                                                                        |
| reader   | `/api/read?page&pageSize`                          | GET / POST   | your materials; create `{content, title?}`                                                        |
| reader   | `/api/read/:id`                                    | GET / PATCH / DELETE | one material                                                                              |
| reader   | `/api/read/:id/items`, `/words`, `/meanings`, `/familiarity`, `/due`, `/history` | GET | its sentences, words, cards                                          |
| reader   | `/api/read/:id/grade`, `/batch-grade`              | POST         | `GradeRequest` → `GradeResponse`                                                                  |
| reader   | `/api/read/:id/progress`                           | GET / PUT    | reading position                                                                                  |
| reader   | `/api/read/:id/notes`, `/notes/:noteId`            | GET / POST / PATCH / DELETE | notes                                                                              |
| reader   | `/api/read/:id/gloss`, `/translate`                | POST         | AI: a word's meaning, a translation (per-user limits)                                             |
| settings | `/api/prefs`                                       | GET / PUT    | synced settings ([prefs-sync.md](prefs-sync.md))                                                  |

Anything else under `/api` works the same way, with the same rules, but it
is internal: it may change without notice. The reader routes need the flag
`read.reader-v2` (or the owner), as for our own reader.

**Not available:**

- **Server-side session.** The dev server gets no cookie, so it renders every
  page signed out. With Next.js, server components, route handlers and
  server actions there see no user and have no D1 access. Load user data
  in the browser from `/api`. A Next app works best as client components
  (`"use client"`) behind a static shell. Server actions (`"use server"`) on
  a live page go to production, which does not know your build's action ids,
  so they fail.
- **Cookies, storage policy, workers.** A `Set-Cookie`, CSP, CORS, HSTS or
  `Clear-Site-Data` from your server is dropped. No service worker can be
  registered (403). The page shares localStorage and IndexedDB with
  lianki.com's own pages, because it is the same origin: prefix your keys,
  and do not delete ours.
- **The writes listed above** (tokens, account changes, `/api/dev`).
- **Other hosts.** Your page cannot fetch, post to or embed anything but
  lianki.com and your tunnel. Bundle your libraries; do not load them from a
  CDN.

## The starter (Vite, client only)

`examples/custom-frontend-vite/`: `vite.config.ts`, `index.html`,
`src/main.ts`. It lists your word lists from `/api/words/lists`. Two things
make it work behind lianki.com, and any other app needs the same two:

- **Everything under `/_next/`** (`base: "/_next/"`), since that is the one
  path lianki.com passes through to the tunnel. A small plugin answers every
  other path with the app's `index.html`, so `?live` works on any page.
- **HMR through lianki.com** (`hmr: { protocol: "wss", clientPort: 443 }`):
  the socket opens at `wss://lianki.com/_next/`, which lianki.com passes on.
  `allowedHosts: [".trycloudflare.com"]`, because the Worker fetches with
  the tunnel's Host.

```ts
// src/main.ts (abridged)
const r = await fetch("/api/words/lists"); // your session cookie goes with it
const { lists } = await r.json();
```

A **Next.js** app needs no `base`: its chunks are already under `/_next/`,
and its HMR socket is `/_next/webpack-hmr`. Run `next dev` and tunnel its
port. Keep pages client-side, as above.

## Long term

This is the strangler's first step: [framework-migration.md](framework-migration.md)
moves the app to a static frontend (Vite + React Router) over a Hono API.
Then every page loads its data from `/api` the way a custom frontend
does, so a custom frontend is simply another build of the same static
shell: same contract, no server-rendering gap. After that come a proper UI
for registering (instead of the console), named tunnels on a user's own
domain (`CUSTOM_FRONTEND_HOSTS`), and, before custom frontends can be
**shared** with other users, a separate origin with a scoped API token. A
shared frontend on lianki.com would run its author's code with the viewer's
session.

## API audit (2026-11-05)

Checked for this feature: can a custom frontend do only what its user could
do anyway? **Yes, for user data.** Every route takes the user from the
session (`wordsRepo()`, `readerCtx()`, the session's id or email), never
from the body. Prices, passes and top-ups are computed on the server.
Client-sent values (`reviewedAt`, `day`, `hlc`, card state in
`bulk-upsert`) change only the caller's own schedule. `/api/dev/*` checks
`isOwner` on the session.

**Fixed here:** JS on the origin could mint a long-lived API or CLI token,
or change the account through better-auth, and keep it after the preview.
Both are now refused under a custom live cookie (see above). It also could
have used the owner's `/api/dev` powers in the owner's session; those are
refused too.

**Flagged, not changed here.** They exist with or without custom
frontends, but a custom frontend makes scripting them easier:

| Severity | Route | Issue | Suggested fix |
| -------- | ----- | ----- | ------------- |
| medium-high | AI routes: `read/:id/gloss`, `translate`, `polish`, `/api/tts`, polyglot, self-intro, ai-sentences, `/api/translate` | Per-user limits are in-memory (`lib/rateLimit.ts`), one count per isolate; `chargeAi` (`lib/read/gloss-server.ts`) only logs | D1 `hit()` (`lib/security/throttle.ts`) plus a daily per-user budget before the model call |
| medium | `POST /api/roadmap/generate`, `POST /api/import/youtube` | No limit at all (LLM; YouTube quota) | D1 `hit()` per user |
| medium | `word_gloss` shared cache (`lib/read/gloss-server.ts`) | Keyed by (lang, term) and shared, but the prompt includes the client's `ex` sentence, so one user can poison a common word's gloss for everyone | Build the shared entry from the term alone, or keep per-user rows until confirmed |
| medium | `app/fsrs.ts`: `GET /add`, `GET /api/fsrs/review/:rating`, `GET /api/fsrs/delete`, `/repeat`, `/review*`, `/delete*` | Mutating GETs: Lax cookies go with a top-level cross-site navigation, so another site can link a user into a review or delete | POST only; GET only for the userscript with a token |
| medium | `POST /api/contact` | No auth, Turnstile or throttle; user text goes into Slack mrkdwn | Turnstile + D1 `hit()` per IP; escape `<>&` |
| low | `app/fsrs.ts` `/delete-confirm`, `GET /api/fsrs/` | Title and url go into HTML unescaped (self-XSS: notes are per user) | Escape, or retire the pages |
| low | `polyglot/save-cards`, `self-intro/save-cards`, `POST /api/read` content, `words/telemetry` | No size caps or throttle | zod caps + D1 `hit()` |
| low | `POST /api/gift-codes/redeem` | No throttle (8 characters from 31, impractical to brute-force) | D1 `hit()` per user |
| low | most `words/*` and `fsrs/*` POSTs | No Origin/content-type check; SameSite=Lax covers cross-site | `sameOriginJson` when touched |

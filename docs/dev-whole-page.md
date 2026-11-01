# Whole-page dev server (production D1, owner only, home LAN)

The whole app from a working tree, with fast refresh, against the **live
production D1** — for the owner's Android on the home LAN. Owner decision,
2026-10-31: see a change on his real data before it ships, without a copy that
drifts. Because it touches production, it is locked down hard. It runs only in
the ops lane (manual permission mode: the owner approves each command).

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3103        # tailnet only, never funnel
bun scripts/dev/whole-page.ts serve --host 192.168.31.96 --port 3100 \
  --origin https://taku.onca-tint.ts.net:8443                    # keep running
bun scripts/dev/whole-page.ts send-login --target Android        # sign his phone in
```

Run `serve` from tree/preview-serve (see below). Then his phone is on
`https://taku.onca-tint.ts.net:8443/words?list=all`, with
Tailscale on. Stop the front with `tailscale serve --https=8443 off`.

## Feature agents: getting a change onto his phone

The server runs from **tree/preview-serve**, and agents merge in **tree/preview**:

```bash
cd ~/ws/snolab/lianki/tree/preview && git merge <your-branch>   # branch preview/live, local only
bun scripts/dev/whole-page.ts publish                           # from any worktree
```

`publish` asks the server to fast-forward its worktree (branch `preview/serve`)
to `preview/live`, 3 s after the **last** publish (`Debouncer`,
`PUBLISH_QUIET_MS`). Several agents merging within seconds therefore become
one update, and one reload at most. On 2026-10-31 next dev served the merge
worktree directly, and four merges in three minutes, plus the ops lane's
restarts, kept his page reloading. Merge only when a change is ready (not per
commit), and never push `preview/live`.

When a publish brings `*.content.ts` or `intlayer.config.*` changes, the
server runs `bunx intlayer build` right after the fast-forward
(`needsIntlayerBuild`). next dev did not rebuild the dictionaries for content
that arrived by a merge, and the page threw until someone built them by hand.

What next dev does with an update: an edit inside a React component file is
a Fast Refresh, with no reload and state kept. An edit to a module that
non-components import (`lib/*`, content dictionaries, intlayer rebuilds, route
handlers, `next.config.mjs`) is a full page reload. A `next.config.mjs` change
or a guard (`scripts/dev/whole-page*.ts`) change needs a restart.

## What runs

| Piece                                      | Where                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Guard proxy (`scripts/dev/whole-page.ts`)  | `192.168.31.96:3100`. Only a private-LAN IPv4 is accepted, never `0.0.0.0`               |
| `next dev` (Turbopack, fast refresh)       | `127.0.0.1:3101`, loopback only, reachable only through the guard                        |
| Control port (one-time enter links)        | `127.0.0.1:3102`, loopback only                                                          |
| Bindings (`wrangler.dev-whole-page.jsonc`) | D1 `lianki` and R2 `lianki-blobs` with `remote: true` (wrangler's own login, not a copy) |

`next.config.mjs` passes that config to `initOpenNextCloudflareForDev` with
`remoteBindings: true` when `LIANKI_DEV_WHOLE_PAGE=1`. It also lists the LAN
host in `allowedDevOrigins`, because otherwise next dev refuses its dev assets
to that origin.

## His devices on the tailnet: let in by Tailscale identity

Owner decision, 2026-10-31 03:08 JST (typed "1同意"): his own devices need no
one-time link. `tailscale serve --https=8443` targets a **loopback** listener,
`127.0.0.1:3103`. That is the only listener where the guard believes the
`Tailscale-User-Login` header that tailscale serve adds.

- When that login is this Mac's own Tailscale user (`--tailscale-login`,
  default from `tailscale status`), a GET without a device cookie or session
  gets both, minted on the spot, and is redirected to the same URL.
- Any other login on the tailnet gets 403, as before.
- On the LAN listener (`192.168.31.96:3100`) a request carrying the header is
  refused as a forgery.
- The identity headers are stripped before anything is forwarded.

For his tailnet requests the guard needs no browser cookie at all. It keeps
one owner session of its own, minted once and re-minted if it lapses, and
adds it to the request on the way upstream. That is what lets the page work
inside a **lianki.com iframe** (the owner's overlay idea, 2026-10-31), where
iOS Safari blocks third-party cookies. Every response carries
`Content-Security-Policy: frame-ancestors 'self' https://lianki.com`, so no
other site can frame it.

`tailnetIdentity` in `whole-page-guard.ts` holds the rule. `send-login` still
works for a device that is not on the tailnet.

## Off the tailnet: preview.lianki.com (dev access tokens)

Owner request, 2026-11-01 02:55–03:02 JST: reach the dev server without
Tailscale, gated by an access token he mints himself, signed in
automatically, and switchable from the account menu. Tailscale `:8443`
works exactly as before; this is a second way in.

```
phone ─ https://preview.lianki.com ─▶ Cloudflare (rate rule on /_lk/*) ─▶ tunnel "lianki-preview"
      ─▶ cloudflared (oxmgr lianki-preview-tunnel, --token-file) ─▶ 127.0.0.1:3104  the gate
      ─▶ (valid dev token only) the guard adds his owner session ─▶ next dev 127.0.0.1:3101
gate ─ POST https://lianki.com/api/dev-access/verify (x-lianki-dev-bridge) ─▶ D1 dev_access_token
```

**Tokens** (`lib/dev-access.ts`, table `dev_access_token`): minted on
`lianki.com/dev/tokens` by the owner's session only (named, 1–90 days, at
most 20 live), shown **once**; D1 keeps only the SHA-256. Revoke one, or
"revoke all", on the same page. Each token signs in as the account that
minted it, which must be an owner, and the gate also requires it to be the
owner its login route mints (`OWNER_EMAILS[0]`): it can never sign in as
anyone else. Tokens are checked only by the gate, which proves itself with
`DEV_BRIDGE_SECRET`; without it `/api/dev-access/verify` answers 401, so a
token cannot be tested from anywhere else.

**The gate** (`scripts/dev/preview-gate.ts`, on the loopback listener
`port + 4` that only cloudflared targets):

- **503 for everything** without a valid token: pages, static files, auth
  routes, `/__dev/enter`, the hub paths.
- Only `Host: preview.lianki.com` is served; any other Host is 503. Trust
  comes from the listener, never from a header: a `Tailscale-User-Login`
  header on the tunnel is stripped and never believed, and the LAN and
  tailnet listeners ignore this hostname entirely.
- **Browsers**: `/_lk/dev-auth` takes the token once, in a form POST (the
  profile menu and the tokens page post it; a pasted link carries it after
  `#`, which no server sees, and the page strips it from the address bar
  before posting). A token in the query is refused unread (400). The
  answer is `303` with `Cache-Control: no-store`, `Referrer-Policy:
  no-referrer`, and a `__Host-lk_preview` cookie: HttpOnly, Secure,
  SameSite=Lax, host-only, holding a sealed session (HMAC with
  `previewKey` in `.dev-whole-page.json`), not the token.
- **Tools**: `Authorization: Bearer lkdev_…` (named tokens only; a handoff
  is refused). Stripped before anything goes upstream.
- **Sessions** last 12 h at most and never past their token. The gate
  re-checks a session's token id with lianki.com at most 30 s apart, so
  **revoking the token ends its sessions** within 30 s; lianki.com
  unreachable means closed, not open.
- **Upgraded sockets** (HMR, the hub's chat on `/api/version/*`) are gated
  at the upgrade and then **watched** (`SocketWatch`): each is registered
  with its token id and session end, one timer per token id re-checks it
  every 30 s (no extra polling: the same cadence), and a revoked token, a
  failed re-check or an ended session closes every socket of that token.
  A one-shot timer per token at the earliest session end among its sockets
  closes those at that moment (not at the next 30 s tick), then re-arms.
  Both timers stop with the token's last socket.
- **Where a handshake lands** (`next`): only a path on this origin. Any
  control character (TAB, LF, CR, NUL, DEL) or backslash is refused, since
  browsers drop the first three and read `\` as `/` (`/%09/evil.example`
  would otherwise leave the site); what is left must parse to this origin
  with a single leading `/`. Otherwise `/__dev/landing`.
- **Auto sign-in**: past the gate, the guard adds his owner session
  server-side, as for his tailnet devices. The browser never holds a
  better-auth cookie of its own here (incoming ones are dropped, outgoing
  `Set-Cookie`s for it are stripped), so the token is the only key.
  Sign-out on the tunnel ends the tunnel session only.
- **Limits**: 10 failed tokens per IP per 10 minutes → 429, and attempts
  still in flight count towards it. No global lockout: one would let anyone
  with a few IPs lock the owner out without a token. Token checks go through
  a bounded queue (`VerifyQueue`): 4 in flight, at most 32 waiting behind them (36 in all)
  and 2 per IP (waiting + running); past that the answer is at once (429
  for the IP, 503 busy). A waiter has 5 s, then 503, and is dropped the
  moment its client disconnects; its IP's admission is checked again when
  its turn comes. A token verified in the last 30 s, and every signed-in
  session, skip the queue entirely, so a flood never stalls the owner.
- **Edge rule**: Cloudflare's shared rate rule counts `/_lk/*` on this host
  (`scripts/ops/tunnel-rate-rule.ts`), not the whole host, on purpose. The
  Free plan has one rule, shared with the STT tunnel at 10 per 10 s per IP;
  a dev page load is a hundred-odd requests (Next's dev chunks, HMR), so the
  whole host under that rule would block the owner's own pages. The gate's
  limits above cover `/` and everything else.
- Upstream, Host/Origin/Referer become the dev server's own origin; the
  gate cookie, `Authorization`, `cf-*`, `x-forwarded-*`, Tailscale and the
  guard's secret headers are removed.

**On his iPhone**: on lianki.com, the account menu's "Dev server (production
data)" item does it all (next section). For a device without a lianki.com
session: `/dev/tokens` → new token → "copy the link for another device",
open that link once in Safari there; the cookie lasts up to 12 h, after which
the link (or a new one) is opened again. In the home-screen app, use the
menu item: its cookies are its own.

**Turning it on** (ops lane, after this is on `main` and deployed):

```bash
# once: an API token (below) at ~/.config/lianki/cf-api-token, mode 0600
bun scripts/dev/whole-page.ts serve … --public-host preview.lianki.com   # adds the gate on :3104
scripts/dev/preview-tunnel.sh up       # tunnel + ingress + DNS + rate rule (API), connector under oxmgr
scripts/dev/preview-tunnel.sh status   # gate 503 locally and through https://preview.lianki.com
```

`up` refuses unless the gate already answers 503 on `127.0.0.1:3104`, with its own `x-lianki-gate` marker on `/_lk/up`, so the
tunnel can only ever reach the gate. The tunnel is remotely managed and made
through the API (`scripts/ops/cf-tunnel.ts`): no `cloudflared tunnel login`,
no cert.pem, no credentials JSON. Its run token is written to
`~/.config/lianki/preview-tunnel-token` (0600, replaced, never written
through a symlink) and passed with `--token-file`, never on a command line;
`check-secret` refuses it if it is a symlink, not his, or not 0600. The
ingress is `preview.lianki.com → http://127.0.0.1:3104` and `http_status:404`
for anything else.

The API token needs, on the lianki.com account and zone: **Account ·
Cloudflare Tunnel · Edit, Zone · DNS · Edit, Zone · Zone WAF · Edit, Zone ·
Zone · Read**. Wrangler's login on the Mac reaches the tunnel API but has no
DNS or WAF edit (checked 2026-11-01), so it does not cover this.

**Without the API token, cert.pem** (the fallback, 2026-11-01): when
`cloudflared tunnel login` has left `~/.cloudflared/cert.pem` and there is
no API token, `up` makes a **locally managed** tunnel instead: `cloudflared
tunnel create lianki-preview` (credentials JSON, 0600, checked),
`~/.cloudflared/lianki-preview.yml` (0600) with the same ingress (gate
only, 404 for the rest), `cloudflared tunnel route dns`, and the connector
with `--config`. Two things still need the API token: the **rate-limit
rule** (not applied; the gate's own per-IP limits and queue apply
meanwhile), and **deleting the DNS record** on `down` (cloudflared cannot;
with the tunnel deleted the record reaches nothing, 1033, and `down` exits
1 saying so). Once the token exists, `down` removes the cert-made tunnel and
the record through the API, and `up` makes the remotely managed one (it
refuses while a locally managed tunnel of that name exists, so run `down`
first).

**Rollback**: `scripts/dev/preview-tunnel.sh down` stops the connector,
deletes the tunnel (its connections first) and its DNS record through the
API, and removes the token file. The shared rate rule stays (the STT tunnel
uses it). Restart `serve` without `--public-host` to close the loopback
gate too. Revoke-all on `/dev/tokens` ends every session at once.

## The profile menu switch

For the owner only, decided on the server (`devSwitchFor`,
`lib/dev-server-switch.server.ts`: anyone else's page carries none of it):

- On lianki.com the account menu shows **"Dev server (production data)"**.
  When the menu opens it checks once, with one fetch to
  `https://preview.lianki.com/_lk/up` (1.5 s timeout; the gate answers 503
  with an `x-lianki-gate` marker, readable by lianki.com only): green and
  tappable when up, grey "Dev server is off" when not. No polling, no timer.
  (A push from `serve` through the hub would also work, but needs hub
  changes; the open-time check is the owner's allowed alternative.)
- Tapping it mints a **single-use handoff**, 60 s (`POST /api/dev/dev-handoff`),
  and posts it to `/_lk/dev-auth` in a form body with the current path and
  query: never in a URL. The dev server opens on the same page, signed in.
- On the dev server the same spot reads **"Back to lianki.com"**: a plain
  link to the same path and query on production. Every dev-server page shows
  a **"Dev server · production data"** badge in its top bar.
- Strings: `app/components/dev-switch.content.ts`, 16 locales, each key with
  its context line.

Tests: `unit/dev-access.test.ts`, `unit/preview-gate.test.ts`,
`unit/cf-tunnel.test.ts`, `unit/preview-tunnel.test.ts`,
`unit/dev-server-switch.test.ts`; `qa:api` checks non-owners get 404 from the
token routes and the verify route 401 without the bridge.

## The locks (all of them, in order)

Rules: `scripts/dev/whole-page-guard.ts`. Tests: `unit/whole-page-guard.test.ts`.

1. **Network.** The guard is the only listener on the LAN IP. No funnel. The
   one public route is the token-gated tunnel (next section), and only when
   `serve` runs with `--public-host`.
2. **Device.** Every request needs the `lk_dev_device` cookie, an HMAC of a
   local secret, with HttpOnly and a lifetime of one year. Without it the
   answer is 403, static files included. The cookie is set only by a
   **one-time enter link** (`/__dev/enter?t=…`), and each link works once
   for 10 minutes. Links are issued on the loopback control port and kept
   only as hashes.
3. **Auth API cut down.** Only `/api/auth/get-session` and
   `/api/auth/sign-out` are served. Every sign-in, sign-up, OTP, magic-link,
   OAuth and passkey endpoint returns 403, so no account or credential can
   be created in production through this origin.
4. **Owner.** Every page and app API must carry a session whose email is in
   `OWNER_EMAILS` (read from `wrangler.jsonc`, the list production uses).
   Anything else gets 403, so only the owner's data is readable and writes
   only touch his account. The result is cached for 60 s per cookie header.
5. **Sign-in.** The enter link's second half: the guard calls
   `POST /api/dev-whole-page/login` with a secret header (stripped from all
   incoming requests). That route makes a better-auth session for the owner
   and nobody else. It returns 404 unless `LIANKI_DEV_WHOLE_PAGE=1`,
   `NODE_ENV=development` and the 32+ character guard secret all match
   (`lib/dev-whole-page.ts`), so it is inert in production.

## No side effects

`next dev` is started with a **clean env**: `PATH`, `HOME`, `TERM` and the
dev server's own variables only. Concretely:

- No `RESEND_API_KEY`/`EMAIL_FROM`, so no mail, and the email sign-in plugins
  are not even loaded.
- No `STRIPE_*`, so no payments.
- No OAuth secrets and no `MONGODB_URI`.
- `CF_BUILD=1` aliases `mongodb` to its throwing stub, as in the Worker, so
  MongoDB can never be reached.
- The bindings have no `lianki-push` service (no build announcements), no
  tail consumer and no crons.

`serve` refuses to start if a `.env`, `.env.local`, `.env.development` or
`.env.development.local` exists, because Next would load it.

Secrets (`AUTH_SECRET` for the local cookie signature, the device secret and
the guard secret) are generated once into `.dev-whole-page.json`, which is
gitignored and has mode 0600. Delete that file to unpair every device and
invalidate every dev session cookie.

## Signing in

`send-login` asks the control port for a link and pipes
`location.assign(link)` into `scripts/dev/eval.ts --no-pair --target Android -`,
so his debug-mode tab navigates itself. **The token never appears** on a command
line, in stdout, in logs, in chat or in Slack. It needs an existing eval grant
and never pairs; with no grant it fails. The guard logs only
`enter: device paired, owner signed in` or `enter: refused`.

Sign-out (from the app) ends the session; the next page is 403 until a new
link.

## HTTPS (required): Tailscale serve

Plain `http://192.168.31.96:3100` signs in fine, since better-auth sets
non-`Secure` cookies for an http base URL. But the app then crashes:
`http://<LAN IP>` is not a secure context, so the browser has no
`crypto.randomUUID`, no service worker, no mic and no passkeys. The owner saw
a Next.js error page there on 2026-10-31, and the log showed
`[browser] Uncaught TypeError: crypto.randomUUID is not a function`.

So the phone uses `tailscale serve` on its own HTTPS port (`:8443`). The
lab site keeps `:443` and its path routes, and Next needs the root path. That
port is reachable on the tailnet only, never through `funnel`. `--origin` makes it the base
URL: cookies become `Secure` (`__Secure-better-auth.session_token`), and the
LAN IP stays the guard's only listener. `lib/dev-whole-page.ts` trusts an
`https://*.ts.net` origin only while the launcher runs.

## The chat widget on the dev origin

Storage is per origin, so the enter link carries his `lk:debug`, `lk:agent`
and `lk:pref` keys from the lianki.com tab. They travel in the URL fragment,
which never reaches a server, and `/__dev/landing` writes them before going on
to `/words?list=all`.

The widget's hub (lianki-push, `/api/version/*`) lives on lianki.com, so the
guard forwards those paths there. That happens only after the device and owner
checks, with `Origin: https://lianki.com`.

lianki.com cannot read this origin's session cookie, because it is signed
with a local secret. So the guard drops the cookie and sends
`x-lianki-dev-bridge: DEV_BRIDGE_SECRET` instead. The main Worker answers that
with the owner and nobody else (`lib/dev-bridge.ts`, docs/secrets-and-auth.md,
"Dev bridge"). The secret's local copy is `bridgeSecret` in
`.dev-whole-page.json`. Chat history comes from the hub as on lianki.com, and
eval reaches the page like any other debug page of his.

## Build announcements and speech-to-text

- **No "New version" banner.** `/api/version/ws` carries lianki.com's build
  announcements, and the dev build's id never matches them, so the banner
  came back after every refresh. The guard refuses that socket, and the
  page's version check gives up after a fast failure.
- **Speech-to-text uses his local SenseVoice.** The server's clean env has no
  Workers AI credentials, so cloud STT (`/api/debug/stt`) answers 502 here.
  The widget streams to his Mac instead (docs/local-stt.md):
  `localStorage["lk:debug-local-stt"] = "wss://taku.onca-tint.ts.net/lianki-stt"`
  on the dev origin, set once through eval. The enter link carries the key
  too when his lianki.com tab has it. The STT server must allow the dev
  origin, which has a port: oxmgr's `lianki-stt` runs `server.py … --origin
https://taku.onca-tint.ts.net --origin https://taku.onca-tint.ts.net:8443`.
  Without the second `--origin` the handshake is refused (403 in
  `oxmgr logs lianki-stt`), and the page falls back to cloud STT, which
  returns 502.

## Preview servers (widget, islands) on the dev origin

The owner's local preview servers sit on the lab site,
`https://<mac>.ts.net/lianki-*`, and answer CORS for lianki.com only
(`allowOrigin` in `scripts/dev/debug-widget-build.ts`). A page on `:8443`
could not read them, and the state tree said "Could not load the tree". The
guard therefore serves `/lianki-*` on the dev origin, owner-checked, by
fetching from the lab site server-side. Same origin means no CORS, and no
preview server needs a restart.

The landing page re-points carried `https://<mac>.ts.net/lianki-…` values,
such as `lk:debug-widget-src`, to `https://<mac>.ts.net:8443/lianki-…`.
`--lab` overrides the lab origin; the default is the `--origin` host without
its port. `lianki-stt` is a websocket and stays direct, because it allows
`:8443` itself (see above).

## Checked on 2026-10-31

| Probe                                                                         | Result                       |
| ----------------------------------------------------------------------------- | ---------------------------- |
| `/words`, `/_next/static/…`, `/api/auth/get-session` without device           | 403                          |
| `/__dev/enter?t=bogus`, and a link used twice                                 | 403                          |
| `POST /api/dev-whole-page/login` without the secret                           | 404                          |
| `POST /api/auth/sign-in/email` with device + owner session                    | 403                          |
| Ports 3101/3102 from the LAN IP                                               | refused                      |
| Enter link → `/words?list=all`, `get-session` email, `/api/words/lists`       | 302 → 200, owner, 9 lists    |
| After sign-out                                                                | 403                          |
| Same flow via `https://…ts.net:8443`: cookies `Secure`, phone `/words`, clips | 302 → 200, no browser errors |

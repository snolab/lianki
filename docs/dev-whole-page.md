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

`tailnetIdentity` in `whole-page-guard.ts` holds the rule. `send-login` still
works for a device that is not on the tailnet.

## The locks (all of them, in order)

Rules: `scripts/dev/whole-page-guard.ts`. Tests: `unit/whole-page-guard.test.ts`.

1. **Network.** The guard is the only listener on the LAN IP. There is no
   tunnel, no funnel and no public route.
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

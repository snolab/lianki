# Whole-page dev server (production D1, owner only, home LAN)

The whole app from a working tree, with fast refresh, against the **live
production D1** — for the owner's Android on the home LAN. Owner decision,
2026-10-31: see a change on his real data before it ships, without a copy that
drifts. Because it touches production, it is locked down hard. It runs only in
the ops lane (manual permission mode: the owner approves each command).

```bash
bun scripts/dev/whole-page.ts serve --host 192.168.31.96 --port 3100   # keep running
bun scripts/dev/whole-page.ts send-login --target Android              # sign his phone in
```

Then his phone is on `http://192.168.31.96:3100/words?list=all`.

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

## Fallback: Tailscale HTTPS

Plain http on the LAN works: better-auth sets non-`Secure` cookies when its
base URL is http, and verified 2026-10-31, the phone signed in and loaded
`/words?list=all`. If a browser change ever breaks that, put the guard behind
`tailscale serve` (tailnet only, never `funnel`) and set
`BETTER_AUTH_BASE_URL` to the `https://…ts.net` origin. His Android must then
have Tailscale on.

## Checked on 2026-10-31

| Probe                                                                   | Result                    |
| ----------------------------------------------------------------------- | ------------------------- |
| `/words`, `/_next/static/…`, `/api/auth/get-session` without device     | 403                       |
| `/__dev/enter?t=bogus`, and a link used twice                           | 403                       |
| `POST /api/dev-whole-page/login` without the secret                     | 404                       |
| `POST /api/auth/sign-in/email` with device + owner session              | 403                       |
| Ports 3101/3102 from the LAN IP                                         | refused                   |
| Enter link → `/words?list=all`, `get-session` email, `/api/words/lists` | 302 → 200, owner, 9 lists |
| After sign-out                                                          | 403                       |
